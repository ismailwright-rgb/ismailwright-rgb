"""The cited-answer engine: passes retrieved passages + question to a local
Ollama model under the strict citation contract in prompts/answer_contract.txt.

An answer with no citations is a bug, not an acceptable output — the
contract text is what enforces this on the model side; this module's job
is just to assemble the prompt correctly and parse the response, not to
police citations after the fact (that would mean silently trusting the
model to have already gotten it right, which is exactly the assumption
this whole project exists to not make... but automated citation
verification against retrieved passages is a natural hardening step for a
later phase, not Phase 3's scope).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, asdict
from pathlib import Path

import httpx

from core.embed import DEFAULT_OLLAMA_URL, OllamaError, OllamaUnavailableError
from core.retrieve import RetrievedChunk

CONTRACT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "answer_contract.txt"


@dataclass
class AnswerResult:
    answer: str
    sources: list[RetrievedChunk]

    def to_dict(self) -> dict:
        return {"answer": self.answer, "sources": [asdict(s) for s in self.sources]}


def build_user_prompt(question: str, passages: list[RetrievedChunk]) -> str:
    lines = [f"QUESTION: {question}", "", "PASSAGES:"]
    if not passages:
        lines.append("(no passages retrieved — this case may not be ingested yet)")
        return "\n".join(lines)
    for i, p in enumerate(passages, start=1):
        flags = []
        if p.human_entered:
            flags.append("human_entered")
        if p.date_confidence != "exact":
            flags.append(f"date_confidence={p.date_confidence}")
        flag_str = f", {', '.join(flags)}" if flags else ""
        citation = f"[{p.doc_name}, p.{p.page}]"
        # "Passage N" is a locator so the model can find this block in the
        # list; "cite this as [doc_name, p.X]" is the only string that
        # should ever end up in the answer. Keeping the citation-ready text
        # separate from the list index (rather than leading with "[N] ...")
        # is what stops the model from citing the list position itself -
        # confirmed live: an earlier version of this prompt led exactly to
        # that failure mode ("(passage [2], p.3)" instead of the contract's
        # required format).
        lines.append(
            f"Passage {i} — cite this as {citation} "
            f"(source_type={p.source_type}{flag_str})\n{p.text}\n"
        )
    return "\n".join(lines)


def generate_answer(
    question: str,
    passages: list[RetrievedChunk],
    model: str,
    base_url: str = DEFAULT_OLLAMA_URL,
    timeout: float = 180.0,
    client: httpx.Client | None = None,
) -> AnswerResult:
    http = client or httpx.Client(base_url=base_url, timeout=timeout)
    contract = CONTRACT_PATH.read_text()
    user_prompt = build_user_prompt(question, passages)

    try:
        resp = http.post(
            "/api/chat",
            json={
                "model": model,
                "stream": False,
                "messages": [
                    {"role": "system", "content": contract},
                    {"role": "user", "content": user_prompt},
                ],
            },
        )
        resp.raise_for_status()
    except httpx.ConnectError as e:
        raise OllamaUnavailableError(
            f"Cannot reach Ollama at {http.base_url}. Is it running? Try: ollama serve"
        ) from e
    except httpx.HTTPStatusError as e:
        raise OllamaError(f"Ollama returned an error generating the answer: {e}") from e

    content = resp.json()["message"]["content"]
    return AnswerResult(answer=content, sources=passages)
