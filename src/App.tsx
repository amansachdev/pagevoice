import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { getDocument, GlobalWorkerOptions, TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

GlobalWorkerOptions.workerSrc = workerUrl;

type TextItem = { str: string; hasEOL?: boolean };
type Sentence = { text: string; start: number; end: number };
type PageData = { text: string; sentences: Sentence[]; itemRanges: Array<[number, number]> };
type Voice = { id: string; label: string };
type PlayerState = "idle" | "playing" | "paused" | "error";
const DEFAULT_VOICE = "af_heart";
const SPEED_MIN = 0.75;
const SPEED_MAX = 2;

function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  const matcher = /[^.!?]+(?:[.!?]+|$)|[.!?]+/gu;
  for (const match of text.matchAll(matcher)) {
    const raw = match[0];
    const start = match.index ?? 0;
    const leading = raw.search(/\S/u);
    if (leading < 0) continue;
    const trimmed = raw.trim();
    if (trimmed) sentences.push({ text: trimmed, start: start + leading, end: start + raw.trimEnd().length });
  }
  return sentences;
}

function makePageData(content: { items: unknown[] }): PageData {
  const items = content.items.filter(
    (item): item is TextItem => Boolean(item && typeof item === "object" && "str" in item),
  );
  let text = "";
  const itemRanges: Array<[number, number]> = [];
  items.forEach((item, index) => {
    const start = text.length;
    text += item.str;
    itemRanges.push([start, text.length]);
    if (index < items.length - 1) text += item.hasEOL ? "\n" : " ";
  });
  return { text, sentences: splitSentences(text), itemRanges };
}

function safeSpeed(value: number) {
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, value));
}

