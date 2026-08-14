#!/usr/bin/env python3
"""Minimal CLI so the answer engine can be exercised without the web UI.

This is what you actually run by hand on the target machine (once Ollama
is installed and the configured models are pulled) for the real Phase 3
demo:

    python3 cli.py ingest --case-id maria_delgado
    python3 cli.py ask --case-id maria_delgado \\
        --question "What did the treating physician say about causation?"

Calls core.* functions directly, no HTTP round-trip — same orchestration
functions api/main.py's routes use, imported straight from there so the
logic exists in exactly one place.
"""
from __future__ import annotations

import argparse
import sys

from api.main import ask_case_question, ingest_case_documents
from core.config import load_config
from core.embed import OllamaEmbedder, OllamaError
from core.generate import generate_answer


def cmd_ingest(args: argparse.Namespace) -> int:
    config = load_config()
    embedder = OllamaEmbedder(model=config.embed_model)
    try:
        result = ingest_case_documents(args.case_id, config, embedder)
    except (FileNotFoundError, OllamaError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    print(f"Ingested {result['documents_ingested']} document(s), "
          f"{result['chunks_stored']} chunk(s) stored for case '{args.case_id}'.")
    return 0


def cmd_ask(args: argparse.Namespace) -> int:
    config = load_config()
    embedder = OllamaEmbedder(model=config.embed_model)
    try:
        result = ask_case_question(
            args.case_id, args.question, config, embedder, generate_answer, top_k=args.top_k
        )
    except OllamaError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

    print(result.answer)
    print()
    print("Sources:")
    for s in result.sources:
        flag = " (human-entered)" if s.human_entered else ""
        print(f"  - {s.doc_name}, p.{s.page} [{s.source_type}, {s.date_confidence}]{flag}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Sanaku Case-Intel CLI")
    sub = parser.add_subparsers(dest="command", required=True)

    p_ingest = sub.add_parser("ingest", help="Ingest all documents for a case")
    p_ingest.add_argument("--case-id", required=True)
    p_ingest.set_defaults(func=cmd_ingest)

    p_ask = sub.add_parser("ask", help="Ask a question about a case")
    p_ask.add_argument("--case-id", required=True)
    p_ask.add_argument("--question", required=True)
    p_ask.add_argument("--top-k", type=int, default=8)
    p_ask.set_defaults(func=cmd_ask)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
