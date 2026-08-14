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


def test_get_config_wraps_invalid_config_content_as_clean_500(monkeypatch):
    # Real bug found live: a config/client.json that exists but has
    # invalid content (malformed JSON, or a schema mismatch) raises a
    # ValueError subclass, not FileNotFoundError - get_config() used to
    # only catch the latter, letting the former propagate as an
    # unhandled exception. This bypasses TestClient/HTTP entirely and
    # calls get_config() directly, since the bug is in that function's
    # own exception handling, not in routing.
    import api.main as main_module

    def fake_load_config():
        raise ValueError("2 validation errors for ClientConfig")

    monkeypatch.setattr(main_module, "load_config", fake_load_config)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc_info:
        main_module.get_config()
    assert exc_info.value.status_code == 500
    assert "isn't valid" in exc_info.value.detail
    assert "validation errors" in exc_info.value.detail


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


def test_ingest_wraps_unexpected_exception_as_clean_500(client, sample_case_fixtures):
    # Real gap found by auditing for the same class of bug get_config()
    # had: extract_document()/PyMuPDF/pytesseract can raise things that
    # are neither FileNotFoundError nor OllamaError (an unsupported file
    # type, a corrupted PDF, a missing tesseract-ocr system binary) -
    # simulated here via an embedder whose embed_texts raises a plain
    # RuntimeError, since any exception mid-ingest should be caught the
    # same way regardless of which call inside it actually raised.
    class _RaisingEmbedder:
        def embed_texts(self, texts):
            raise RuntimeError("simulated ingestion failure")

        def embed_query(self, text):
            raise RuntimeError("simulated ingestion failure")

    app.dependency_overrides[get_embedder] = lambda: _RaisingEmbedder()
    r = client.post(
        "/ingest",
        json={"case_id": "maria_delgado", "doc_paths": [str(sample_case_fixtures["medical_record"])]},
    )
    assert r.status_code == 500
    assert "Ingestion failed" in r.json()["detail"]
    assert "simulated ingestion failure" in r.json()["detail"]


