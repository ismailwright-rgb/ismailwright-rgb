"""A deterministic, fully offline fake transcriber for tests.

Verifies /transcribe's request/response contract (multipart upload in,
{"text": ...} out) without a real audio pipeline or a downloaded whisper
model - NOT a stand-in for real transcription accuracy. That's a property
of the real model and, like semantic embedding quality and live Ollama
generation, has to be verified on a machine that actually has a
microphone and the model downloaded.
"""
from __future__ import annotations


class StubTranscriber:
    def __init__(self, fixed_text: str = "What did the treating physician say about causation?"):
        self.fixed_text = fixed_text
        self.calls: list[bytes] = []

    def transcribe(self, audio_bytes: bytes) -> str:
        self.calls.append(audio_bytes)
        return self.fixed_text
