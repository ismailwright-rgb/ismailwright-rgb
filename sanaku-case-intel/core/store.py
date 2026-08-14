"""Local, embedded vector store — ChromaDB persistent client, one
collection per case, stored under data/cases/<case_id>/index/. No hosted
vector database, no separate server process; this is a file on the box.
"""
from __future__ import annotations

from pathlib import Path

import chromadb

from core.chunk import Chunk


class CaseStore:
    """Wraps a single case's persistent ChromaDB collection.

    Cosine distance is used deliberately — it's the standard choice for
    text embeddings, where vector magnitude carries little meaning and
    direction (semantic similarity) is what matters.
    """

    def __init__(self, data_root: str | Path, case_id: str):
        self.case_id = case_id
        index_path = Path(data_root) / "cases" / case_id / "index"
        index_path.mkdir(parents=True, exist_ok=True)
        self._client = chromadb.PersistentClient(path=str(index_path))
        self._collection = self._client.get_or_create_collection(
            name="chunks", metadata={"hnsw:space": "cosine"}
        )

    def add_chunks(self, chunks: list[Chunk], embeddings: list[list[float]]) -> None:
        if not chunks:
            return
        if len(chunks) != len(embeddings):
            raise ValueError(f"chunks ({len(chunks)}) and embeddings ({len(embeddings)}) length mismatch")

        ids = [f"{c.doc_id}_{c.page:04d}_{c.chunk_index:03d}" for c in chunks]
        metadatas = [
            {
                "case_id": c.case_id,
                "doc_id": c.doc_id,
                "doc_name": c.doc_name,
                "page": c.page,
                "chunk_index": c.chunk_index,
                "source_type": c.source_type,
                # Chroma metadata values can't be None, so an absent date
                # becomes "" — core.retrieve turns "" back into None when
                # reading it back out, so callers never see the difference.
                "event_date": c.event_date or "",
                "date_confidence": c.date_confidence,
                "human_entered": c.human_entered,
            }
            for c in chunks
        ]
        # upsert, not add: re-ingesting a document (e.g. after a correction)
        # overwrites its existing chunks by the same deterministic id
        # instead of duplicating them.
        self._collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=[c.text for c in chunks],
            metadatas=metadatas,
        )

    def query(self, query_embedding: list[float], top_k: int = 8) -> dict:
        n = min(top_k, self._collection.count()) or 1
        return self._collection.query(query_embeddings=[query_embedding], n_results=n)

    def count(self) -> int:
        return self._collection.count()