async function fingerprint(file: File) {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function App() {
  const [pdf, setPdf] = useState<any>(null);
  const [fileName, setFileName] = useState("");
  const [documentId, setDocumentId] = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [active, setActive] = useState<{ page: number; sentence: number } | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [message, setMessage] = useState("");
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [modelLoaded, setModelLoaded] = useState(false);
  const [modelLoading, setModelLoading] = useState(false);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState(DEFAULT_VOICE);
  const [speed, setSpeed] = useState(1);
  const voiceRef = useRef(voice);
  const speedRef = useRef(speed);
  voiceRef.current = voice;
  speedRef.current = speed;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageContainerRef = useRef<HTMLDivElement>(null);
  const pageCache = useRef(new Map<number, PageData>());
  const itemSpans = useRef<HTMLSpanElement[]>([]);
  const runId = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioResolveRef = useRef<(() => void) | null>(null);
  const pausedRef = useRef(false);
  const resumePauseRef = useRef<(() => void) | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const pageCount = pdf?.numPages ?? 0;
  const currentPageData = pageCache.current.get(pageNumber);
  const currentSentence = active?.page === pageNumber ? currentPageData?.sentences[active.sentence] : null;
  const progressKey = documentId ? "pagevoice-progress:" + documentId : "";

  const getPageData = useCallback(async (page: number): Promise<PageData> => {
    const cached = pageCache.current.get(page);
    if (cached) return cached;
    const pageProxy = await pdf.getPage(page);
    const data = makePageData(await pageProxy.getTextContent());
    pageCache.current.set(page, data);
    return data;
  }, [pdf]);

  const highlightSpans = useCallback((activePage: number, sentenceIndex: number) => {
    const layer = textLayerRef.current;
    const data = pageCache.current.get(activePage);
    if (!layer || !data) return;
    const sentence = data.sentences[sentenceIndex];
    const matchingSpans = itemSpans.current.filter((span, itemIndex) => {
      const range = data.itemRanges[itemIndex];
      const matches = Boolean(sentence && range && range[0] < sentence.end && range[1] > sentence.start);
      span.classList.toggle("spoken-sentence", matches);
      return matches;
    });
    matchingSpans[0]?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;
    let textLayerTask: { cancel: () => void } | null = null;
    async function renderPage() {
      if (!pdf || !canvasRef.current || !textLayerRef.current || !pageContainerRef.current) return;
      try {
        const pageProxy = await pdf.getPage(pageNumber);
        const container = pageContainerRef.current;
        container.scrollTop = 0;
        const baseViewport = pageProxy.getViewport({ scale: 1 });
        const availableWidth = Math.max(320, container.clientWidth - 24);
        const scale = Math.min(1.8, availableWidth / baseViewport.width);
        const viewport = pageProxy.getViewport({ scale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("This browser could not create a PDF canvas.");
        const pixelRatio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * pixelRatio);
        canvas.height = Math.floor(viewport.height * pixelRatio);
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        const layer = textLayerRef.current;
        layer.replaceChildren();
        layer.style.width = viewport.width + "px";
        layer.style.height = viewport.height + "px";
        renderTask = pageProxy.render({
          canvasContext: context,
          viewport,
          transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        });
        await renderTask.promise;
        if (cancelled) return;
        const content = await pageProxy.getTextContent();
        pageCache.current.set(pageNumber, makePageData(content));
        textLayerTask = new TextLayer({ textContentSource: content, container: layer, viewport });
        await textLayerTask.render();
        if (cancelled) return;
        const textItemCount = content.items.filter((item: unknown) => item && typeof item === "object" && "str" in item).length;
        itemSpans.current = Array.from(layer.querySelectorAll<HTMLSpanElement>("span")).slice(0, textItemCount);
        setPageInput(String(pageNumber));
        const currentActive = activeRef.current;
        if (currentActive?.page === pageNumber) highlightSpans(currentActive.page, currentActive.sentence);
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : "Could not render this PDF page.");
      }
    }
    void renderPage();
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayerTask?.cancel();
    };
  }, [pdf, pageNumber, highlightSpans]);

  useEffect(() => {
    if (active?.page === pageNumber) highlightSpans(active.page, active.sentence);
  }, [active, pageNumber, highlightSpans]);

  useEffect(() => {
    let alive = true;
    const checkStatus = () => {
      fetch("/api/status")
        .then((response) => response.json())
        .then((data) => {
          if (alive) {
            setModelReady(Boolean(data.online));
            setModelLoaded(Boolean(data.ready));
          }
        })
        .catch(() => alive && setModelReady(false));
    };
    checkStatus();
    const timer = window.setInterval(checkStatus, 3000);
    fetch("/api/voices")
      .then((response) => response.json())
      .then((data) => alive && setVoices(data.voices ?? []))
      .catch(() => alive && setVoices([]));
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!progressKey) return;
    localStorage.setItem(
      progressKey,
      JSON.stringify({ page: active?.page ?? pageNumber, sentence: active?.sentence ?? 0 }),
    );
  }, [progressKey, pageNumber, active]);

  const stopCurrentAudio = useCallback(() => {
    const finishAudio = audioResolveRef.current;
    audioResolveRef.current = null;
    finishAudio?.();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const stopPlayback = useCallback(() => {
    runId.current += 1;
    pausedRef.current = false;
    resumePauseRef.current?.();
    resumePauseRef.current = null;
    stopCurrentAudio();
    setPlayerState("idle");
  }, [stopCurrentAudio]);

  useEffect(() => () => {
    runId.current += 1;
    stopCurrentAudio();
  }, [stopCurrentAudio]);

  async function loadFile(file: File) {
    stopPlayback();
    if (pdf) void pdf.destroy();
    setPdf(null);
    setMessage("");
    pageCache.current.clear();
    setActive(null);
    try {
      const [id, bytes] = await Promise.all([fingerprint(file), file.arrayBuffer()]);
      const document = await getDocument({ data: new Uint8Array(bytes) }).promise;
      const savedProgress = localStorage.getItem("pagevoice-progress:" + id);
      let restoredPage = 1;
      let restoredSentence = 0;
      if (savedProgress) {
        try {
          const parsed = JSON.parse(savedProgress) as { page?: number; sentence?: number };
          if (typeof parsed.page === "number" && parsed.page >= 1 && parsed.page <= document.numPages) restoredPage = parsed.page;
          if (typeof parsed.sentence === "number" && parsed.sentence >= 0) restoredSentence = parsed.sentence;
        } catch {
          localStorage.removeItem("pagevoice-progress:" + id);
        }
      }
      setPdf(document);
      setFileName(file.name);
      setDocumentId(id);
      setPageNumber(restoredPage);
      setPageInput(String(restoredPage));
      setActive(restoredSentence ? { page: restoredPage, sentence: restoredSentence } : null);
      setPlayerState("idle");
    } catch (error) {
      setPdf(null);
      setFileName("");
      setMessage(error instanceof Error ? error.message : "Could not open this PDF.");
    }
  }

  async function synthesize(text: string) {
    if (!modelLoaded) setModelLoading(true);
    try {
      const response = await fetch("/api/synthesize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice: voiceRef.current, speed: speedRef.current }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.detail ?? "Speech generation failed. Check that the local voice service is running.");
      }
      setModelLoaded(true);
      return await response.blob();
    } finally {
      setModelLoading(false);
    }
  }

  async function playFrom(startPage: number, startSentence: number) {
    if (!pdf) return;
    stopCurrentAudio();
    pausedRef.current = false;
    resumePauseRef.current = null;
    const thisRun = ++runId.current;
    setPlayerState("playing");
    setMessage("");
    try {
      for (let page = startPage; page <= pdf.numPages; page += 1) {
        const data = await getPageData(page);
        if (thisRun !== runId.current) return;
        setPageNumber(page);
        const firstSentence = page === startPage
          ? Math.min(Math.max(0, startSentence), Math.max(0, data.sentences.length - 1))
          : 0;
        if (!data.sentences.length) {
          if (page === startPage) setMessage("No selectable text on PDF page " + page + ". Scanned pages are not supported yet.");
          continue;
        }
        let nextAudio: Promise<Blob> | null = null;
        for (let index = firstSentence; index < data.sentences.length; index += 1) {
          if (thisRun !== runId.current) return;
          const sentence = data.sentences[index];
          setActive({ page, sentence: index });
          highlightSpans(page, index);
          const audioBlob = nextAudio ?? synthesize(sentence.text);
          const upcoming = index + 1 < data.sentences.length ? synthesize(data.sentences[index + 1].text) : null;
          const blob = await audioBlob;
          if (thisRun !== runId.current) return;
          if (pausedRef.current) {
            await new Promise<void>((resolve) => { resumePauseRef.current = resolve; });
          }
          if (thisRun !== runId.current) return;
          const objectUrl = URL.createObjectURL(blob);
          audioUrlRef.current = objectUrl;
          const audio = new Audio(objectUrl);
          audioRef.current = audio;
          await new Promise<void>((resolve, reject) => {
            const finish = () => {
              audioResolveRef.current = null;
              resolve();
            };
            audioResolveRef.current = finish;
            audio.onended = finish;
            audio.onerror = () => {
              audioResolveRef.current = null;
              reject(new Error("Audio playback failed."));
            };
            void audio.play().catch(reject);
          });
          if (audioUrlRef.current === objectUrl) {
            URL.revokeObjectURL(objectUrl);
            audioUrlRef.current = null;
          }
          audioRef.current = null;
          nextAudio = upcoming;
        }
        startSentence = 0;
      }
      if (thisRun === runId.current) setPlayerState("idle");
    } catch (error) {
      if (thisRun === runId.current) {
        stopCurrentAudio();
        setPlayerState("error");
        setMessage(error instanceof Error ? error.message : "Speech playback stopped.");
      }
    }
  }

  function togglePlayback() {
    if (playerState === "playing") {
      pausedRef.current = true;
      audioRef.current?.pause();
      setPlayerState("paused");
      return;
    }
    if (playerState === "paused") {
      pausedRef.current = false;
      resumePauseRef.current?.();
      resumePauseRef.current = null;
      if (audioRef.current) void audioRef.current.play().then(() => setPlayerState("playing"));
      else setPlayerState("playing");
      return;
    }
    const target = active?.page === pageNumber ? active : { page: pageNumber, sentence: 0 };
    void playFrom(target.page, target.sentence);
  }

  async function skipBy(amount: number) {
    if (!pdf) return;
    const targetPage = active?.page ?? pageNumber;
    const targetIndex = active?.sentence ?? 0;
    const data = await getPageData(targetPage);
    let nextPage = targetPage;
    let nextIndex = targetIndex + amount;
    if (nextIndex < 0 && targetPage > 1) {
      nextPage -= 1;
      nextIndex = (await getPageData(nextPage)).sentences.length - 1;
    } else if (nextIndex >= data.sentences.length && targetPage < pdf.numPages) {
      nextPage += 1;
      nextIndex = 0;
    }
    void playFrom(nextPage, Math.max(0, nextIndex));
  }

  function goToPage() {
    const requested = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(requested) || requested < 1 || requested > pageCount) {
      setPageInput(String(pageNumber));
      return;
    }
    stopPlayback();
    setPageNumber(requested);
    setActive(null);
  }

  function startFromClickedText(event: MouseEvent<HTMLDivElement>) {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const span = target.closest("span");
    if (!span || !textLayerRef.current?.contains(span)) return;
    const itemIndex = itemSpans.current.indexOf(span as HTMLSpanElement);
    const data = pageCache.current.get(pageNumber);
    const range = data?.itemRanges[itemIndex];
    if (!data || !range) return;
    const sentenceIndex = data.sentences.findIndex((sentence) => range[0] < sentence.end && range[1] > sentence.start);
    if (sentenceIndex >= 0) void playFrom(pageNumber, sentenceIndex);
  }

  const statusText = useMemo(() => {
    if (modelReady === null) return "Checking local voice engine…";
    if (!modelReady) return "Local voice engine is not running";
    if (modelLoading) return "Loading local voice model…";
    return modelLoaded ? "Voice engine ready" : "Voice model loads on first play";
  }, [modelReady, modelLoaded, modelLoading]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Pagevoice home">
          <span className="brand-mark">p</span><span>pagevoice</span>
        </a>
        <div className="topbar-actions">
          <span className={"engine-status " + (modelReady ? "ready" : "")}><span className="status-dot" />{statusText}</span>
          <button className="open-button" onClick={() => fileInputRef.current?.click()}><span aria-hidden="true">＋</span> Open PDF</button>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void loadFile(file);
              event.target.value = "";
            }} />
        </div>
      </header>

      {!pdf ? (
        <section className="welcome">
          <div className="welcome-orb" aria-hidden="true"><span>♫</span></div>
          <p className="eyebrow">YOUR BOOK, READ ALOUD</p>
          <h1>Give your eyes<br />a little break.</h1>
          <p className="welcome-copy">Open a text-based PDF and listen from any page or sentence. Your book stays on this Mac.</p>
          <button className="primary-button" onClick={() => fileInputRef.current?.click()}>Choose a PDF <span>→</span></button>
          <p className="privacy-note"><span>●</span> Local playback · No account · No cloud upload</p>
          {message && <p className="message error-message">{message}</p>}
        </section>
      ) : (
        <section className="reader">
          <div className="reader-heading">
            <div className="book-info">
              <div className="book-icon">▤</div>
              <div><p className="eyebrow">NOW READING</p><h1 title={fileName}>{fileName}</h1></div>
            </div>
            <div className="page-jump">
              <label htmlFor="page-number">Page</label>
              <input id="page-number" value={pageInput} inputMode="numeric"
                onChange={(event) => setPageInput(event.target.value.replace(/\D/g, ""))}
                onKeyDown={(event) => event.key === "Enter" && goToPage()} onBlur={goToPage}
                aria-label="PDF page number" />
              <span>of {pageCount}</span>
              <button aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => { stopPlayback(); setPageNumber((page) => Math.max(1, page - 1)); }}>‹</button>
              <button aria-label="Next page" disabled={pageNumber >= pageCount} onClick={() => { stopPlayback(); setPageNumber((page) => Math.min(pageCount, page + 1)); }}>›</button>
            </div>
          </div>
          <div className="document-stage" ref={pageContainerRef}>
            <div className="pdf-page">
              <canvas ref={canvasRef} />
              <div ref={textLayerRef} className="textLayer" onClick={startFromClickedText} />
            </div>
          </div>
          <div className="message-slot">
            {message && <p className={"message " + (playerState === "error" ? "error-message" : "")}>{message}</p>}
            {!message && currentSentence && playerState === "playing" && <p className="now-speaking">“{currentSentence.text}”</p>}
          </div>
          <footer className="player">
            <div className="player-book">
              <span className="mini-book">▤</span>
              <div><strong>{fileName}</strong><span>{active ? "Page " + active.page + " · Sentence " + (active.sentence + 1) : "Page " + pageNumber + " · Ready to listen"}</span></div>
            </div>
            <div className="transport">
              <button className="skip-button" aria-label="Previous sentence" onClick={() => void skipBy(-1)} disabled={!pdf}>↶<small>1</small></button>
              <button className="play-button" aria-label={playerState === "playing" ? "Pause" : "Play"} onClick={togglePlayback}>
                {playerState === "playing" ? "Ⅱ" : "▶"}
              </button>
              <button className="skip-button" aria-label="Next sentence" onClick={() => void skipBy(1)} disabled={!pdf}>↷<small>1</small></button>
            </div>
            <div className="player-options">
              <label htmlFor="voice-select">Voice</label>
              <select id="voice-select" value={voice} onChange={(event) => setVoice(event.target.value)}>
                {(voices.length ? voices : [{ id: DEFAULT_VOICE, label: "Heart · US English" }]).map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
              <label className="speed-control" htmlFor="speed-control">
                <span>Speed</span><strong>{speed.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}×</strong>
                <input id="speed-control" type="range" min={SPEED_MIN} max={SPEED_MAX} step="0.05" value={speed}
                  onChange={(event) => setSpeed(safeSpeed(Number(event.target.value)))} />
              </label>
            </div>
          </footer>
          <button className="change-file" onClick={() => fileInputRef.current?.click()}>Open another PDF</button>
        </section>
      )}
    </main>
  );
}

export default App;
