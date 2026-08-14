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
  logo-monogram fallback, a persisted light/dark toggle — see "Light and
  dark mode" below), a print feature (now printing the whole
  conversation, not just one answer), voice input/output (local Whisper
  + a separate local Piper process — see "Voice" below) that now
  auto-stops recording once you pause talking instead of requiring a
  second click (see "Auto-stop recording on silence" below), hands-free
  wake-phrase listening ("Let's do a case review." — see "Hands-free
  listening mode" below), streaming answers (see "Streaming answers"
  below), and multi-turn conversation memory (see "Conversation memory"
  below) — all still Phase 4 surface, no new
  config schema.

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
uvicorn api.main:app --port 8001

# terminal 2 - the UI
cd sanaku-case-intel/web
npm install
npm run dev
```

Open the printed `localhost:5173` URL, pick (or type) a case ID, ask a
question. `vite.config.js` proxies `/theme`, `/cases`, `/ask`,
`/transcribe`, and `/branding-assets` to port 8001 so the browser only
ever talks same-origin.

**Port 8001, not the more conventional 8000** — moved here after a real
port collision on a real Mac: an unrelated program already listening on
8000 silently intercepted every API call (its own 404 page for
everything), and every single symptom that produced — no case list, no
transcription, hands-free never responding — looked exactly like a bug in
this app until `lsof -i :8000` identified an unrelated process actually
answering there. If 8001 ever collides on a given machine too, change the
port in both this command and `web/vite.config.js`'s proxy targets
together - they have to agree.

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
  --data-dir ~/.local/share/sanaku-case-intel/piper-voices --host 127.0.0.1 --port 5000 \
  --sentence-silence 0.4
```

`--sentence-silence` defaults to `0.0` in Piper's own server — literally
zero silence between sentences unless set explicitly, which reads as one
run-on utterance regardless of how clean the sentence boundaries in the
text are. `0.4` (seconds) is a reasonable starting point for a real
pause between an answer's thesis and each supporting point; adjust to
taste. This only does anything useful paired with
`stripCitationsForSpeech` (`web/src/App.jsx`) actually producing real
sentence-terminal punctuation between points in the first place - Piper
can't pause on a sentence boundary that isn't there.

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

## Auto-stop recording on silence

Real feedback: having to click the mic button again to say "I'm done
talking" was friction against the actual goal ("this is supposed to be
an interactive system that has live conversation," in the words that
prompted this) — an Alexa/Siri-style pause-to-finish is what a live
conversational feel actually requires, not a second manual step.

`web/src/App.jsx`'s `startRecording()` — the one recording path shared
by the mic button, the `⌘⇧M` hotkey, and hands-free wake-phrase
activation, all three get this automatically — now arms a silence
monitor the instant recording starts (`armAutoStopOnSilence`), reusing
the same Web Audio `AnalyserNode` RMS-sampling approach the hands-free
loop already uses for chunk energy-gating, just pointed at a live
recording instead of a background chunk. `createSilenceStopDetector` is
the actual decision logic, deliberately factored out as a pure function
(RMS + a timestamp in, a boolean out) rather than inlined into the Web
Audio wiring — the same split `matchesWakePhrase` uses, and for the same
reason: fully unit-testable without a browser.

Behavior, by design: doesn't stop just because a recording session
opened in silence — it waits for real speech to happen first, then stops
`AUTO_STOP_SILENCE_MS` (1.3s) after the *last* moment of detected speech,
so a brief mid-sentence pause doesn't cut someone off. `AUTO_STOP_MAX_MS`
(60s) is a hard safety cap regardless, so a stuck-open mic (background
noise that never quite reads as "silence," a room that's just loud)
can't hold the microphone open indefinitely. A manual click still works
as an override throughout — this doesn't remove that path, it just means
most of the time you won't need it.

**Verified two ways.** Pure logic (`createSilenceStopDetector`) via a
standalone Node script with synthetic RMS/timestamp sequences — silence
before any speech never stops, a sub-threshold pause doesn't stop, a
past-threshold pause does (and promptly), continuous "speech" holds off
until the 60s safety cap, a brief mid-sentence pause resets the clock
rather than counting toward it. Then genuinely end-to-end, not just
mocked: Chromium's fake capture device supports feeding it a **real WAV
file** via `--use-file-for-fake-audio-capture` instead of its default
synthetic tone — fed it a real 1.2s-tone-then-real-silence clip and
confirmed, watching actual DOM state over actual wall-clock time, that a
single mic click auto-stopped and transcribed with **no second click**,
timed correctly against the silence threshold; then fed it a continuous
tone and confirmed recording survives well past the silence threshold
without a false-positive stop, with the manual click-to-stop override
still working afterward. This is real proof the mechanism works, not an
assumption that the wiring is probably fine because the pure logic is —
same standard as every other voice claim in this project.

**Only confirmable on your Mac**: real-room threshold tuning
(`AUTO_STOP_ENERGY_THRESHOLD`, currently `0.02`, same starting value
`LISTEN_ENERGY_THRESHOLD` uses) — a quiet home office and a firm's
open-plan conference room have different noise floors, and this sandbox
has no real microphone to tune against.

## Light and dark mode

The header's "Dark mode" toggle (persisted per-browser via
`localStorage`, defaulting to light) switches `web/src/index.css`'s
`[data-look='dark']` token block — the "modern dark professional"
direction that came out of comparing two real mockups (a sci-fi-HUD
glow direction and this flatter, no-glow one) against the actual
Maria Delgado case content. Chose the restrained one on purpose: no
glow/neon, since that register reads as generic "AI product" when
overdone and legal software needs to read as credible first. The
other direction's code was removed once this one was chosen, not kept
behind a flag.

