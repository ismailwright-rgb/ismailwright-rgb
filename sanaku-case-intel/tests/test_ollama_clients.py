"""Tests both the request/response shape (mocked transport) and the
unreachable-Ollama error path (real — Ollama genuinely isn't running in
this environment, so this exercises the actual connection-refused branch,
not a simulation of it)."""
import json

import httpx
import pytest

from core.embed import OLLAMA_KEEP_ALIVE, OllamaEmbedder, OllamaUnavailableError
from core.generate import OLLAMA_NUM_CTX, generate_answer, stream_answer
from core.retrieve import RetrievedChunk


def test_embedder_raises_when_unreachable():
    embedder = OllamaEmbedder(model="nomic-embed-text", base_url="http://localhost:11434", timeout=3.0)
    with pytest.raises(OllamaUnavailableError):
        embedder.embed_texts(["hello"])


def test_embedder_raises_ollama_unavailable_on_timeout():
    """Real bug found on a live run: a plain httpx.ReadTimeout (e.g. Ollama
    cold-starting a model) fell through uncaught, past api/main.py's
    except OllamaError clause, into an unhandled 500 with a non-JSON body -
    which crashed the frontend's response parsing. Deterministic via a
    mock transport that raises the timeout, no real 3-second wait needed."""

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    embedder = OllamaEmbedder(model="nomic-embed-text", client=client)
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


def test_embed_sends_keep_alive():
    """Real bug found live: with no keep_alive sent, Ollama's own default
    (5-minute idle-unload) applies, so any gap longer than that between
    requests triggers a full model reload before the next request can
    even start. Confirms the fix actually sends the value, not just that
    it exists as a constant somewhere."""

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert body["keep_alive"] == OLLAMA_KEEP_ALIVE
        return httpx.Response(200, json={"embeddings": [[0.1, 0.2]]})

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    embedder = OllamaEmbedder(model="nomic-embed-text", client=client)
    embedder.embed_texts(["a"])


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


def test_chat_raises_ollama_unavailable_on_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    with pytest.raises(OllamaUnavailableError):
        generate_answer("question", [], model="llama3.1:8b", client=client)


def test_chat_parses_response_and_uses_stream_false():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        import json

        body = json.loads(request.content)
        assert body["stream"] is False
        assert body["model"] == "llama3.1:8b"
        assert body["messages"][0]["role"] == "system"
        assert body["keep_alive"] == OLLAMA_KEEP_ALIVE
        assert body["options"]["num_ctx"] == OLLAMA_NUM_CTX
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


def test_stream_answer_uses_stream_true_and_yields_deltas_in_order():
    # Real shape of Ollama's own streaming /api/chat response - one JSON
    # object per line, each carrying a message.content delta, the final
    # line marked done: true.
    ndjson_lines = [
        {"message": {"content": "The "}, "done": False},
        {"message": {"content": "answer "}, "done": False},
        {"message": {"content": "is X."}, "done": False},
        {"message": {"content": ""}, "done": True},
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/chat"
        body = json.loads(request.content)
        assert body["stream"] is True
        assert body["keep_alive"] == OLLAMA_KEEP_ALIVE
        assert body["options"]["num_ctx"] == OLLAMA_NUM_CTX
        return httpx.Response(200, content=("\n".join(json.dumps(l) for l in ndjson_lines) + "\n").encode())

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    deltas = list(stream_answer("question", [], model="llama3.1:8b", client=client))
    assert deltas == ["The ", "answer ", "is X."]


def test_stream_answer_raises_ollama_unavailable_on_timeout():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    client = httpx.Client(transport=httpx.MockTransport(handler), base_url="http://localhost:11434")
    with pytest.raises(OllamaUnavailableError):
        # stream_answer is a generator function - the request isn't made
        # until iteration actually starts, so the exception only surfaces
        # once something consumes it (list(...) here, api/main.py's
        # event_stream in production).
        list(stream_answer("question", [], model="llama3.1:8b", client=client))


def test_stream_answer_raises_when_unreachable():
    with pytest.raises(OllamaUnavailableError):
        list(stream_answer(
            "question", [], model="llama3.1:8b", base_url="http://localhost:11434", timeout=3.0
        ))