def test_ask_wraps_unexpected_exception_as_clean_500(client, sample_case_fixtures):
    def _raising_generate(question, passages, model, **kwargs):
        raise RuntimeError("simulated generation failure")

    client.post(
        "/ingest",
        json={"case_id": "maria_delgado", "doc_paths": [str(sample_case_fixtures["medical_record"])]},
    )
    app.dependency_overrides[get_generator] = lambda: _raising_generate
    r = client.post(
        "/ask",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 500
    assert "simulated generation failure" in r.json()["detail"]


def test_ask_stream_wraps_unexpected_generation_exception_as_error_event(client, sample_case_fixtures):
    def _raising_stream_generate(question, passages, model, **kwargs):
        if False:
            yield ""  # pragma: no cover - makes this a generator function
        raise RuntimeError("simulated stream failure")

    client.post(
        "/ingest",
        json={"case_id": "maria_delgado", "doc_paths": [str(sample_case_fixtures["medical_record"])]},
    )
    app.dependency_overrides[get_stream_generator] = lambda: _raising_stream_generate
    r = client.post(
        "/ask/stream",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 200
    events = _parse_ndjson(r.text)
    assert events[0]["type"] == "sources"
    assert events[-1]["type"] == "error"
    assert "simulated stream failure" in events[-1]["detail"]


def test_ask_stream_wraps_unexpected_retrieval_exception_as_error_event(client, sample_case_fixtures):
    # A never-ingested case short-circuits retrieve_passages before it
    # ever calls embed_query (store.count() == 0 returns [] early) - so
    # this needs a case with real chunks already stored, to actually
    # exercise the embed_query call path this is testing.
    client.post(
        "/ingest",
        json={"case_id": "maria_delgado", "doc_paths": [str(sample_case_fixtures["medical_record"])]},
    )

    class _RaisingEmbedder:
        def embed_texts(self, texts):
            return []

        def embed_query(self, text):
            raise RuntimeError("simulated retrieval failure")

    app.dependency_overrides[get_embedder] = lambda: _RaisingEmbedder()
    r = client.post(
        "/ask/stream",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 200
    events = _parse_ndjson(r.text)
    assert events[0]["type"] == "error"
    assert "simulated retrieval failure" in events[0]["detail"]


def test_transcribe_wraps_unexpected_exception_as_clean_500(client):
    class _RaisingTranscriber:
        def transcribe(self, audio_bytes):
            raise RuntimeError("simulated transcription failure")

    app.dependency_overrides[get_transcriber] = lambda: _RaisingTranscriber()
    r = client.post(
        "/transcribe",
        files={"audio": ("clip.webm", b"fake-audio-bytes-not-real-audio", "audio/webm")},
    )
    assert r.status_code == 500
    assert "simulated transcription failure" in r.json()["detail"]


def test_speak_wraps_unexpected_exception_as_clean_500(client):
    class _RaisingSynthesizer:
        def synthesize(self, text):
            raise RuntimeError("simulated synthesis failure")

    app.dependency_overrides[get_synthesizer] = lambda: _RaisingSynthesizer()
    r = client.post("/speak", json={"text": "hello"})
    assert r.status_code == 500
    assert "simulated synthesis failure" in r.json()["detail"]


def test_manual_entry_becomes_a_citable_retrievable_source(client, sample_case_fixtures):
    client.post(
        "/ingest",
        json={"case_id": "maria_delgado", "doc_paths": [str(sample_case_fixtures["medical_record"])]},
    )
    r = client.post(
        "/manual-entries",
        json={
            "case_id": "maria_delgado",
            "text": "Client confirmed by phone she had no prior lower-back injury before the collision.",
            "doc_name": "Phone call with client, 3/10/2024",
            "event_date": "2024-03-10",
            "date_confidence": "exact",
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["case_id"] == "maria_delgado"
    assert body["doc_name"] == "Phone call with client, 3/10/2024"
    assert body["doc_id"].startswith("manual-")

    # The medical record has 4 chunks; with this one manual entry that's 5
    # total against the default top_k=8, so every chunk (including this
    # one) comes back regardless of the stub embedder's non-semantic
    # vectors - real semantic ranking is a live-Ollama-only property,
    # covered elsewhere in this project's own verification notes.
    r = client.post(
        "/ask",
        json={"case_id": "maria_delgado", "question": "What did the treating physician say about causation?"},
    )
    assert r.status_code == 200
    sources = r.json()["sources"]
    manual_sources = [s for s in sources if s["doc_id"].startswith("manual-")]
    assert len(manual_sources) == 1
    entry = manual_sources[0]
    assert entry["doc_name"] == "Phone call with client, 3/10/2024"
    assert entry["source_type"] == "manual"
    assert entry["human_entered"] is True
    assert entry["date_confidence"] == "exact"
    assert entry["event_date"] == "2024-03-10"


def test_manual_entry_on_a_brand_new_case_makes_it_listable(client):
    r = client.get("/cases")
    assert "brand_new_case" not in r.json()["cases"]

    r = client.post(
        "/manual-entries",
        json={
            "case_id": "brand_new_case",
            "text": "Intake call summary: new client, potential premises-liability claim.",
            "doc_name": "Intake call, 1/5/2024",
        },
    )
    assert r.status_code == 200

    # No documents/ folder existed for this case before the manual entry -
    # GET /cases only lists case_ids with that folder present, so without
    # add_manual_entry creating it, this case would never show up at all.
    r = client.get("/cases")
    assert "brand_new_case" in r.json()["cases"]


def test_manual_entry_normalizes_date_confidence_when_no_date_given(client):
    r = client.post(
        "/manual-entries",
        json={
            "case_id": "maria_delgado",
            "text": "A fact with no known date attached.",
            "doc_name": "Undated staff note",
            "date_confidence": "exact",  # nonsensical without event_date - should be normalized
        },
    )
    assert r.status_code == 200
    r = client.post("/ask", json={"case_id": "maria_delgado", "question": "anything?"})
    entry = next(s for s in r.json()["sources"] if s["doc_id"].startswith("manual-"))
    assert entry["date_confidence"] == "undated"
    assert entry["event_date"] is None


def test_manual_entry_rejects_blank_text(client):
    r = client.post(
        "/manual-entries",
        json={"case_id": "maria_delgado", "text": "   ", "doc_name": "A label"},
    )
    assert r.status_code == 400


def test_manual_entry_rejects_blank_label(client):
    r = client.post(
        "/manual-entries",
        json={"case_id": "maria_delgado", "text": "Some real text.", "doc_name": "   "},
    )
    assert r.status_code == 400


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
