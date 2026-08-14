# Sanaku Case-Intel — internal notes

Internal ops/dev documentation. **Not shipped to any client** — this file,
like everything under `core/` and `prompts/`, is proprietary and stays out
of any client-facing surface.

## What's built (Phases 0–3, per the build order in the master prompt)

- **Phase 0** — scaffold, `core/config.py` (per-client config loader),
  `requirements.txt`/`requirements-dev.txt`, `scripts/setup.sh`, `/health`.
- **Phase 1** — `core/ingest.py` (PyMuPDF text extraction + Tesseract OCR
  fallback for pages with no text layer), `core/chunk.py` (page-aware
  chunking, full metadata schema).
- **Phase 2** — `core/embed.py` (`OllamaEmbedder`), `core/store.py`
  (`CaseStore`, a per-case persistent ChromaDB collection).
- **Phase 3** — `prompts/answer_contract.txt`, `core/retrieve.py`,
  `core/generate.py`, `api/main.py`'s `/ingest` + `/ask`, `cli.py`. Confirmed
  live against real Ollama on real hardware (see git log for the citation-
  format fix that came out of that run) — this is the actual, working
  recordable prototype the master prompt's Phase 3 asks for.
- **Phase 4** — `web/` (React + Vite), `api/main.py`'s `/theme` + `/cases` +
  `/branding-assets` static mount + CORS. Single screen: case picker,
  question box, answer panel, a source panel beside it with every citation's
  doc + page, each expandable to the actual passage text. Themed entirely
  from `config/client.json` — no code touched to reskin it, see Phase 4
  verification below for how that was actually proven, not just claimed.
  Since extended past the initial build with a design-token/visual pass
  (derived neutrals via `color-mix()`, empty/loading states, a header
  logo-monogram fallback), a print feature (now printing the whole
  conversation, not just one answer), voice input/output (local Whisper
  + a separate local Piper process — see "Voice" below), and multi-turn
  conversation memory (see "Conversation memory" below) — all still
  Phase 4 surface, no new config schema.

**Stopped after Phase 4's core build**, per the master prompt's own build
order — Phases 5, 6, 8, 9 (paralegal manual-entry, hardware licensing/
encryption, archive, packaging) are not built. Voice was pulled forward
from Phase 7 ahead of that order at explicit request, scoped and verified
the same way everything else here has been (see "Voice" below) rather
than treated as an exception to the discipline the rest of this file
documents.

## Why some choices differ slightly from what you'd get by following an
## older tutorial

- **`chromadb==1.0.15`, not the 0.5.x line.** 0.5.x has no prebuilt macOS
  wheel and needs a Rust toolchain to build from source — a real problem on
  a firm's Mac Mini, which won't have build tooling installed. 1.0.x ships
  real `macosx_11_0_arm64` wheels.
- **No `tiktoken`.** It silently fetches its BPE encoding files over the
  network on first use — that would quietly violate guardrail #1
  ("everything runs locally"). Chunking uses a `len(text) // 4` character
  heuristic instead; it doesn't need to be exact, just consistent.
- **OCR uses PyMuPDF's own `page.get_pixmap()`**, not `pdf2image` — drops
  the poppler system dependency. The only system dependency is
  `tesseract-ocr` itself (`apt install tesseract-ocr` on Linux,
  `brew install tesseract` on macOS).

## Local dev setup (this repo checkout, not a firm's machine)

```bash
cd sanaku-case-intel
python3 -m venv .venv-dev && source .venv-dev/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
cp config/client.example.json config/client.json   # gitignored, edit freely
python3 scripts/generate_sample_case.py             # builds the fictional fixture PDFs
PYTHONPATH=. pytest tests/ -v
```

All tests pass fully offline in this repo's dev sandbox — none of them
require Ollama to be running. See "The one thing untested here" below for
exactly why, and what to check once Ollama's available.

## The one thing untested here — and it's the actual acceptance test

This was built and tested inside a sandboxed cloud session with **no
network access to `ollama.com` or its model registry** (confirmed directly
— both return a hard proxy-level 403). That means:

- Everything that doesn't need a live Ollama is fully tested here: PDF
  extraction and real OCR against fixture PDFs, chunking, ChromaDB
  storage/retrieval plumbing (via a deterministic stub embedder, see
  `tests/stub_embedder.py`), the Ollama HTTP request/response shapes
  (mocked transport), and both `OllamaEmbedder`'s and `generate_answer`'s
  unreachable-Ollama error handling — which is exercised for *real*, not
  simulated, since Ollama genuinely isn't running in that sandbox either.
