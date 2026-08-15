---
name: ingest
description: Ingest (re-index) a sanaku-case-intel case's documents so they become searchable
argument-hint: "[case-id]"
---

This command operates on the `sanaku-case-intel/` sub-project. Start by
running:

```
cd sanaku-case-intel
```

Then follow these exact instructions (mirrors
`sanaku-case-intel/.claude/skills/ingest/SKILL.md`, the source of truth
this file is kept in sync with — that copy is also what ships inside
every future client bundle via `scripts/package-release.sh`):

Run this after adding, removing, or changing files in a case's
`data/cases/<case_id>/documents/` folder. Nothing watches that folder
automatically — files sitting there are invisible to search until this
runs.

**Step 1 — determine the case ID.**

Arguments given: $ARGUMENTS

- If that text names a case ID directly, use it.
- If it's empty or ambiguous, list the existing case folders with
  `ls data/cases/` (note clearly if `data/cases/` doesn't exist yet or
  is empty) and ask the user which one they mean. Do not guess a case ID
  that wasn't given or confirmed.

**Step 2 — run ingest.**

Run:
```
python3 cli.py ingest --case-id <case_id>
```

**Step 3 — report the result.**

- On success, report the counts it prints:
  `Ingested N document(s), M chunk(s) stored for case '<case_id>'.`
- On failure (bad case ID, Ollama/embedding errors, etc.), show the
  actual error output and stop. Don't retry blindly or guess a fix
  without the user's input.
