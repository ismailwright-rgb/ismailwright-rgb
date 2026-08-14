#!/usr/bin/env python3
"""Dev-only: runs api/main.py's FastAPI app with the embedder, generator,
transcriber, and synthesizer all swapped for fakes, so the web UI can be
exercised end to end without a live Ollama instance, a downloaded whisper
model, or a running Piper process. NOT part of the shipped app - never
used by scripts/setup.sh, and tests/stub_embedder.py +
tests/stub_transcriber.py + tests/stub_synthesizer.py (which this
imports) only ever ship in the dev/test tree.

Usage: PYTHONPATH=. python3 scripts/dev_server_stub.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn

from api.main import app, get_embedder, get_generator, get_synthesizer, get_transcriber
from core.generate import AnswerResult
from tests.stub_embedder import StubEmbedder
from tests.stub_synthesizer import StubSynthesizer
from tests.stub_transcriber import StubTranscriber


def fake_generate(question, passages, model, **kwargs):
    if not passages:
        return AnswerResult(answer="The provided documents do not address this.", sources=[])
    lines = [f"Thesis: this is a fake answer generated for UI testing, referencing {len(passages)} passage(s)."]
    lines.append("")
    lines.append("Supporting points:")
    lines.append("")
    for p in passages[:3]:
        lines.append(f"* Sample point drawn from this passage [{p.doc_name}, p.{p.page}]")
    return AnswerResult(answer="\n".join(lines), sources=passages)


app.dependency_overrides[get_embedder] = lambda: StubEmbedder()
app.dependency_overrides[get_generator] = lambda: fake_generate
# WHISPER_STUB_TEXT: dev/Playwright-only override so a manual verification
# run can control what every /transcribe call returns (e.g. the wake
# phrase itself, to prove a matching hands-free chunk starts real
# recording) without editing this file - never read anywhere outside this
# throwaway dev server.
_stub_text = os.environ.get("WHISPER_STUB_TEXT")
app.dependency_overrides[get_transcriber] = (
    lambda: StubTranscriber(fixed_text=_stub_text) if _stub_text else StubTranscriber()
)
app.dependency_overrides[get_synthesizer] = lambda: StubSynthesizer()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
