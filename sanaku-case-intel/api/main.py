"""FastAPI app exposing /health, /ingest, /ask, /ask/stream.

Every Ollama-dependent piece (embedder, generator) is wired in via FastAPI's
own Depends() so it can be swapped for a test double in tests/test_api.py —
production always gets the real Ollama-backed implementation; nothing in
this file special-cases "am I under test".
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import httpx
from fastapi import Depends, FastAPI, HTTPException, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from core.chunk import chunk_pages
from core.config import ClientConfig, load_config
from core.embed import DEFAULT_OLLAMA_URL, EmbeddingFunction, OllamaEmbedder, OllamaError
from core.generate import AnswerResult, generate_answer, stream_answer
from core.ingest import extract_document
from core.retrieve import ConversationTurn, build_retrieval_query, retrieve_passages
from core.speak import PiperSynthesizer, SynthesisError, Synthesizer
from core.store import CaseStore
from core.transcribe import Transcriber, TranscriptionError, WhisperTranscriber

app = FastAPI(title="Sanaku Case-Intel API")

SUPPORTED_SUFFIXES = {".pdf", ".txt"}

# This API and the web UI both run on the same machine, on-site at the firm
# - there is no multi-tenant/public-internet exposure to guard against here,
# only the browser's own same-origin restriction between Vite's dev server
# (5173) and this API (8001 - see web/vite.config.js's own comment on why
# not the more conventional 8000). Wide open on localhost is fine for
# that; this is not a public API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# The logo file itself isn't proprietary - serving it is how the browser
# actually gets a firm's branding onto the page. Nothing else in config/ is
# mounted here; model names, credentials, and license data never go near
# this route.
ASSETS_DIR = Path(__file__).resolve().parent.parent / "config" / "assets"
ASSETS_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/branding-assets", StaticFiles(directory=str(ASSETS_DIR)), name="branding-assets")


# ---- dependencies -----------------------------------------------------

def get_config() -> ClientConfig:
    try:
        return load_config()
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except ValueError as e:
        # Real gap found live: config/client.json existing was never the
        # whole story - malformed JSON (json.JSONDecodeError) or content
        # that doesn't match ClientConfig's schema (pydantic's
        # ValidationError) are both subclasses of ValueError, and neither
        # is a FileNotFoundError, so both fell through uncaught here into
        # an unhandled 500 with a plain-text body - every route that
        # depends on get_config() (which is nearly all of them, including
        # /theme and /cases) broke the same way, with no indication why.
        raise HTTPException(
            status_code=500,
            detail=f"config/client.json exists but isn't valid: {e}",
        ) from e


def get_embedder(config: ClientConfig = Depends(get_config)) -> EmbeddingFunction:
    return OllamaEmbedder(model=config.embed_model)


def get_generator():
    """Returns the real Ollama-backed generate_answer by default. Tests
    override this dependency with a fake via app.dependency_overrides."""
    return generate_answer


def get_stream_generator():
    """Returns the real Ollama-backed stream_answer by default - a
    separate seam from get_generator (not a flag on the same one) since
    the streaming and non-streaming code paths have a genuinely
    different shape, an iterator vs. a single return value. Tests
    override this dependency with a fake iterator via
    app.dependency_overrides, same pattern as every other seam here."""
    return stream_answer


def get_transcriber() -> Transcriber:
    """Returns the real local Whisper-backed transcriber by default. Tests
    override this dependency with tests/stub_transcriber.py's fake via
    app.dependency_overrides, same pattern as get_embedder/get_generator."""
    return WhisperTranscriber()


def get_synthesizer() -> Synthesizer:
    """Returns the real Piper-backed synthesizer by default - talks to a
    separate local Piper process over HTTP, never imports it (see
    core/speak.py's docstring for why). Tests override this dependency
    with tests/stub_synthesizer.py's fake via app.dependency_overrides."""
    return PiperSynthesizer()


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
    history: list[ConversationTurn] | None = None,
) -> AnswerResult:
    # The augmented query is retrieval-only plumbing - generator always
    # gets the real, original question, never the augmented one, so a
    # follow-up's retrieval-query-folding can never leak into what the
    # model is told it's being asked.
    retrieval_query = build_retrieval_query(question, history)
    passages = retrieve_passages(case_id, retrieval_query, embedder, config.data_root, top_k=top_k)
    return generator(question, passages, model=config.gen_model, history=history)


