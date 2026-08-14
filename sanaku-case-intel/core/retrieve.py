"""Question -> top-K relevant passages, with full metadata/page tags
attached. This is the half of the pipeline that finds candidate evidence;
core.generate is what turns it into a cited answer.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from core.embed import EmbeddingFunction
from core.store import CaseStore


@dataclass
class RetrievedChunk:
    doc_id: str
    doc_name: str
    page: int
    chunk_index: int
    source_type: str
    event_date: str | None
    date_confidence: str
    human_entered: bool
    text: str
    distance: float


@dataclass
class ConversationTurn:
    """One prior question/answer pair from the same browser-tab session.
    Defined here (not core/generate.py, which is where it's mostly used)
    specifically so core/generate.py can import it from here the same way
    it already imports RetrievedChunk - core.generate depends on
    core.retrieve, never the reverse, and this keeps that direction
    intact instead of introducing a circular import."""

    question: str
    answer: str


def build_retrieval_query(
    question: str,
    history: list[ConversationTurn] | None = None,
    max_prior_turns: int = 2,
) -> str:
    """Folds recent prior *questions* (never answers - those are already
    citation-laden and would skew the embedding toward whatever was
    already retrieved last turn, not toward what's actually being asked
    now) into the retrieval query text, so a short elliptical follow-up
    like "what about her prior injuries?" has a real chance of surfacing
    the right passages on its own.

    Deliberately a cheap heuristic (string concatenation), not an LLM
    query-rewrite call - this app already pays embed + generate latency
    on local CPU/GPU with no cloud elasticity to absorb a third local-
    model round trip per question. Isolated in its own function
    specifically so it can be swapped for an LLM-condensation
    implementation later without touching retrieve_passages' or
    ask_case_question's signatures, if real follow-up questions turn out
    to need it - that's a live-embeddings question no offline test can
    settle, see README.internal.md.
    """
    if not history:
        return question
    prior_questions = " ".join(t.question for t in history[-max_prior_turns:])
    return f"{prior_questions} {question}"


def retrieve_passages(
    case_id: str,
    question: str,
    embedder: EmbeddingFunction,
    data_root: str | Path,
    top_k: int = 8,
) -> list[RetrievedChunk]:
    store = CaseStore(data_root, case_id)
    if store.count() == 0:
        return []

    q_vec = embedder.embed_query(question)
    raw = store.query(q_vec, top_k=top_k)

    out: list[RetrievedChunk] = []
    docs = raw["documents"][0]
    metas = raw["metadatas"][0]
    dists = raw["distances"][0]
    for doc_text, meta, dist in zip(docs, metas, dists):
        out.append(
            RetrievedChunk(
                doc_id=meta["doc_id"],
                doc_name=meta["doc_name"],
                page=meta["page"],
                chunk_index=meta["chunk_index"],
                source_type=meta["source_type"],
                event_date=meta["event_date"] or None,
                date_confidence=meta["date_confidence"],
                human_entered=meta["human_entered"],
                text=doc_text,
                distance=dist,
            )
        )
    return out
