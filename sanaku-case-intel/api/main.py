"""FastAPI app exposing /health, /ingest, /ask.

Every Ollama-dependent piece (embedder, generator) is wired in via FastAPI's
own Depends() so it can be swapped for a test double in tests/test_api.py —
production always gets the real Ollama-backed implementation; nothing in
this file special-cases "am I under test".
"""
from __future__ import annotations

from dataclasses import asdict
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException
from pydantic import BaseModel

from core.chunk import chunk_pages
from core.config import ClientConfig, load_config
from core.embed import DEFAULT_OLLAMA_URL, EmbeddingFunction, OllamaEmbedder, OllamaError
from core.generate import AnswerResult, generate_answer
from core.ingest import extract_document
from core.retrieve import retrieve_passages
from core.store import CaseStore

app = FastAPI(title="Sanaku Case-Intel API")

SUPPORTED_SUFFIXES = {".pdf", ".txt"}


# ---- dependencies -----------------------------------------------------

def get_config() -> ClientConfig:
    try:
        return load_config()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def get_embedder(config: ClientConfig = Depends(get_config)) -> EmbeddingFunction:
    return OllamaEmbedder(model=config.embed_model)


def get_generator():
    """Returns the real Ollama-backed generate_answer by default. Tests
    override this dependency with a fake via app.dependency_overrides."""
    return generate_answer


# ---- shared orchestration (also used directly by cli.py, no HTTP needed) --

def ingest_case_documents(
    case_id: str,
    config: ClientConfig,
    embedder: EmbeddingFunction,
    doc_paths: list[Path] | None = None,
) -> dict:
    case_docs_dir = Path(config.data_root) / "cases" / case_id / "documents"
    if doc_paths is None:
        if not case_docs_dir.exists():
            raise FileNotFoundError(
                f"No documents directory for case '{case_id}' at {case_docs_dir}"
            )
        doc_paths = sorted(p for p in case_docs_dir.iterdir() if p.suffix.lower() in SUPPORTED_SUFFIXES)

    store = CaseStore(config.data_root, case_id)
    total_chunks = 0
    for doc_path in doc_paths:
        doc_id = doc_path.stem
        pages = extract_document(doc_path)
        chunks = chunk_pages(case_id, doc_id, doc_path.name, pages)
        if not chunks:
            continue
        vectors = embedder.embed_texts([c.text for c in chunks])
        store.add_chunks(chunks, vectors)
        total_chunks += len(chunks)

    return {"case_id": case_id, "documents_ingested": len(doc_paths), "chunks_stored": total_chunks}


def ask_case_question(
    case_id: str,
    question: str,
    config: ClientConfig,
    embedder: EmbeddingFunction,
    generator,
    top_k: int = 8,
) -> AnswerResult:
    passages = retrieve_passages(case_id, question, embedder, config.data_root, top_k=top_k)
    return generator(question, passages, model=config.gen_model)


# ---- routes -------------------------------------------------------------

@app.get("/health")
def health(config: ClientConfig = Depends(get_config)):
    ollama_reachable = False
    available_models: list[str] = []
    try:
        r = httpx.get(f"{DEFAULT_OLLAMA_URL}/api/tags", timeout=2.0)
        r.raise_for_status()
        available_models = [m["name"] for m in r.json().get("models", [])]
        ollama_reachable = True
    except httpx.HTTPError:
        pass
    return {
        "status": "ok",
        "firm_name": config.firm_name,
        "ollama_reachable": ollama_reachable,
        "gen_model_available": config.gen_model in available_models,
        "embed_model_available": config.embed_model in available_models,
    }


class IngestRequest(BaseModel):
    case_id: str
    doc_paths: list[str] | None = None  # if None, ingest everything under data/cases/<case_id>/documents/


class AskRequest(BaseModel):
    case_id: str
    question: str
    top_k: int = 8


@app.post("/ingest")
def ingest(
    req: IngestRequest,
    config: ClientConfig = Depends(get_config),
    embedder: EmbeddingFunction = Depends(get_embedder),
):
    paths = [Path(p) for p in req.doc_paths] if req.doc_paths else None
    try:
        return ingest_case_documents(req.case_id, config, embedder, doc_paths=paths)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.post("/ask")
def ask(
    req: AskRequest,
    config: ClientConfig = Depends(get_config),
    embedder: EmbeddingFunction = Depends(get_embedder),
    generator=Depends(get_generator),
):
    try:
        result = ask_case_question(req.case_id, req.question, config, embedder, generator, top_k=req.top_k)
    except OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    return {"answer": result.answer, "sources": [asdict(s) for s in result.sources]}