Same derivation rule as the light palette: every dark neutral is still
computed from the firm's own 3 configured colors via `color-mix()`,
never a fixed hardcoded palette — a firm's actual branding still comes
through in dark mode exactly like it does in light.

**Real bug this caught and fixed at the root**: `.source-toggle` (a
`<button>`) never set its own `color`, so it silently rendered in the
browser's default near-black button text instead of inheriting `--ink`
— invisible in light mode by coincidence (default black text on a pale
background looked fine), genuinely unreadable once `--paper` went dark.
Caught from an actual rendered screenshot, not by inspecting the CSS.
Fixed structurally, not just on that one selector: `button, select,
input, textarea { color: inherit; font-family: inherit; }` near the top
of `index.css`, so no future control can quietly reintroduce the same
class of bug. The citation-attestation badges (`--badge-bg`/
`--badge-fg`) had the same underlying problem via a *different* path —
fixed regardless of firm branding (by design, so "Undated"/"Approximate
date" mean the same thing across every firm's theme), but "independent
of branding" isn't "independent of light vs. dark," and the light
palette's fixed amber-on-cream badge is real low-contrast dark-on-dark
once the background goes dark. Given its own dark-mode-only override
inside `[data-look='dark']`, still the same amber hue, still
brand-independent, just lightened enough to read.

Printing is unaffected either way — `@media print` already forces
`body { background:#fff; color:#000; }` and re-asserts `#000` on every
text element it prints, regardless of which look was active on screen;
verified directly (not assumed) by rendering print-media output with
dark mode on and checking every computed color came back black-on-white.

## Hands-free listening mode — "Let's do a case review."

An explicit toggle (the header's "Hands-free" button, or the sticky
banner's "Turn off"), **not always-on by default** — this app sits in
rooms with privileged attorney-client conversations, so when the
microphone is live can never be ambiguous. Armed, saying **"Let's do a
case review"** starts a real question recording with no click needed —
the same `startRecording()` the mic button and `⌘⇧M` already call, so
there's exactly one recording path, not two. It only ever fills the
question box; the human still reviews and clicks Ask, same as manual
voice input — this feature doesn't auto-submit.

**Architecture: reuses the existing local Whisper pipeline via short
rolling audio chunks, not a dedicated wake-word engine.** `openwakeword`
was checked directly against PyPI before deciding against it: it ships
pretrained detectors for single wake *words* only — a custom 5-word
phrase needs training a model, which pulls in a `[full]` extra
(`torch`/`speechbrain`/`audiomentations`, a full training pipeline) far
bigger than anything else optional in this project. Reusing
`/transcribe` (already built, already tested) needs **zero new
dependencies and zero backend changes** — everything lives in
`web/src/App.jsx`: a persistent microphone stream + a Web Audio
`AnalyserNode` records ~4-second chunks, gates them by peak RMS energy
before ever calling `/transcribe` (a silent room costs nothing), and
checks the transcribed text against the wake phrase via a sliding-window
normalized Levenshtein distance (tolerates "let's" vs "lets," one
misheard word, etc. without needing an exact match — see
`matchesWakePhrase`'s doc comment for the real tolerance trade-off this
implies).

Honest costs, not glossed over:
- **Latency is real, not instant** — expect roughly 2-6 seconds between
  finishing the phrase and the app starting to record (remainder of the
  current 4s chunk + a local transcription + a localhost round trip). A
  dedicated streaming wake-word detector would react faster; this
  deliberately isn't that, for the dependency-footprint reasons above.
- **Real false-positive rate is untestable here.** `tests/
  stub_transcriber.py`'s fixed-text pattern proves the mechanics (a
  matching chunk starts real recording with no click; a non-matching one
  leaves it armed; a manual click/hotkey always wins immediately and the
  loop resumes after) via Playwright with Chromium's fake-media-device
  flags — verified this way before shipping. What it *cannot* prove:
  whether ordinary room conversation on your Mac ever accidentally scores
  within the match threshold (`LISTEN_MATCH_MAX_RATIO` in `App.jsx`,
  starting at `0.25`) and starts an unwanted recording. That has to be
  watched for on real hardware, the same category of gap as real
  transcription accuracy and Piper voice naturalness above.
- Mutual exclusion with manual use, and the 10-minute inactivity timeout
  (reset only on an actual phrase match, never on ambient chunk audio —
  deliberately, so an unrelated long meeting can't keep this armed
  indefinitely) are both real-Mac-tunable starting points, documented
  inline in `App.jsx` next to the relevant constants
  (`LISTEN_CHUNK_MS`, `LISTEN_ENERGY_THRESHOLD`, `LISTEN_INACTIVITY_MS`).

Two distinct visual registers while armed, both required: the header
toggle reads "Hands-free is on," and a separate sticky banner (using
`--color-secondary`, deliberately *not* the red already used for
"recording your question right now," so the two states never look
alike) stays visible under the header with its own always-reachable
"Turn off" button — a second kill switch beyond the header toggle,
warranted given the privacy stakes.

## Streaming answers — POST /ask/stream

Real feedback from actually using this: waiting for an entire non-
streamed completion from an 8B model on ordinary hardware before
anything appears reads as "did this hang?", not "this is working" — the
exact "lawyers waiting forever" problem this exists to fix. Streaming
doesn't make the model faster; it moves time-to-first-visible-content
from "the whole answer's generation time" down to roughly the retrieval
time plus one token.

`core/generate.py`'s `stream_answer` is a generator-based sibling of
`generate_answer` — same prompt, same contract, same citation guarantees,
same error mapping (`OllamaUnavailableError` on a connect failure or
timeout) — the only difference is `"stream": True` against Ollama's own
`/api/chat`, yielding each `message.content` delta as it arrives instead
of blocking for the full completion. `generate_answer` (non-streaming)
stays as-is for `cli.py`, which has nowhere to stream *to*.

`POST /ask/stream` (new, alongside the existing `POST /ask`) does
retrieval synchronously first — it's the fast part — and sends the
retrieved sources as the response's very first line, before generation
even starts, so the web UI's source panel renders before the answer's
first word exists. Body is newline-delimited JSON, not Server-Sent
Events (a POST with a JSON body can't use `EventSource`, which is
GET-only): one `{"type":"sources",...}` line, then repeated
`{"type":"delta","text":"..."}` lines, then exactly one of
`{"type":"done","answer":"..."}` or `{"type":"error","detail":"..."}`. A
generation failure reachable only *after* streaming has begun can't
become a real `HTTPException` — the 200 response and its headers are
already committed by the time the first line is written — so it's
reported as that final `error` line instead; `web/src/App.jsx` treats it
identically to a rejected `/ask` either way.

`web/src/App.jsx`'s `handleAsk` reads the response body via `fetch` +
`response.body.getReader()` (no library — a hand-rolled newline-buffered
reader, since this project has stayed dependency-light throughout), and
threads state carefully so a turn appears in the conversation thread the
instant sources arrive, then grows in place as delta lines land, rather
than only existing once everything is done. Two new pieces of turn/app
state make this legible: `turn.data.streaming` (a small "Generating…"
indicator on that turn's Answer heading, and its own Listen button
disabled until the text is final and citations are stable) and
`streamingTurnId` (blocks asking a follow-up mid-stream — sending an
unfinished answer as this turn's own history to the next question would
be wrong). "Start a new conversation" now actually aborts an in-flight
stream (`AbortController`), rather than leaving it running to completion
in the background against a `turns` array that's already been cleared.

**Verified in this sandbox**: `tests/test_ollama_clients.py` covers
`stream_answer`'s request shape (`"stream": true`), delta ordering, and
both error paths (unreachable, timeout) via a mocked transport carrying
real Ollama streaming NDJSON shape;
`tests/test_api.py` covers `/ask/stream`'s three-line contract (sources
→ deltas → done) end to end, that concatenated deltas exactly equal the
final `done` answer, and the mid-stream-failure → final `error` line
path — all deterministic, no real Ollama needed. `scripts/
dev_server_stub.py` got a `fake_stream_generate` (same fake text as the
existing `fake_generate`, yielded word-by-word with a small real delay)
specifically so Playwright could observe genuine incremental behavior —
confirmed directly, not assumed: sources visible in the DOM before any
answer text exists, the answer panel's text growing as a strict prefix
extension over successive samples (not one paste), the "Generating…"
indicator and disabled Ask button through the whole stream and clearing
the instant `done` arrives, "Start a new conversation" mid-stream
producing zero leftover turns and no error banner, and a second
follow-up question still resolving conversation-memory context correctly
after switching to the streaming path.