- What is **not** tested, and can't be from there: real semantic embedding
  quality (does a differently-worded question still retrieve the right
  passage?) and the actual cited-answer output of a live model. Those are
  properties of the real model, not the plumbing around it — no amount of
  stubbing proves them.

**Run this on a machine with Ollama actually installed** (the target Mac
Mini, or any dev machine) to complete Phase 3's real acceptance test:

```bash
ollama pull llama3.1:8b            # or whatever config/client.json's gen_model is
ollama pull nomic-embed-text       # or whatever embed_model is
ollama serve                       # if not already running as a service

cd sanaku-case-intel
cp config/client.example.json config/client.json   # edit as needed
mkdir -p data/cases/maria_delgado/documents
cp sample_cases/maria_delgado/documents/*.pdf data/cases/maria_delgado/documents/

python3 cli.py ingest --case-id maria_delgado
python3 cli.py ask --case-id maria_delgado \
  --question "What did the treating physician say about causation?"
```

Confirm by hand: the answer references Dr. Chen's causation opinion, cites
`[medical_record_dr_chen.pdf, p.3]`, and nothing in the answer is
uncited. Then also try:

```bash
python3 cli.py ask --case-id maria_delgado \
  --question "What evidence is there that the injury came from the crash?"
```

— confirming the *same* causation passage surfaces despite the different
wording. That paraphrase-robustness is the actual Phase 2 acceptance
criterion, and it's a property of `nomic-embed-text` (or whatever
`embed_model` you've configured), not something this test suite can stand
in for.

## Sample data

Everything under `sample_cases/maria_delgado/` is fictional, generated by
`scripts/generate_sample_case.py` (dev-only — not part of the shipped app,
`reportlab` lives in `requirements-dev.txt` for exactly this reason). No
real client or patient data has ever touched this project. Every generated
document is explicitly labeled "FICTIONAL DEMO DATA."

## Phase 4 — running the web UI, and how it was actually verified

The UI itself needs no Ollama — it only ever talks to this project's own
`/ask` endpoint, not to Ollama directly. That means, unlike Phase 2/3, the
whole thing IS fully exercisable in a sandbox with no Ollama: real ingest,
real ChromaDB retrieval, a fake but realistic generated answer (via
`scripts/dev_server_stub.py`, dev-only — swaps in `StubEmbedder` and a
canned generator the same way `tests/test_api.py` does, just as a running
server instead of a `TestClient`). That's exactly how this was proven this
session, with Playwright: real question typed into the real input, a real
answer + source panel rendered from real retrieved passages, a source card
expanded to show real passage text, then `config/client.json` edited to a
second, visibly different firm (different name, different logo, different
color palette) and the exact same build reflected that firm with **zero
code changes and zero rebuild** — confirming Phase 4's actual acceptance
criterion, not just asserting it works.

Real run, against real Ollama:

```bash
# terminal 1 - the API
cd sanaku-case-intel
source .venv-dev/bin/activate  # or your real venv
uvicorn api.main:app --port 8000

# terminal 2 - the UI
cd sanaku-case-intel/web
npm install
npm run dev
```

Open the printed `localhost:5173` URL, pick (or type) a case ID, ask a
question. `vite.config.js` proxies `/theme`, `/cases`, `/ask`,
`/transcribe`, and `/branding-assets` to port 8000 so the browser only
ever talks same-origin.

Dev-only stub run (no Ollama needed, what was actually used to verify this
phase in this sandbox):

```bash
PYTHONPATH=. python3 scripts/dev_server_stub.py   # instead of uvicorn, terminal 1
```

`/theme` is the *only* config-derived endpoint the UI calls — deliberately
excludes `gen_model`/`embed_model`/`tier`/`data_root`/`license_path`. That
split is what enforces the white-label guardrail structurally: the UI
can't leak a model name or architecture detail it was never given.

## Voice — ask by mic, listen to the answer

Two independent, deliberately different-shaped pieces, not one feature:

- **Listening (speech → text)** runs entirely locally via
  `core/transcribe.py`'s `WhisperTranscriber` (faster-whisper), exposed as
  `POST /transcribe`. This is a real local model, not the browser's
  built-in `SpeechRecognition` — on Chrome that typically round-trips
  audio through Google's servers, which would violate guardrail #1 the
  same way `tiktoken`'s network fetch would have.
- **Speaking (text → voice)** runs via `core/speak.py`'s
  `PiperSynthesizer`, exposed as `POST /speak`. Piper is genuinely local
  (real neural TTS, a different tier than the default OS voice this
  replaced — the browser's `speechSynthesis` sounded "choppy," per direct
  feedback), but it's licensed GPL-3.0-or-later and this codebase is
  proprietary. Rather than importing it in-process (the way
  `faster-whisper` is imported into `WhisperTranscriber`), **Piper runs as
  its own separate local process, called only over HTTP** — the exact
  relationship this app already has with Ollama. That boundary was chosen
  deliberately over the simpler in-process route after weighing the
  licensing trade-off explicitly; it still needs real legal review before
  this ships to any paying client, not something this codebase asserts on
  its own authority.

