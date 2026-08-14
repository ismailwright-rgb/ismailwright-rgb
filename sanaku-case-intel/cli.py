#!/usr/bin/env python3
"""Minimal CLI so the answer engine can be exercised without the web UI.

This is what you actually run by hand on the target machine (once Ollama
is installed and the configured models are pulled) for the real Phase 3
demo:

    python3 cli.py ingest --case-id maria_delgado
    python3 cli.py ask --case-id maria_delgado \\
        --question "What did the treating physician say about causation?"

Phase 5 (paralegal manual-entry) added a third subcommand:

    python3 cli.py manual-entry --case-id maria_delgado \\
        --label "Phone call with client, 3/10/2024" \\
        --text "Client confirmed no prior lower-back injury before the collision." \\
        --event-date 2024-03-10

Calls core.* functions directly, no HTTP round-trip — same orchestration
functions api/main.py's routes use, imported straight from there so the
logic exists in exactly one place.
"""
from __future__ import annotations

import argparse
import sys

from api.main import add_manual_entry, ask_case_question, ingest_case_documents
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


def cmd_manual_entry(args: argparse.Namespace) -> int:
    config = load_config()
    embedder = OllamaEmbedder(model=config.embed_model)
    date_confidence = args.date_confidence if args.event_date else "undated"
    try:
        result = add_manual_entry(
            args.case_id,
            config,
            embedder,
            args.text,
            args.label,
            event_date=args.event_date,
            date_confidence=date_confidence,
        )
    except (OllamaError, ValueError) as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    print(f"Saved manual entry '{result['doc_name']}' for case '{args.case_id}'.")
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

    p_manual = sub.add_parser("manual-entry", help="Add a staff-entered fact/note as a citable source")
    p_manual.add_argument("--case-id", required=True)
    p_manual.add_argument("--label", required=True, help="Short citation label, e.g. 'Phone call with client, 3/10/2024'")
    p_manual.add_argument("--text", required=True, help="The fact/note itself")
    p_manual.add_argument("--event-date", default=None, help="ISO date (YYYY-MM-DD) this fact concerns, if known")
    p_manual.add_argument(
        "--date-confidence", default="exact", choices=["exact", "approximate"],
        help="Ignored if --event-date is omitted (always stored as 'undated' in that case)",
    )
    p_manual.set_defaults(func=cmd_manual_entry)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
