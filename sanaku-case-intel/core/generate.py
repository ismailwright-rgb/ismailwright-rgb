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

import json
import os
from collections.abc import Iterator
from dataclasses import dataclass, asdict
from pathlib import Path

import httpx

from core.embed import DEFAULT_OLLAMA_URL, OLLAMA_KEEP_ALIVE, OllamaError, OllamaUnavailableError
from core.retrieve import ConversationTurn, RetrievedChunk

CONTRACT_PATH = Path(__file__).resolve().parent.parent / "prompts" / "answer_contract.txt"
# Read once at import time, not on every call - real bug found in a
# latency pass: generate_answer/stream_answer both re-read this file from
# disk on every single request. File I/O is cheap next to a model call,
# but it's redundant work with zero upside (the file never changes at
# runtime) - free to remove.
ANSWER_CONTRACT = CONTRACT_PATH.read_text()

# Real, confirmed latency bug, not a guess: history was unbounded - every
# prior turn's full question AND answer text got inlined into every
# prompt with no limit, so a session's prompt (and generation time) grew
# every single turn, working directly against the "ongoing conversation"
# hands-free feature (web/src/App.jsx) that actively encourages longer
# sessions. Capped here, server-side, as a backstop regardless of what any
# caller sends - web/src/App.jsx caps the same way client-side (its own
# MAX_HISTORY_TURNS) before the request is even built, so this is
# defense-in-depth, not the only place it's enforced. This is a real
# product trade-off, not a pure performance tweak: a question that
# depends on something asked more than 8 turns back loses that context -
# picked after weighing that trade-off directly, not assumed. Deliberately
# a different value from core/retrieve.py's build_retrieval_query
# max_prior_turns=2 - that cap only needs enough to disambiguate a short
# follow-up ("what about her prior injuries?"), while this one is meant to
# give the model real conversational continuity across a longer session,
# a different job with a different right answer.
MAX_HISTORY_TURNS = 8

# Real risk found while tightening latency, worse than a latency issue on
# its own: neither generate_answer nor stream_answer ever told Ollama how
# large a context window to use, so Ollama's own default applied instead
# (historically 2048 tokens unless overridden, though this varies by
# Ollama version - genuinely uncertain without live confirmation, not
# guessed either way). A too-small context window doesn't just slow
# things down, it SILENTLY TRUNCATES the prompt - and if that truncation
# eats the system message (this app's own citation contract) or early
# passages, the model can end up answering without the rules that keep
# citations honest, or without passages it was supposed to ground the
# answer in. That's a correctness risk, not just a performance one.
#
# Sized deliberately, not guessed: worst case today is the answer
# contract (~700 tokens) + up to 8 retrieved passages at ~650 tokens each
# (core/chunk.py's own chunk-size target) plus per-passage headers (~5,600
# tokens) + up to MAX_HISTORY_TURNS=8 prior turns, each a real question
# and a real multi-point cited answer (~2,600 tokens) + the current
# question + real headroom for the model's own reply, since num_ctx has
# to cover the completion too, not just the prompt (~600 tokens). That's
# roughly 9,500 tokens on paper; 12,288 leaves comfortable margin above
# that estimate (chunking's own token count is itself an approximation -
# len(text)//4 - not an exact tokenizer count) without being wastefully
# large the way an arbitrary "just make it huge" value would be - a
# bigger context window than needed has its own real cost (more KV-cache
# memory, slower per-token generation), so this is sized to the actual
# computed ceiling, not padded past it for no reason.
OLLAMA_NUM_CTX = int(os.environ.get("OLLAMA_NUM_CTX", "12288"))


@dataclass
class AnswerResult:
    answer: str
    sources: list[RetrievedChunk]

    def to_dict(self) -> dict:
        return {"answer": self.answer, "sources": [asdict(s) for s in self.sources]}


