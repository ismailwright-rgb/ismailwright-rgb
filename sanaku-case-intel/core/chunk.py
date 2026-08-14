"""Page-aware chunking: split extracted page text into retrieval-sized
chunks, preserving the page number on every single chunk.

Deliberately does not use tiktoken — it fetches its BPE encoding files
over the network on first use, which would quietly violate this project's
first guardrail ("everything runs locally"). A char-count heuristic
(len(text) // 4) is close enough for sizing chunks; it doesn't need to be
exact, just consistent.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from core.ingest import PageText

SourceType = Literal["digital", "scanned", "manual"]
DateConfidence = Literal["exact", "approximate", "undated"]


@dataclass
class Chunk:
    case_id: str
    doc_id: str
    doc_name: str
    page: int
    chunk_index: int
    source_type: SourceType
    event_date: str | None
    date_confidence: DateConfidence
    human_entered: bool
    text: str


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


def chunk_pages(
    case_id: str,
    doc_id: str,
    doc_name: str,
    pages: list[PageText],
    target_tokens: int = 650,
    overlap_tokens: int = 80,
) -> list[Chunk]:
    """Split each page's text into ~target_tokens-sized chunks with a small
    overlap, never crossing a page boundary — every chunk's page number
    must be unambiguous, so a chunk is never allowed to span two pages.

    event_date/date_confidence/human_entered are schema-complete here but
    not populated by any date-extraction logic in this phase — they default
    to None/"undated"/False. No date-extraction requirement exists yet in
    Phases 0-3 of the build; this is a deliberate scoping line, not an
    oversight, and a natural candidate for a later phase (paralegal manual
    entry already has its own date fields, per core/chunk.py's schema
    matching that spec exactly).
    """
    chunks: list[Chunk] = []
    target_words = max(1, int(target_tokens * 0.75))  # ~0.75 words/token, rough English average
    overlap_words = max(0, int(overlap_tokens * 0.75))

    for pg in pages:
        words = pg.text.split()
        if not words:
            continue
        idx = 0
        i = 0
        step = max(1, target_words - overlap_words)
        while i < len(words):
            piece = words[i : i + target_words]
            chunks.append(
                Chunk(
                    case_id=case_id,
                    doc_id=doc_id,
                    doc_name=doc_name,
                    page=pg.page,
                    chunk_index=idx,
                    source_type=pg.source_type,
                    event_date=None,
                    date_confidence="undated",
                    human_entered=False,
                    text=" ".join(piece),
                )
            )
            idx += 1
            i += step
    return chunks
