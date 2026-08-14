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
        --data-dir <dir> --host 127.0.0.1 --port 5001 --sentence-silence 0.6

Port 5001, not Piper's own default of 5000 - real bug hit live: macOS's
built-in AirPlay Receiver listens on port 5000 by default and intercepts
anything sent there that isn't an actual AirPlay request, returning a
plain 403 Forbidden - not a connection failure, so PiperSynthesizer's own
ConnectError handling below never catches it; it looks exactly like
Piper is running and simply refusing the request. Same category of fix as
this project's API server moving from port 8000 to 8001 after a real
port collision - rather than asking every Mac user to go disable a macOS
system feature, or hoping their Mac doesn't have it enabled, this project
just doesn't use the commonly-conflicting port at all. If 5001 collides
on some other machine too, change both this default and every place that
starts `piper.http_server` together.

--sentence-silence defaults to 0.0 in Piper's own server - literally no
pause between sentences unless set explicitly, which is what made an
early real run sound like one run-on utterance instead of distinct
points. Only useful paired with web/src/App.jsx's
stripCitationsForSpeech actually producing real sentence-terminal
punctuation between points in the first place - Piper can't pause on a
sentence boundary that isn't there. Raised from an initial 0.4 to 0.6
after a real live report that points still blurred together - a bigger
pause between every sentence, not just points specifically, since Piper
only exposes one global value here, not a per-boundary one. Paired with
stripCitationsForSpeech's own fix for the same report: a dangling
citation-lead-in phrase ("...experienced pain, according to .") reading
as a garbled fragment, not a clean pause.

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
# branding value. Port 5001, not Piper's own http_server default of 5000
# - see this module's own docstring for why (macOS AirPlay Receiver
# silently intercepts port 5000, returning 403 for anything that isn't a
# real AirPlay request - a real bug hit live, not a hypothetical one).
DEFAULT_PIPER_URL = os.environ.get("PIPER_URL", "http://127.0.0.1:5001")


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
                f"en_US-lessac-medium --data-dir <dir> --host 127.0.0.1 --port 5001 "
                f"--sentence-silence 0.6"
            ) from e
        except httpx.HTTPStatusError as e:
            # A 403 here on a Mac almost always means something other than
            # Piper answered the request - most commonly macOS's own
            # AirPlay Receiver, if it's running on the port this client is
            # configured to use (see this module's docstring). Named
            # explicitly rather than left as a bare status-code message,
            # since "the server said no" reads as a Piper-side problem
            # when it's actually a different program entirely answering.
            hint = ""
            if e.response.status_code == 403:
                hint = (
                    " A 403 here usually means something other than Piper is "
                    "answering on this port - on a Mac, macOS's own AirPlay "
                    "Receiver is the most common culprit if it's using this "
                    "port. Try: lsof -i :<port> to see what's actually there."
                )
            raise SynthesisError(f"The local voice service returned an error: {e}.{hint}") from e
        return resp.content
