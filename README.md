# Pagevoice

Pagevoice is a local PDF listening player for macOS. Open a book, jump to a page or click a sentence, and listen with a locally run Kokoro voice. Playback highlights the sentence being read and continues across pages.

## Features

- PDF page navigation in single-page or facing two-page view
- Sentence-level playback start with sentence-accurate spoken highlighting
- Play, pause, resume, skip, voice selection, and adjustable speed
- Player stays visible while the document scrolls; reading position is saved
- PDF rendering and progress stored in your browser
- Local speech synthesis through Kokoro MLX

## Requirements

- macOS 13 or newer on Apple Silicon (M1 or later)
- Node.js 20.19+ or 22.12+
- [uv](https://docs.astral.sh/uv/)
- Python 3.12, installed by `uv` during setup
- Google Chrome is preferred; the default browser is used if Chrome is unavailable

This first version supports PDFs with selectable text. Scanned image-only PDFs and OCR are not supported. Page numbers refer to the page index in the PDF file.

## Setup

In Terminal, move into the project directory and install the dependencies:

```sh
npm ci
uv python install 3.12
uv sync --project backend --python 3.12
```

## Start the reader

```sh
sh ./start-local.sh
```

The script starts the web app and speech service, then opens the reader in Chrome (or your default browser). Choose a PDF, enter a page number or click a sentence, then press Play. When you open the same PDF again in the same browser, Pagevoice restores your last position.

The first time you press Play, Kokoro downloads its model weights from Hugging Face. This initial download requires an internet connection; speech synthesis runs locally afterward.

## Privacy

The PDF is opened and rendered in your browser. The speech service listens only on your computer (`127.0.0.1`), and the app sends it the sentence being spoken so it can return audio. Pagevoice does not upload the PDF or send its text to a hosted speech service. The PDF fingerprint and reading position are stored in browser local storage.

## Development

Run the web app alone with `npm run dev` and the speech service with `uv run --project backend --python 3.12 uvicorn server:app --app-dir backend --host 127.0.0.1 --port 8765`. The FastAPI service exposes `/api/status`, `/api/voices`, and `/api/synthesize` on port 8765.

Contributions and bug reports are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow. Pagevoice is an independent open source project and is not affiliated with Speechify.

## License

Pagevoice is released under the [MIT License](LICENSE). Third-party dependencies and downloaded speech models may have their own licenses and terms.
