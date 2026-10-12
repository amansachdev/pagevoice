from __future__ import annotations

import io
import threading
from functools import partial

import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

app = FastAPI(title="Pagevoice local speech service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

_model = None
_model_lock = threading.Lock()
_synthesis_lock = threading.Lock()
_voices = [
    {"id": "af_heart", "label": "Heart · US English"},
    {"id": "af_sarah", "label": "Sarah · US English"},
    {"id": "af_nova", "label": "Nova · US English"},
    {"id": "am_adam", "label": "Adam · US English"},
    {"id": "bf_emma", "label": "Emma · British English"},
    {"id": "bm_george", "label": "George · British English"},
]


class SpeechRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    voice: str = Field(default="af_heart", min_length=2, max_length=40)
    speed: float = Field(default=1.0, ge=0.75, le=2.0)


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:
                try:
                    from kokoro_mlx import KokoroTTS

                    _model = KokoroTTS.from_pretrained()
                except Exception as error:
                    raise RuntimeError(
                        "Could not load Kokoro. Check the Python environment and network access "
                        "for the initial model download."
                    ) from error
    return _model


def _make_audio(request: SpeechRequest) -> bytes:
    with _synthesis_lock:
        model = _get_model()
        result = model.generate(
            request.text,
            voice=request.voice,
            speed=request.speed,
            sample_rate=24000,
        )
    output = io.BytesIO()
    sf.write(output, np.asarray(result.audio, dtype=np.float32), result.sample_rate, format="WAV")
    return output.getvalue()


@app.get("/api/status")
async def status():
    return {"online": True, "ready": _model is not None, "engine": "kokoro-mlx"}


@app.get("/api/voices")
async def voices():
    return {"voices": _voices}


@app.post("/api/synthesize")
async def synthesize(request: SpeechRequest):
    if request.voice not in {voice["id"] for voice in _voices}:
        raise HTTPException(status_code=400, detail="That voice is not available.")
    try:
        audio = await run_in_threadpool(partial(_make_audio, request))
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except Exception as error:
        raise HTTPException(status_code=500, detail="Speech synthesis failed: " + str(error)) from error

    from fastapi.responses import Response

    return Response(content=audio, media_type="audio/wav")
