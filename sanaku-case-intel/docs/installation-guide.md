# Installation guide

**Audience:** whoever is setting this up on the firm's machine — that
may be you (the installer/reseller), the firm's own IT contact, or a
technically-comfortable staff member. This document names the real
software components involved, since whoever installs it needs to know
what's actually running. The separate [`user-guide.md`](user-guide.md)
is the one to hand to attorneys and paralegals — it never mentions any
of this.

## What you're installing

A private, local case-research tool. It answers questions about a case's
documents with citations back to the exact page each fact came from.
Everything — document storage, search, and answer generation — runs on
this one machine. No case material is ever sent to an outside service.
Voice input/output, if set up, is the same: local only.

This is a **single-machine, local-network tool today**, not a hosted
multi-tenant product. It's meant to run on one machine inside the firm
(an office workstation, a small dedicated server) that staff reach over
the firm's own local network. There is no user-account/login system, no
per-user permissions, and no built-in remote-access hardening — treat it
the way you'd treat any other internal-only office system, and don't
expose it directly to the open internet.

## Prerequisites

| Requirement | Why | Notes |
|---|---|---|
| macOS (or Linux) | Target platform this has been built/tested against | Runs on a Mac Mini-class machine fine — no GPU required |
| Python 3.11+ | Runs the API server | `python3 --version` to check |
| Node.js + npm | Runs the web UI's dev server | `node --version` to check |
| [Ollama](https://ollama.com) | Runs the local language model that generates answers and search embeddings | Install separately, see below |
| `tesseract-ocr` | Reads scanned/image-only PDF pages | Optional — only needed if the firm has scanned documents without a real text layer. `brew install tesseract` on a Mac |
| macOS 14 (Sonoma) or newer | **Only if setting up voice** | One of voice's dependencies (`onnxruntime`) has no wheel for older macOS |

## One-time setup

1. **Get the code onto the machine** (copy the repository, however it's
   being distributed to this install).

2. **Run the setup script** from the project's root folder:
   ```bash
   bash scripts/setup.sh
   ```
   This installs the Python dependencies, checks for Ollama, validates
   `config/client.json` if it already exists, checks for `tesseract`, and
   checks that the ports this app needs (8001, 5001) are free. It reports
   status for each step rather than stopping on the first thing that
   isn't ready yet — read its output before continuing.

3. **Install Ollama** if step 2 flagged it as missing: download from
   [ollama.com](https://ollama.com), then pull the two models this
   install is configured to use (see step 4 for where those are named):
   ```bash
   ollama pull llama3.1:8b        # or whatever config/client.json's gen_model is
   ollama pull nomic-embed-text   # or whatever embed_model is
   ollama serve                   # if it isn't already running as a background service
   ```

4. **Set up the firm's branding.** Copy the example config and edit it:
   ```bash
   cp config/client.example.json config/client.json
   ```
   Fields to set:
   - `firm_name` — shown in the app header and browser tab.
   - `colors.primary` / `colors.secondary` / `colors.accent` — the
     firm's three brand colors. Every color in the interface is derived
     from these three, so there's no other place to set a color.
   - `logo_path` — path to a logo image file, dropped in `config/assets/`.
     If left unset or the file's missing, the header shows the firm's
     initials instead of a blank space — never leaves a broken image.
   - `gen_model` / `embed_model` — the two Ollama model names pulled in
     step 3. Only change these if you deliberately pulled different
     models.
   - Leave `data_root` as `data` unless there's a specific reason to
     store case files somewhere else on this machine.

   Re-run `bash scripts/setup.sh` after editing — it validates the file
   and tells you plainly if something's wrong with it (a typo'd field
   name, a missing required value) instead of leaving that to surface
   later as a confusing error inside the app.

5. **Load the firm's first case.** Case documents live under
   `data/cases/<case_id>/documents/` — create that folder for each case
   and drop in the PDFs (born-digital or scanned, both work). Then
   ingest them:
   ```bash
   python3 cli.py ingest --case-id <case_id>
   ```
   Re-run the same command any time new documents are added to that
   case's folder — it's safe to run repeatedly; already-ingested pages
   aren't duplicated.

6. **Optional: set up voice** (lets staff ask questions by speaking and
   have answers read back). Skip this step entirely if the firm doesn't
   want it — everything else works fully without it.
   ```bash
   pip install -r requirements-voice.txt
   python3 -m piper.download_voices en_US-lessac-medium \
     --data-dir ~/.local/share/sanaku-case-intel/piper-voices
   ```
   That's the only manual voice step — see "Starting it up" below for
   how the voice service itself gets started.

## Starting it up

One command, one terminal, run from the project's root folder:

```bash
bash scripts/dev.sh
```

This starts everything the app needs — the API server, the web
interface, and (if step 6 above was done) the voice service — checks
each one actually comes up before saying so, and opens the app in the
default browser automatically. Staff reach it at the printed
`localhost:5173` address, or via this machine's local network address if
it's meant to be reached from another computer on the same network.

**To stop everything:** press Ctrl+C in that same terminal window. It
shuts every server down cleanly — nothing is left running in the
background.

**Every time the machine restarts**, or a new terminal session starts,
running `bash scripts/dev.sh` again is the entire process — there's
nothing else to remember to start separately.

## Troubleshooting

**"`.venv-dev` not found"** — the one-time setup script (`scripts/setup.sh`)
hasn't been run yet, or was run somewhere else. Run it from this
project's own root folder.

**"config/client.json exists but isn't valid"** — the file has a typo or
a missing required field. The exact error printed names the problem
field; fix it and try again. `config/client.example.json` is always a
known-good reference to compare against.

**"something is already listening on port 8001" (or 5001)** — some other
program on this machine is already using a port this app needs. This has
happened for real, twice, on real hardware, and both times it was an
unrelated program, not a bug in this app:
- Port 8001: on the very first version of this app (before it moved off
  the more common port 8000), an unrelated background process was found
  squatting on port 8000, silently answering every request with its own
  unrelated 404 page. Every symptom that produced — a missing case list,
  broken voice transcription — looked exactly like this app was broken.
  It wasn't; something else was answering instead of it.
- Port 5001: on a Mac, this is one port away from 5000, which macOS's own
  **AirPlay Receiver** feature listens on by default. If voice ever
  reports a plain "403 Forbidden" instead of "can't connect," that's the
  signature of something else answering on that port, not this app's own
  voice service refusing the request.
- Either way: `lsof -i :<port>` shows exactly what's using it. If it's
  something you don't recognize and don't need, stop it. If it's
  something that has to stay running, the fix already built into this
  app is to move off that port — ask for help doing that rather than
  fighting to free a port something else insists on using.

**"Ollama took too long to respond"** or **"Ollama returned an error"**
— usually a one-time model cold-start (the first request after Ollama
starts can be slow while it loads the model into memory) — the next
question typically works fine. If it keeps happening, confirm Ollama is
actually running: `ollama serve` (or check it's running as a background
service) and that the two configured models were actually pulled
(`ollama pull <model name>` for each, from `config/client.json`).

**A case doesn't show up in the case picker** — case listing is based on
that case's `documents/` folder existing under `data/cases/<case_id>/`.
Confirm the folder exists and has at least one file in it, and that
`python3 cli.py ingest --case-id <case_id>` has actually been run against
it.

**Scanned documents come back with garbled or missing text** —
`tesseract-ocr` isn't installed. `bash scripts/setup.sh` reports this
plainly as a warning; install it (`brew install tesseract` on a Mac) and
re-run ingestion for the affected case.

## What this is, and isn't, today

Worth setting expectations plainly rather than leaving them to be
discovered:

- **No login/user accounts.** Anyone who can reach this machine on its
  local network can use it. Keep it on a network the firm actually
  trusts, the same way you'd treat any other internal-only tool.
- **One machine, not a hosted service.** There's no cloud backup, no
  multi-location sync. If this machine is lost, whatever wasn't
  otherwise backed up (the original case documents, and this app's own
  search index) goes with it — worth folding into whatever backup
  routine this machine already has.
- **Dev-mode servers.** The web/API servers started by `scripts/dev.sh`
  are the same ones used throughout this project's own development —
  well-tested for correctness, but not hardened the way a
  public-internet-facing production deployment would need to be. That's
  fine for the local-network-only use this is designed for; it is not
  meant to be exposed directly to the open internet.
- **Voice is optional and genuinely local**, but needs real testing on
  the actual machine and room it'll be used in — background noise,
  microphone quality, and accent/pronunciation all affect how reliably
  it picks up speech. Try it in the actual room before relying on it.
