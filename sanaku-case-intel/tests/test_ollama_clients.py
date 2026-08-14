"""Tests both the request/response shape (mocked transport) and the
unreachable-Ollama error path (real — Ollama genuinely isn't running in
this environment, so this exercises the actual connection-refused branch,
not a simulation of it)."""
import httpx
import pytest

from core.embed import OllamaEmbedder, OllamaUnavailableError
from core.generate import generate_answer
from core.retrieve import RetrievedChunk


def test_embedder_raises_when_unreachable():
    embedder = OllamaEmbedder(model="nomic-embed-text", base_url="http://localhost:11434", timeout=3.0)
    with pytest.raises(OllamaUnavailableError):
        embedder.embed_texts(["hello"])


def test_embedder_parses_response_shape():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/embed"
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2], [0.3, 0.4]]})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    embedder = OllamaEmbedder(model="nomic-embed-text", client=client)
    result = embedder.embed_texts(["a", "b"])
    assert result == [[0.1, 0.2], [0.3, 0.4]]


def test_embed_query_returns_single_vector():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"embeddings": [[0.5, 0.6]]})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    embedder = OllamaEmbedder(model="nomic-embed-text", client=client)
    assert embedder.embed_query("hello") == [0.5, 0.6]


def test_chat_raises_when_unreachable():
    with pytest.raises(OllamaUnavailableError):
        generate_answer(
            "question", [], model="llama3.1:8b", base_url="http://localhost:11434", timeout=3.0
        )


def test_chat_parses_response_and_uses_stream_false():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        import json

        body = json.loads(request.content)
        assert body["stream"] is False
        assert body["model"] == "llama3.1:8b"
        assert body["messages"][0]["role"] == "system"
        return httpx.Response(200, json={"message": {"content": "The answer is X [doc.pdf, p.3]."}})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    passage = RetrievedChunk(
        doc_id="doc", doc_name="doc.pdf", page=3, chunk_index=0, source_type="digital",
        event_date=None, date_confidence="undated", human_entered=False,
        text="some passage text", distance=0.1,
    )
    result = generate_answer("question", [passage], model="llama3.1:8b", client=client)
    assert result.answer == "The answer is X [doc.pdf, p.3]."
    assert result.sources == [passage]
