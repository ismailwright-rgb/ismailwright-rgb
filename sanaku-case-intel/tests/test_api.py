import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import (
    app,
    get_config,
    get_embedder,
    get_generator,
    get_stream_generator,
    get_synthesizer,
    get_transcriber,
)
from core.config import ClientConfig, Colors
from core.embed import OllamaUnavailableError
from core.generate import AnswerResult
from tests.stub_embedder import StubEmbedder
from tests.stub_synthesizer import StubSynthesizer
from tests.stub_transcriber import StubTranscriber


def _test_config(data_root: Path) -> ClientConfig:
    return ClientConfig(
        firm_name="Test Firm LLP",
        logo_path="config/assets/logo.png",
        colors=Colors(primary="#000", secondary="#111", accent="#222"),
        tier="standard",
        data_root=str(data_root),
        gen_model="llama3.1:8b",
        embed_model="nomic-embed-text",
        license_path="config/license.key",
    )


def _fake_generate(question, passages, model, **kwargs):
    top = passages[0] if passages else None
    text = f"Fake answer from {len(passages)} passage(s)."
    if top:
        text += f" [{top.doc_name}, p.{top.page}]"
    return AnswerResult(answer=text, sources=passages)


def _fake_stream_generate(question, passages, model, **kwargs):
    text = _fake_generate(question, passages, model, **kwargs).answer
    for word in text.split(" "):
        yield word + " "


def _fake_stream_generate_raises(question, passages, model, **kwargs):
    # A generator that raises only once iterated (never on call) - the
    # same shape a real Ollama failure mid-stream takes, since
    # core/generate.py's stream_answer is itself a generator function.
    if False:
        yield ""  # pragma: no cover - makes this a generator function
    raise OllamaUnavailableError("Ollama took too long to respond - try again.")


@pytest.fixture
def client(tmp_data_root):
    config = _test_config(tmp_data_root)
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_embedder] = lambda: StubEmbedder()
    app.dependency_overrides[get_generator] = lambda: _fake_generate
    app.dependency_overrides[get_stream_generator] = lambda: _fake_stream_generate
    app.dependency_overrides[get_transcriber] = lambda: StubTranscriber()
    app.dependency_overrides[get_synthesizer] = lambda: StubSynthesizer()
    yield TestClient(app)
    app.dependency_overrides.clear()


def _parse_ndjson(text: str) -> list[dict]:
    return [json.loads(line) for line in text.strip().split("\n") if line]


def test_health_reports_ollama_unreachable_without_throwing(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["firm_name"] == "Test Firm LLP"
    assert isinstance(body["ollama_reachable"], bool)


def test_ingest_then_ask_full_http_contract(client, sample_case_fixtures):
    r = client.post(
        "/ingest",
        json={
            "case_id": "maria_delgado",
            "doc_paths": [str(sample_case_fixtures["medical_record"])],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["case_id"] == "maria_delgado"
    assert body["documents_ingested"] == 1
    assert body["chunks_stored"] == 4

    r = client.post(
        "/ask",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 200
    body = r.json()
    assert "answer" in body and isinstance(body["answer"], str)
    assert "sources" in body and isinstance(body["sources"], list)
    assert len(body["sources"]) > 0
    for key in ("doc_id", "doc_name", "page", "source_type", "human_entered", "date_confidence"):
        assert key in body["sources"][0]


def test_ask_stream_sends_sources_first_then_deltas_then_done(client, sample_case_fixtures):
    client.post(
        "/ingest",
        json={
            "case_id": "maria_delgado",
            "doc_paths": [str(sample_case_fixtures["medical_record"])],
        },
    )
    r = client.post(
        "/ask/stream",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("application/x-ndjson")

    events = _parse_ndjson(r.text)
    assert events[0]["type"] == "sources"
    assert len(events[0]["sources"]) > 0
    assert all(e["type"] == "delta" for e in events[1:-1])
    assert events[-1]["type"] == "done"
    # The concatenated deltas must equal the final "done" answer exactly -
    # the whole point of shipping both is that the client can trust either
    # one, not just whichever arrived last.
    assert "".join(e["text"] for e in events[1:-1]) == events[-1]["answer"]


def test_ask_stream_on_empty_case_still_sends_empty_sources_then_done(client):
    r = client.post("/ask/stream", json={"case_id": "never_ingested", "question": "anything?"})
    assert r.status_code == 200
    events = _parse_ndjson(r.text)
    assert events[0] == {"type": "sources", "sources": []}
    assert events[-1]["type"] == "done"


def test_ask_stream_reports_generation_failure_as_final_error_event(client, sample_case_fixtures):
    client.post(
        "/ingest",
        json={
            "case_id": "maria_delgado",
            "doc_paths": [str(sample_case_fixtures["medical_record"])],
        },
    )
    app.dependency_overrides[get_stream_generator] = lambda: _fake_stream_generate_raises
    r = client.post(
        "/ask/stream",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    # Headers/status are already committed by the time a mid-stream
    # failure happens - 200, not 503, is correct here; the error is
    # reported as the stream's own last line instead. See POST /ask/stream's
    # own docstring in api/main.py for why this can't be a real
    # HTTPException.
    assert r.status_code == 200
    events = _parse_ndjson(r.text)
    assert events[0]["type"] == "sources"
    assert events[-1]["type"] == "error"
    assert "try again" in events[-1]["detail"]


def test_ingest_missing_case_directory_returns_404(client):
    r = client.post("/ingest", json={"case_id": "no_such_case"})
    assert r.status_code == 404


def test_ask_on_empty_case_returns_empty_sources(client):
    r = client.post("/ask", json={"case_id": "never_ingested", "question": "anything?"})
    assert r.status_code == 200
    assert r.json()["sources"] == []


def test_transcribe_returns_text_from_uploaded_audio(client):
    r = client.post(
        "/transcribe",
        files={"audio": ("clip.webm", b"fake-audio-bytes-not-real-audio", "audio/webm")},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "What did the treating physician say about causation?"


def test_speak_returns_audio_bytes(client):
    r = client.post("/speak", json={"text": "Dr. Chen's opinion on causation."})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("audio/")
    assert r.content == StubSynthesizer().fixed_audio


def test_ask_accepts_conversation_history(client, sample_case_fixtures):
    client.post(
        "/ingest",
        json={
            "case_id": "maria_delgado",
            "doc_paths": [str(sample_case_fixtures["medical_record"])],
        },
    )
    r = client.post(
        "/ask",
        json={
            "case_id": "maria_delgado",
            "question": "What about her prior injuries?",
            "history": [
                {
                    "question": "What did the treating physician say about causation?",
                    "answer": "Dr. Chen concluded causation. [medical_record_dr_chen.pdf, p.3]",
                }
            ],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert "answer" in body and "sources" in body
