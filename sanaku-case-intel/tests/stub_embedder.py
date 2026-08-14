"""A deterministic, fully offline fake embedder for tests.

Same text -> same vector, always (hash-based, not semantic). This verifies
the chunk -> store -> retrieve plumbing without a live Ollama instance —
it is NOT a stand-in for real embedding quality. Nothing about "does this
paraphrase actually retrieve the right passage" can be tested with this;
that's a property of the real embedding model, and it's called out
explicitly in the project's README.internal.md as something that must be
verified on a machine actually running Ollama.
"""
from __future__ import annotations

import hashlib
import struct
from typing import Sequence


class StubEmbedder:
    def __init__(self, dim: int = 32):
        self.dim = dim

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._vec(t) for t in texts]

    def embed_query(self, text: str) -> list[float]:
        return self._vec(text)

    def _vec(self, text: str) -> list[float]:
        h = hashlib.sha256(text.encode("utf-8")).digest()  # 32 bytes
        needed = self.dim * 4
        repeated = (h * ((needed // len(h)) + 1))[:needed]
        floats = struct.unpack(">" + "I" * self.dim, repeated)
        return [f / 0xFFFFFFFF for f in floats]