**Optional dependencies, not installed by default:**

```bash
pip install -r requirements-voice.txt   # faster-whisper + piper-tts
```

`faster-whisper` requires **macOS 14 (Sonoma) or newer** — `onnxruntime`
(its own dependency) only ships wheels for `macosx_14_0_arm64` as of this
writing; confirmed directly against PyPI, not assumed. `python-multipart`
(needed for `/transcribe`'s multipart upload) is in the *base*
`requirements.txt` instead — FastAPI inspects `UploadFile` parameters at
route-registration time, not just per-request, so the app won't even
start without it, regardless of whether voice is actually used.

The whisper model downloads once from Hugging Face on first real
`/transcribe` call (same one-time-pull shape as `ollama pull` for the
gen/embed models). Piper needs its voice model pulled *and its own server
started* before `/speak` will work — a third terminal, same shape as
`ollama serve`:

```bash
python3 -m piper.download_voices en_US-lessac-medium --data-dir ~/.local/share/sanaku-case-intel/piper-voices
python3 -m piper.http_server --model en_US-lessac-medium \
  --data-dir ~/.local/share/sanaku-case-intel/piper-voices --host 127.0.0.1 --port 5000
```

**What was actually verified in this sandbox** (no microphone, no audio
hardware here, same constraint that applied to live Ollama generation):
`scripts/dev_server_stub.py` overrides `get_transcriber`/`get_synthesizer`
with `tests/stub_transcriber.py`/`tests/stub_synthesizer.py` (the latter
returning a genuinely valid, playable silent WAV — not just WAV-shaped
bytes), so the whole request/response contract and the UI's mic → upload
→ fill-question-box and Listen → fetch → `<audio>` play/stop/auto-end
flows were proven end-to-end with Playwright, using Chromium's
fake-media-device flags to simulate a microphone. What that *cannot*
prove: real transcription accuracy against a real spoken legal question,
and real Piper voice naturalness/latency — both need confirming on your
Mac, the same as semantic embedding quality and live cited-answer output
were in Phase 2/3.

## Conversation memory — follow-up questions in the same session

`POST /ask` accepts an optional `history: [{question, answer}, ...]`
array. The web UI keeps this client-side (`web/src/App.jsx`'s `turns`
state) and sends the whole prior thread with each new question — no new
backend session store. This API has no session/identity concept anywhere
else (single browser tab, single attorney, same machine), and a new
server-side store would raise a real question a tab-scoped design avoids
by construction: what expires attorney-client-privileged history sitting
in a database. Closing the tab is the retention policy.

Two places this had to stay honest about the citation contract, not just
convenient:
- `core/retrieve.py`'s `build_retrieval_query` folds recent prior
  *questions* (never answers) into the retrieval query text, so a bare
  follow-up like "what about her prior injuries?" has a real chance of
  surfacing the right passages — a cheap heuristic, not an LLM rewrite
  call, to avoid a third local-model round trip per question. Isolated in
  its own function specifically so it's swappable later if real follow-up
  questions on your Mac show it missing too often (a live-embeddings
  question no offline test can answer).
- `prompts/answer_contract.txt`'s new **Rule 5** states, at the same
  "must never be violated" permanence as rules 1-4, that conversation
  history is context for understanding the question only — never a
  citable source. `core/generate.py`'s `build_user_prompt` restates this
  inline right where the history block appears, the same
  belt-and-suspenders pattern already used for "Passage N is a locator,
  not a citation." Whether the model actually obeys this in practice is a
  live-model question — the same category the citation-format bug turned
  out to be real, not something the prompt text alone proves.

The web UI's answer panel is now a growing thread (`.conversation-thread`
in `web/src/App.jsx`), not a single replaced answer — each turn gets its
own Listen button; Print became "Print this conversation," printing the
whole thread (a printed follow-up without the question that gave "her"
its meaning would reproduce, on paper, the exact ambiguity this feature
exists to resolve on screen). "Start a new conversation" clears the
thread on purpose — without it, every later question would keep dragging
the whole prior thread into retrieval and prompt history forever.
`cli.py` stays single-turn — it's a one-shot process invocation with
nowhere for conversation state to live between runs.

## Repo layout note

This directory is a sibling of `sanaku/` in the same repo — `sanaku/` is
an unrelated product (a lead-gen/local-business automation SaaS). Nothing
in `sanaku-case-intel/` touches or depends on it.
