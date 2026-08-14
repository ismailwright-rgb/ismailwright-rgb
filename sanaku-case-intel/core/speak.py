"""Local text-to-speech via a separate Piper process, called over HTTP -
never imported directly into this codebase's own Python process.

piper-tts is GPL-3.0-or-later licensed; this codebase is proprietary.
Importing it in-process (the way core/transcribe.py's WhisperTranscriber
imports faster-whisper) would create the exact "combined work" concern
GPL is built around. Running it as its own separate local program,
talked to only over localhost HTTP, mirrors the relationship this app
already has with Ollama (core/embed.py, core/generate.py) — a distinct
program, never imported, called over a network interface. That boundary
still needs real legal review before this ships to any paying client;
nothing here asserts it's a settled legal conclusion, only that it's the
safer of the two shapes and the one deliberately chosen over in-process
import.

Start the local voice service (its own terminal, same shape as
`ollama serve`):
    python3 -m piper.download_voices en_US-lessac-medium --data-dir <dir>
    python3 -m piper.http_server --model en_US-lessac-medium \
        --data-dir <dir> --host 127.0.0.1 --port 5000

Synthesizer is the seam that keeps api/main.py decoupled from Piper
specifically: production code uses PiperSynthesizer; tests substitute a
deterministic stub (tests/stub_synthesizer.py) so the /speak request/
response contract is verifiable without a real Piper process running.
"""
from __future__ import annotations

import os
from typing import Protocol

import httpx

# Not a client config field, same reasoning as DEFAULT_OLLAMA_URL in
# core/embed.py: this is a machine/infrastructure choice, not a per-firm
# branding value. Default port matches Piper's own http_server default so
# a firm running the documented one-time-setup command doesn't need to
# pass --port to line up with this.
DEFAULT_PIPER_URL = os.environ.get("PIPER_URL", "http://127.0.0.1:5000")


class SynthesisError(RuntimeError):
    """Base class for anything that goes wrong talking to the local voice service."""


class PiperUnavailableError(SynthesisError):
    """The local Piper process isn't reachable - not running, wrong URL, etc."""


class Synthesizer(Protocol):
    def synthesize(self, text: str) -> bytes: ...


class PiperSynthesizer:
    """Speaks text via a local Piper HTTP server's POST /synthesize (verified
    directly against OHF-Voice/piper1-gpl's own http_server.py source, not
    guessed): body {"text": "..."}, response body is raw WAV bytes."""

    def __init__(
        self,
        base_url: str = DEFAULT_PIPER_URL,
        timeout: float = 60.0,
        client: httpx.Client | None = None,
    ):
        self._client = client or httpx.Client(base_url=base_url, timeout=timeout)

    def synthesize(self, text: str) -> bytes:
        try:
            resp = self._client.post("/synthesize", json={"text": text})
            resp.raise_for_status()
        except httpx.ConnectError as e:
            raise PiperUnavailableError(
                f"Cannot reach the local voice service at {self._client.base_url}. "
                f"Is it running? Try: python3 -m piper.http_server --model "
                f"en_US-lessac-medium --data-dir <dir> --host 127.0.0.1 --port 5000"
            ) from e
        except httpx.HTTPStatusError as e:
            raise SynthesisError(f"The local voice service returned an error: {e}") from e
        return resp.content