**Only confirmable on your Mac**: whether streaming actually *feels*
faster with a real 8B model under real hardware constraints — this
sandbox has no Ollama to generate anything, real or timed, so the actual
perceived-latency improvement (the entire point of this change) is a
live check, not something provable from here.

## Conversation memory — follow-up questions in the same session

`POST /ask` (and `POST /ask/stream`, its streaming sibling — see
"Streaming answers" above) accepts an optional `history: [{question,
answer}, ...]` array. The web UI keeps this client-side (`web/src/App.jsx`'s
`turns` state) and sends the whole prior thread with each new question —
no new backend session store. This API has no session/identity concept anywhere
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

## Error-handling audit — catching the rest of a real pattern

Three real bugs this session (Ollama timeouts, `WhisperTranscriber.
transcribe()`, and `get_config()` on an invalid `config/client.json`) all
turned out to be the same shape: an exception that wasn't the one specific
type a `try`/`except` was watching for propagated all the way up as an
unhandled exception, producing an opaque 500 with a plain-text body -
which a firm's staff (or a browser DevTools Network tab) would see as
"nothing works," with no indication why. Once that pattern was visible
across three unrelated bugs, it was worth auditing the rest of the API for
the same gap deliberately, rather than waiting to hit each remaining one
live:

- **`POST /ingest`** only caught `FileNotFoundError`/`OllamaError` -
  `core/ingest.py`'s `extract_document()` can raise `ValueError` for an
  unsupported file type, and the real PDF/OCR libraries underneath it
  (PyMuPDF on a corrupted PDF, `pytesseract` if the `tesseract-ocr` system
  binary isn't installed - a real first-run gap, not hypothetical) can
  raise their own exceptions. Now has a catch-all mapping anything
  unexpected to a clean 500 with the real reason.
- **`POST /ask`** and **`POST /ask/stream`** got the same catch-all
  treatment, on top of their existing `OllamaError` handling - for the
  streaming route specifically, an uncaught exception mid-generator used
  to mean the ASGI response just cut off with no error event at all, the
  worst version of this failure mode since the client has nothing to show.
- **`POST /transcribe`** and **`POST /speak`** got a defensive catch-all
  too, on top of `core/transcribe.py`'s/`core/speak.py`'s own error
  mapping - belt-and-suspenders, not a substitute for fixing gaps at the
  source.

Every catch-all follows the same rule already established for
`get_config()`: it comes *after* the specific, better-typed exception
handlers, so a real `OllamaUnavailableError` still gets its clean 503 -
the catch-all only ever fires for something genuinely unanticipated,
turning it into a real error message instead of a swallowed bug. Covered
by `tests/test_api.py` - each route gets a test with a fake
embedder/generator/transcriber/synthesizer that raises a plain
`RuntimeError` (deliberately not any of this project's own typed
exceptions), confirming the catch-all - not the more specific handlers -
is what's actually reachable and working.

**`scripts/setup.sh`** also grew three checks directly motivated by real
failures hit live on a real Mac this session, not hypothetical ones:
- **Config validation** (step 3) runs the real `core.config.load_config()`
  - not a separate, looser hand-rolled check - so a `config/client.json`
  that's present but invalid gets caught with a clear, specific message
  *before* the server is ever started, instead of surfacing later as an
  opaque 500 discovered live in a browser's Network tab (which is exactly
  how this class of bug was actually found this session).
- **`tesseract-ocr` presence** (step 5) - a real system dependency for
  scanned-document ingestion that nothing in `requirements.txt` pulls in,
  easy to forget on a fresh machine.
- **Port 8001 availability** (step 6) - directly motivated by an actual
  multi-hour debugging session this project went through when an
  unrelated program was already listening on port 8000, silently
  intercepting every request with its own 404 page. Every symptom that
  produced (missing case list, failed transcription, hands-free never
  responding) looked exactly like a bug in this app until `lsof -i :8000`
  identified the real cause. This check exists so the *next* occurrence of
  that exact failure mode is caught in one line of setup output instead of
  a long live debugging session.

All three new setup.sh checks were verified by actually running the
script both ways - once against a genuinely valid config (reports
"valid"), once against a deliberately broken one (missing every required
field except `firm_name`) confirming it prints the real Pydantic
validation errors and a clear warning, not a silent pass.

## Repo layout note

This directory is a sibling of `sanaku/` in the same repo — `sanaku/` is
an unrelated product (a lead-gen/local-business automation SaaS). Nothing
in `sanaku-case-intel/` touches or depends on it.
