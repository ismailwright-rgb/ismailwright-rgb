# New client playbook

The goal of everything in this file: onboarding a new client should never
again be the strenuous, from-scratch process the very first install was.
It should be "run two scripts with this client's details, drop in their
documents, done." Everything below is what makes that true.

## The two things that never change between clients

1. **The code.** Every client runs the exact same application — nothing
   in `core/`, `api/`, or `web/` is ever hand-edited per client.
2. **The install process.** `scripts/setup.sh` (once per machine) →
   `scripts/new-client.sh` (once per client) → `scripts/dev.sh` (every
   time it's started). Same three commands, every single time.

**The only thing that changes per client** is what `scripts/new-client.sh`
asks for: firm name, three brand colors, an optional logo, and their
first case's documents. That's the entire customization surface, by
design — see `README.internal.md`'s white-label guardrail for why
nothing else is meant to vary.

## Building a shippable bundle

From a working checkout, any time you want a clean copy to hand off:

```bash
bash scripts/package-release.sh
```

This produces a single zip under `dist/` containing exactly what a new
machine needs — nothing environment-specific (no `.venv-dev`, no
`node_modules`, no previous client's `config/client.json` or `data/`)
rides along, because it's built from `git archive`, which only ever
includes what's actually tracked in this repository. See the script's
own comments for exactly why that guarantee holds. Re-run it any time
the codebase itself has moved forward and you want a fresh bundle to
onboard the next client from.

## Onboarding one new client, start to finish

**On a brand-new machine** (first client ever installed there):

```bash
unzip sanaku-case-intel-<label>.zip
cd sanaku-case-intel
bash scripts/setup.sh
```

`scripts/setup.sh` is safe to run again even if some of this was already
done — it reports status per step rather than redoing completed work
blindly. See `docs/installation-guide.md` for what it checks and what to
do if it flags something (most commonly: Ollama needs installing, or its
two models need pulling).

**Then, for this specific client** (this is the step that actually
changes every time):

```bash
bash scripts/new-client.sh \
  --firm-name "Their Firm Name LLP" \
  --primary "#0B3D2E" \
  --secondary "#C9A24B" \
  --accent "#F4F1EA" \
  --case-id their_first_case \
  --logo /path/to/their/logo.png   # optional — omit and the header shows their initials instead
```

Run it with no flags at all from a real terminal and it prompts for each
value instead — useful the first few times, until the flag form becomes
second nature. It writes `config/client.json`, validates it the same way
the server itself does, and creates
`data/cases/their_first_case/documents/` ready for their files. If a
`config/client.json` already exists (re-running this on a machine that
had a previous client on it), it's backed up first, never silently
overwritten.

**Load their documents and start it up:**

```bash
cp /wherever/their/files/are/*.pdf data/cases/their_first_case/documents/
python3 cli.py ingest --case-id their_first_case   # or /ingest their_first_case in a Claude Code session
bash scripts/dev.sh
```

**Confirm it before handing it off**: open the app, ask a real question
about one of their documents, confirm the answer cites the right page.
Then give the client `docs/user-guide.md` — the one document in this
project actually written for them; everything else here is internal.

**Optional — voice**: if this client wants voice, that's the one step
`scripts/new-client.sh` doesn't automate (it needs a real one-time model
download). See `docs/installation-guide.md`'s "Optional: set up voice"
step — it's the same two commands for every client, run once per
machine, not per client.

## Slash commands

If you're running this inside a Claude Code session with this repo
open, you don't need to copy-paste anything below — just run:

- **`/new-client`** — optionally with the firm's details already typed
  after it (e.g. `/new-client Smith & Associates LLP, #0B3D2E #C9A24B
  #F4F1EA, case id smith_v_acme`) — asks for whatever's missing, confirms
  the exact command it's about to run before touching anything, then
  walks the whole onboarding flow above.
- **`/ingest <case-id>`** — re-indexes a case's documents any time files
  are added, removed, or changed in its `documents/` folder. This is the
  one to reach for any time you're not sure whether a newly-added
  document is actually searchable yet — nothing watches that folder on
  its own, so this is the step that makes new files count.

Both are project-scoped commands defined under `.claude/commands/` in
this repo, which means they're plain tracked files —
`scripts/package-release.sh` sweeps them into every future client
bundle automatically via `git archive`, the same way the rest of this
playbook does, with no extra step required.

## The reusable prompt

For contexts without slash-command support — pasting into a plain web
chat, or any session where this repo's `.claude/commands/` folder isn't
loaded — hand this whole checklist to an AI assistant instead by pasting
this in, filled out for the client at hand. Inside Claude Code with this
repo checked out, prefer `/new-client` above instead.

> I'm setting up this case-research tool for a new client. Follow
> `docs/new-client-playbook.md` exactly. Their details:
> - Firm name: **\<firm name\>**
> - Brand colors (primary/secondary/accent hex): **\<colors, or "use the
>   defaults if none given"\>**
> - Logo file: **\<path, or "none yet — use their initials for now"\>**
> - First case ID: **\<case_id\>**
>
> Run `scripts/setup.sh` if this machine hasn't been set up before, then
> `scripts/new-client.sh` with those details. Their case documents are
> at: **\<path to their files, or "not available yet — stop after setup
> and tell me where to put them"\>**. If documents are available, ingest
> them and start the app with `scripts/dev.sh`, then confirm it works by
> asking a real question about one of their documents and checking the
> citation is correct. Report back what you did and anything that needs
> my attention — don't invent branding details I didn't give you.

This is deliberately the same shape as the checklist above — the prompt
just hands the mechanical steps to the assistant instead of you typing
them, while keeping every actual decision (branding, whether documents
are ready yet) explicit rather than guessed.

## Testing the current codebase live, right now

Not a new-client task — this is what to run on a machine that already
has this project installed, to pull the latest code and try it, exactly
as it stands today:

```bash
cd sanaku-case-intel
git pull origin claude/n8n-prospect-tiering-hgkjb0
bash scripts/setup.sh
bash scripts/dev.sh
```

`scripts/setup.sh` is quick and safe to run every time before
`scripts/dev.sh` — it re-validates config and re-checks ports rather than
assuming nothing changed since last time, and won't redo anything that's
already correctly in place.
