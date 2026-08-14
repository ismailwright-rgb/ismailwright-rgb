from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from api.main import app, get_config, get_embedder, get_generator
from core.config import ClientConfig, Colors
from core.generate import AnswerResult
from tests.stub_embedder import StubEmbedder


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


@pytest.fixture
def client(tmp_data_root):
    config = _test_config(tmp_data_root)
    app.dependency_overrides[get_config] = lambda: config
    app.dependency_overrides[get_embedder] = lambda: StubEmbedder()
    app.dependency_overrides[get_generator] = lambda: _fake_generate
    yield TestClient(app)
    app.dependency_overrides.clear()


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


def test_ingest_missing_case_directory_returns_404(client):
    r = client.post("/ingest", json={"case_id": "no_such_case"})
    assert r.status_code == 404


def test_ask_on_empty_case_returns_empty_sources(client):
    r = client.post("/ask", json={"case_id": "never_ingested", "question": "anything?"})
    assert r.status_code == 200
    assert r.json()["sources"] == []
