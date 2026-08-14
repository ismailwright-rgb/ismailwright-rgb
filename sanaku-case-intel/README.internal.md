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
  `core/generate.py`, `api/main.py`'s `/ingest` + `/ask`, `cli.py`.

**Stopped here deliberately**, per the master prompt's own instruction:
"Stop after Phase 3 and confirm the recordable prototype works before
moving on." Phases 4–9 (white-label UI, paralegal manual-entry, hardware
licensing/encryption, voice, archive, packaging) are not built.

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

All 28 tests pass fully offline in this repo's dev sandbox — none of them
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

## Repo layout note

This directory is a sibling of `sanaku/` in the same repo — `sanaku/` is
an unrelated product (a lead-gen/local-business automation SaaS). Nothing
in `sanaku-case-intel/` touches or depends on it.