def build_user_prompt(
    question: str,
    passages: list[RetrievedChunk],
    history: list[ConversationTurn] | None = None,
) -> str:
    lines = []
    if history:
        # Only emitted when history is non-empty, so a single-turn request
        # produces byte-identical output to before this existed - see
        # tests/test_generate_prompt.py's regression test for that. The
        # "per Rule 5... Not a source" label cross-references
        # prompts/answer_contract.txt's rule 5 right where the history
        # actually appears - the same belt-and-suspenders shape already
        # used below for "Passage N is a locator, not a citation".
        #
        # Capped to the most recent MAX_HISTORY_TURNS - see that
        # constant's own comment for the real latency bug this fixes and
        # the trade-off it accepts. Oldest turns drop off first; this only
        # changes anything once a session actually exceeds the cap, so
        # every existing small-history test stays byte-identical.
        capped_history = history[-MAX_HISTORY_TURNS:]
        lines.append(
            "CONVERSATION HISTORY (earlier turns in this session - context "
            "only, per Rule 5. Not a source: every claim below must still "
            "be cited to a PASSAGE, never to this history):"
        )
        for turn in capped_history:
            lines.append(f"Q: {turn.question}")
            lines.append(f"A: {turn.answer}")
        lines.append("")
    lines += [f"QUESTION: {question}", "", "PASSAGES:"]
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
    history: list[ConversationTurn] | None = None,
) -> AnswerResult:
    http = client or httpx.Client(base_url=base_url, timeout=timeout)
    user_prompt = build_user_prompt(question, passages, history=history)

    try:
        resp = http.post(
            "/api/chat",
            json={
                "model": model,
                "stream": False,
                "keep_alive": OLLAMA_KEEP_ALIVE,
                "options": {"num_ctx": OLLAMA_NUM_CTX},
                "messages": [
                    {"role": "system", "content": ANSWER_CONTRACT},
                    {"role": "user", "content": user_prompt},
                ],
            },
        )
        resp.raise_for_status()
    except httpx.ConnectError as e:
        raise OllamaUnavailableError(
            f"Cannot reach Ollama at {http.base_url}. Is it running? Try: ollama serve"
        ) from e
    except httpx.TimeoutException as e:
        raise OllamaUnavailableError(
            "Ollama took too long to respond (model cold-start can be slow "
            "the first time) - try again."
        ) from e
    except httpx.HTTPStatusError as e:
        raise OllamaError(f"Ollama returned an error generating the answer: {e}") from e

    content = resp.json()["message"]["content"]
    return AnswerResult(answer=content, sources=passages)


def stream_answer(
    question: str,
    passages: list[RetrievedChunk],
    model: str,
    base_url: str = DEFAULT_OLLAMA_URL,
    timeout: float = 180.0,
    client: httpx.Client | None = None,
    history: list[ConversationTurn] | None = None,
) -> Iterator[str]:
    """Same prompt, same contract, same citation guarantees as
    generate_answer - the only difference is *when* the caller gets the
    text: this yields it incrementally as Ollama produces it (`"stream":
    True`) instead of blocking until the entire completion has landed.

    Real motivation, not a nice-to-have: waiting for a full non-streamed
    completion from an 8B model on ordinary hardware before showing
    anything is genuinely slow, and it reads to the person waiting as
    "did this hang?" rather than "this is working." Streaming doesn't
    make the model faster, but it moves time-to-first-visible-text from
    "the whole answer's generation time" down to roughly one token's
    worth - see api/main.py's POST /ask/stream for the other half of
    this (retrieved sources are sent to the client before generation
    even starts, since retrieval is the fast part).

    Ollama's own streaming /api/chat shape (same endpoint as the
    non-streaming call above, just with stream: true instead of false):
    one JSON object per line, each with a `message.content` delta and a
    `done` flag that's only true on the final line - verified against
    the same upstream contract generate_answer already relies on for the
    non-streaming case, not guessed from scratch.
    """
    http = client or httpx.Client(base_url=base_url, timeout=timeout)
    user_prompt = build_user_prompt(question, passages, history=history)

    try:
        with http.stream(
            "POST",
            "/api/chat",
            json={
                "model": model,
                "stream": True,
                "keep_alive": OLLAMA_KEEP_ALIVE,
                "options": {"num_ctx": OLLAMA_NUM_CTX},
                "messages": [
                    {"role": "system", "content": ANSWER_CONTRACT},
                    {"role": "user", "content": user_prompt},
                ],
            },
        ) as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line:
                    continue
                event = json.loads(line)
                delta = event.get("message", {}).get("content", "")
                if delta:
                    yield delta
                if event.get("done"):
                    break
    except httpx.ConnectError as e:
        raise OllamaUnavailableError(
            f"Cannot reach Ollama at {http.base_url}. Is it running? Try: ollama serve"
        ) from e
    except httpx.TimeoutException as e:
        raise OllamaUnavailableError(
            "Ollama took too long to respond (model cold-start can be slow "
            "the first time) - try again."
        ) from e
    except httpx.HTTPStatusError as e:
        raise OllamaError(f"Ollama returned an error generating the answer: {e}") from e
