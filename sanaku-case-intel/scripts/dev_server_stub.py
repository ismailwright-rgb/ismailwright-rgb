#!/usr/bin/env python3
"""Dev-only: runs api/main.py's FastAPI app with the embedder, generator,
and transcriber swapped for fakes, so the web UI (Phase 4) can be
exercised end to end without a live Ollama instance or a downloaded
whisper model. NOT part of the shipped app - never used by
scripts/setup.sh, and tests/stub_embedder.py + tests/stub_transcriber.py
(which this imports) only ever ship in the dev/test tree.

Usage: PYTHONPATH=. python3 scripts/dev_server_stub.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import uvicorn

from api.main import app, get_embedder, get_generator, get_transcriber
from core.generate import AnswerResult
from tests.stub_embedder import StubEmbedder
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
app.dependency_overrides[get_transcriber] = lambda: StubTranscriber()

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="warning")