# ---- routes -------------------------------------------------------------

@app.get("/theme")
def theme(config: ClientConfig = Depends(get_config)):
    """Branding only - firm_name, a servable logo URL, and colors. This is
    the ONLY config-derived endpoint the client-facing web UI is meant to
    call. Deliberately excludes gen_model/embed_model/tier/data_root/
    license_path - the white-label guardrail (never surface the vendor
    name, model names, or architecture detail to the client) is enforced
    by what this endpoint does not return, not by UI-side discipline."""
    logo_filename = Path(config.logo_path).name
    return {
        "firm_name": config.firm_name,
        "logo_url": f"/branding-assets/{logo_filename}",
        "colors": config.colors.model_dump(),
    }


@app.get("/cases")
def list_cases(config: ClientConfig = Depends(get_config)):
    """Case IDs with a documents/ folder on this machine - lets the UI
    offer a picker instead of asking staff to type an opaque case_id."""
    cases_dir = Path(config.data_root) / "cases"
    if not cases_dir.exists():
        return {"cases": []}
    return {
        "cases": sorted(
            p.name for p in cases_dir.iterdir() if p.is_dir() and (p / "documents").exists()
        )
    }


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


class ConversationTurnIn(BaseModel):
    question: str
    answer: str


class AskRequest(BaseModel):
    case_id: str
    question: str
    top_k: int = 8
    history: list[ConversationTurnIn] = []


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
    except Exception as e:
        # Same class of gap as get_config()'s fix above, found by auditing
        # for it rather than hitting it live this time: extract_document()
        # can raise ValueError for an unsupported file type, and the real
        # PDF/OCR libraries underneath it (PyMuPDF on a corrupted PDF,
        # pytesseract if the tesseract-ocr system binary isn't installed -
        # a real first-run gap on a fresh machine, not hypothetical) can
        # raise their own exceptions that aren't FileNotFoundError or
        # OllamaError. A catch-all here specifically (not on every route)
        # is warranted: ingestion is the one place this app processes
        # arbitrary, unpredictable input files from the filesystem, so
        # "something about this document failed, here's why" is genuinely
        # useful, not a swallowed bug.
        raise HTTPException(status_code=500, detail=f"Ingestion failed: {e}") from e


@app.post("/ask")
def ask(
    req: AskRequest,
    config: ClientConfig = Depends(get_config),
    embedder: EmbeddingFunction = Depends(get_embedder),
    generator=Depends(get_generator),
):
    history = [ConversationTurn(question=t.question, answer=t.answer) for t in req.history]
    try:
        result = ask_case_question(
            req.case_id, req.question, config, embedder, generator, top_k=req.top_k, history=history
        )
    except OllamaError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        # Defensive net, same reasoning as /ingest's - anything genuinely
        # unanticipated (a malformed stored chunk, a chromadb hiccup)
        # becomes a clean 500 with the real reason instead of an opaque
        # crash a firm's staff would have no way to explain to anyone.
        raise HTTPException(status_code=500, detail=f"Something went wrong answering that: {e}") from e
    return {"answer": result.answer, "sources": [asdict(s) for s in result.sources]}


