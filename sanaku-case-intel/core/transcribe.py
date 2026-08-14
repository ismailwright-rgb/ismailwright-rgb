"""Local speech-to-text via faster-whisper. No cloud transcription API is
ever called — same guardrail #1 (everything runs locally) that keeps
core/embed.py and core/generate.py talking only to a local Ollama, applied
here to voice input instead of the browser's SpeechRecognition API, which
on Chrome typically round-trips audio through Google's servers.

Transcriber is the seam that keeps api/main.py decoupled from
faster-whisper specifically: production code uses WhisperTranscriber;
tests substitute a deterministic stub (tests/stub_transcriber.py) so the
/transcribe endpoint's request/response contract is verifiable without a
real audio pipeline or a downloaded model.
"""
from __future__ import annotations

import os
from typing import Protocol

# Not a client config field, same reasoning as DEFAULT_OLLAMA_URL in
# core/embed.py: this isn't a per-firm branding value, it's
# infrastructure. small.en balances accuracy against speed for
# English-language legal Q&A; override via env var if a firm's hardware
# needs a lighter (or heavier) model.
DEFAULT_WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "small.en")


class TranscriptionError(RuntimeError):
    """Base class for anything that goes wrong transcribing audio."""


class ModelUnavailableError(TranscriptionError):
    """The whisper model isn't downloaded/cached yet, or failed to load."""


class Transcriber(Protocol):
    def transcribe(self, audio_bytes: bytes) -> str: ...


class WhisperTranscriber:
    """Wraps faster_whisper.WhisperModel. Loaded lazily - importing this
    module (e.g. at api/main.py startup) must stay fast even when voice
    is never used in a given session, so the actual model only loads on
    first real transcribe() call, not at construction time."""

    def __init__(self, model_size: str = DEFAULT_WHISPER_MODEL):
        self._model_size = model_size
        self._model = None

    def _ensure_loaded(self):
        if self._model is not None:
            return self._model
        try:
            from faster_whisper import WhisperModel
        except ImportError as e:
            raise ModelUnavailableError(
                "faster-whisper isn't installed. Voice input needs the optional "
                "voice dependencies: pip install -r requirements-voice.txt"
            ) from e
        try:
            self._model = WhisperModel(self._model_size, device="cpu", compute_type="int8")
        except Exception as e:
            raise ModelUnavailableError(
                f"Could not load the '{self._model_size}' speech model. If this is "
                f"the first run, it needs to download once from Hugging Face - "
                f"confirm this machine has internet access, then try again. ({e})"
            ) from e
        return self._model

    def transcribe(self, audio_bytes: bytes) -> str:
        import io

        model = self._ensure_loaded()
        segments, _info = model.transcribe(io.BytesIO(audio_bytes), beam_size=5)
        return " ".join(segment.text.strip() for segment in segments).strip()
