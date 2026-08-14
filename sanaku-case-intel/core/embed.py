"""Local embedding via Ollama. No cloud embedding API is ever called —
this is guardrail #1 in the mission brief, not a preference.

EmbeddingFunction is the seam that keeps the rest of the system (core.store,
core.retrieve) decoupled from Ollama specifically: production code always
uses OllamaEmbedder; tests substitute a deterministic stub
(tests/stub_embedder.py) so the storage/retrieval plumbing is verifiable
without a live Ollama instance.
"""
from __future__ import annotations

from typing import Protocol, Sequence

import httpx

# Not a client config field (config/client.json only carries the *model
# names* per the client-config spec) — Ollama itself already respects this
# env var, so it's read the same way Ollama's own tooling expects.
import os

DEFAULT_OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434")


class OllamaError(RuntimeError):
    """Base class for anything that goes wrong talking to Ollama."""


class OllamaUnavailableError(OllamaError):
    """Ollama isn't reachable at all — not running, wrong URL, etc."""


class EmbeddingFunction(Protocol):
    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]: ...

    def embed_query(self, text: str) -> list[float]: ...


class OllamaEmbedder:
    """Embeds text via Ollama's /api/embed endpoint (the batch embedding
    endpoint — response key is "embeddings", plural, one vector per input;
    this is distinct from the older singular /api/embeddings endpoint)."""

    def __init__(
        self,
        model: str,
        base_url: str = DEFAULT_OLLAMA_URL,
        timeout: float = 120.0,
        client: httpx.Client | None = None,
    ):
        self._model = model
        self._client = client or httpx.Client(base_url=base_url, timeout=timeout)

    def embed_texts(self, texts: Sequence[str]) -> list[list[float]]:
        if not texts:
            return []
        try:
            resp = self._client.post("/api/embed", json={"model": self._model, "input": list(texts)})
            resp.raise_for_status()
        except httpx.ConnectError as e:
            raise OllamaUnavailableError(
                f"Cannot reach Ollama at {self._client.base_url}. "
                f"Is it running? Try: ollama serve"
            ) from e
        except httpx.HTTPStatusError as e:
            raise OllamaError(f"Ollama returned an error embedding text: {e}") from e
        data = resp.json()
        return data["embeddings"]

    def embed_query(self, text: str) -> list[float]:
        return self.embed_texts([text])[0]