@app.post("/ask/stream")
def ask_stream(
    req: AskRequest,
    config: ClientConfig = Depends(get_config),
    embedder: EmbeddingFunction = Depends(get_embedder),
    stream_generator=Depends(get_stream_generator),
):
    """Same question/history contract as POST /ask, but the answer
    streams to the client as Ollama produces it instead of arriving all
    at once - what the web UI actually calls; /ask stays as-is for
    cli.py and anything else that wants a single blocking call.

    Retrieval (embed the query, search the local vector store) happens
    synchronously first - it's the fast part - and its sources are sent
    as the very first line, so the web UI's source panel can render
    before the answer's first word exists. Body is newline-delimited
    JSON, one object per line: {"type":"sources","sources":[...]} once,
    then {"type":"delta","text":"..."} repeated as generation produces
    text, then exactly one of {"type":"done","answer":"..."} (full
    concatenated text, for exactness) or {"type":"error","detail":"..."}
    - never both. Not Server-Sent Events (no "data:"/blank-line framing)
    since this is a POST with a JSON body, which EventSource can't send;
    plain newline-delimited JSON is simpler and web/src/App.jsx already
    has to hand-parse it with its own fetch + ReadableStream reader
    either way.

    Errors reachable only *after* streaming has begun (a generation
    failure partway through) can't become an HTTPException - the 200
    response and its headers are already committed the instant the first
    line is written, so FastAPI has no way to rewrite the status code
    after the fact. Reported as a final {"type":"error"} line instead;
    web/src/App.jsx treats it exactly like a rejected /ask, same message
    text either way. A failure caught before the first line is written
    (retrieval itself failing) is reported the same way for a uniform
    client-side error path, rather than a real HTTPException for that
    one case and a fake one for every other.
    """
    history = [ConversationTurn(question=t.question, answer=t.answer) for t in req.history]

    def event_stream():
        try:
            retrieval_query = build_retrieval_query(req.question, history)
            passages = retrieve_passages(
                req.case_id, retrieval_query, embedder, config.data_root, top_k=req.top_k
            )
        except OllamaError as e:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"
            return
        except Exception as e:
            # Same defensive net as /ask and /ingest, applied here too -
            # without this, anything other than OllamaError during
            # retrieval would propagate out of this generator and the
            # ASGI response would just cut off mid-stream with no
            # explanation, the worst version of this failure mode since
            # there's no error event at all for the client to show.
            yield json.dumps({"type": "error", "detail": f"Something went wrong answering that: {e}"}) + "\n"
            return

        yield json.dumps({"type": "sources", "sources": [asdict(s) for s in passages]}) + "\n"

        full_answer_parts = []
        try:
            for delta in stream_generator(
                req.question, passages, model=config.gen_model, history=history
            ):
                full_answer_parts.append(delta)
                yield json.dumps({"type": "delta", "text": delta}) + "\n"
        except OllamaError as e:
            yield json.dumps({"type": "error", "detail": str(e)}) + "\n"
            return
        except Exception as e:
            yield json.dumps({"type": "error", "detail": f"Something went wrong generating that: {e}"}) + "\n"
            return

        yield json.dumps({"type": "done", "answer": "".join(full_answer_parts)}) + "\n"

    return StreamingResponse(event_stream(), media_type="application/x-ndjson")


@app.post("/transcribe")
async def transcribe(
    audio: UploadFile,
    transcriber: Transcriber = Depends(get_transcriber),
):
    """Speech-to-text for the web UI's mic button - runs entirely locally
    via core/transcribe.py's Whisper model, never a cloud API. Returns the
    transcribed text for the browser to drop into the question box; it
    does not itself ask a question, the user still reviews and submits."""
    audio_bytes = await audio.read()
    try:
        text = transcriber.transcribe(audio_bytes)
    except TranscriptionError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        # Defense in depth on top of core/transcribe.py's own wrapping
        # (see its docstring) - belt-and-suspenders, not a substitute for
        # fixing the real gap at the source, same pattern as every other
        # catch-all added in this pass.
        raise HTTPException(status_code=500, detail=f"Could not transcribe that: {e}") from e
    return {"text": text}


class SpeakRequest(BaseModel):
    text: str


@app.post("/speak")
def speak(
    req: SpeakRequest,
    synthesizer: Synthesizer = Depends(get_synthesizer),
):
    """Text-to-speech for the web UI's "Listen to this answer" button -
    talks to a separate local Piper process over HTTP (core/speak.py),
    never a cloud API and never imported into this process. Returns raw
    WAV bytes for the browser to play through an <audio> element."""
    try:
        audio_bytes = synthesizer.synthesize(req.text)
    except SynthesisError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read this answer aloud: {e}") from e
    return Response(content=audio_bytes, media_type="audio/wav")
