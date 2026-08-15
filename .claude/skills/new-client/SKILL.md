---
name: new-client
description: Onboard a new client (branding + first case) for the sanaku-case-intel project
argument-hint: "[firm name] [colors/logo/case-id/docs path — any subset, or leave blank to be asked]"
---

This command operates on the `sanaku-case-intel/` sub-project. Every path
and command below is relative to it, not to this repo's root — start by
running:

```
cd sanaku-case-intel
```

Then follow these exact instructions (mirrors
`sanaku-case-intel/.claude/skills/new-client/SKILL.md`, the source of
truth this file is kept in sync with — that copy is also what ships
inside every future client bundle via `scripts/package-release.sh`):

You are onboarding a new client for this case-research tool. Follow
`docs/new-client-playbook.md` exactly — it is the single source of truth
for this flow. If anything below conflicts with it, the playbook wins.

**Step 0 — figure out what's already known.**

Arguments given with this command: $ARGUMENTS

From that text, extract whatever is explicitly given for:
- Firm name
- Brand colors: primary / secondary / accent, as hex codes (e.g. `#0B3D2E`)
- Logo file path (optional — omitting it is a normal, expected path)
- First case ID (lowercase, underscores, no spaces — e.g. `smith_v_acme`)
- Where their case documents currently live (a folder path), or an
  explicit statement that documents aren't ready yet

Do **not** invent, guess, or default any of these, with two exceptions:
- Brand colors may fall back to this project's existing defaults, but
  only if the user explicitly says to use the defaults — never pick
  colors yourself.
- No logo is a valid, intended answer (the header shows firm initials).

For anything not already given in $ARGUMENTS, ask the user for it
directly — one question at a time is fine. Do not move to Step 1 until
you have an explicit answer (or explicit "use defaults" / "no logo yet" /
"documents not ready yet") for every item above.

**Step 1 — confirm before touching anything.**

Restate back to the user exactly what you're about to run: the full
`scripts/new-client.sh` command line with every flag filled in (and
which flags you're omitting, e.g. `--logo`), plus whether
`scripts/setup.sh` needs to run first (ask if you don't already know
this machine's setup state). Wait for explicit confirmation before
running anything — this writes `config/client.json` (backing up any
existing one first), so it's worth getting a yes even when every value
came in via $ARGUMENTS.

**Step 2 — run it.**

1. If this machine hasn't been set up before (or the user wasn't sure
   and asked you to check), run `bash scripts/setup.sh` first and
   resolve anything it flags — see `docs/installation-guide.md`.
2. Run `scripts/new-client.sh` non-interactively, with every value as a
   flag (interactive prompts won't work over this connection):
   ```
   bash scripts/new-client.sh --firm-name "..." --primary "#hex" --secondary "#hex" --accent "#hex" --case-id some_id [--logo /path]
   ```
3. Confirm it reported success and created
   `data/cases/<case_id>/documents/`.

**Step 3 — documents, if they're ready.**

- If a documents path was given: copy the files into
  `data/cases/<case_id>/documents/`, then run
  `python3 cli.py ingest --case-id <case_id>` and report the result
  (documents/chunks counts) — this is exactly what `/ingest` does, so
  you can also just tell the user to run `/ingest <case_id>` instead.
- If documents aren't available yet: stop here. Tell the user exactly
  where to put them (`data/cases/<case_id>/documents/`) and that ingest
  (this step, or `/ingest`) must be run afterward — nothing watches that
  folder automatically.

**Step 4 — verify, only if documents were ingested.**

Prefer verifying via the CLI rather than starting the full web app
yourself: run
`python3 cli.py ask --case-id <case_id> --question "<a real question about one of their documents>"`
(same orchestration code the API uses — see `cli.py`'s own docstring)
and confirm the returned citation (document + page) is correct. Do
**not** run `scripts/dev.sh` yourself as a blocking foreground command —
it's designed to be started and Ctrl+C'd by a human in their own
terminal (see its comments), not driven by an agent's Bash tool. If the
user wants to see it running live in the actual UI, tell them to run
`bash scripts/dev.sh` themselves; don't run it on their behalf.

**Step 5 — report back.**

Summarize exactly what you did, in order, and anything still
outstanding (documents not yet supplied, voice setup not covered by this
flow, etc.).
