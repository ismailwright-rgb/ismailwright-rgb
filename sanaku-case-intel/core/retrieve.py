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
