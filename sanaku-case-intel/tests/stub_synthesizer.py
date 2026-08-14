"""A deterministic, fully offline fake synthesizer for tests.

Verifies /speak's request/response contract (JSON text in, audio bytes
out) without a real Piper process running - NOT a stand-in for real
voice quality/naturalness. That's a property of the real local voice
service and, like transcription accuracy and live cited-answer output,
has to be verified on a machine actually running `python3 -m
piper.http_server`.
"""
from __future__ import annotations

import io
import wave


def _silent_wav(seconds: float = 0.2, framerate: int = 16000) -> bytes:
    """A genuinely valid, decodable (silent) WAV clip - not just
    WAV-shaped bytes - so a real <audio> element can actually load and
    play it during UI verification, not just receive a 200 response."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(framerate)
        w.writeframes(b"\x00\x00" * int(seconds * framerate))
    return buf.getvalue()


class StubSynthesizer:
    def __init__(self, fixed_audio: bytes | None = None):
        self.fixed_audio = fixed_audio if fixed_audio is not None else _silent_wav()
        self.calls: list[str] = []

    def synthesize(self, text: str) -> bytes:
        self.calls.append(text)
        return self.fixed_audio
