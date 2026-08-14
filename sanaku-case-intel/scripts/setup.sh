#!/usr/bin/env bash
# One-shot machine setup: install deps, validate config, pull the
# configured Ollama models, verify Ollama is reachable. Reports status at
# each step rather than hard-failing on the environment-specific steps —
# a fresh machine that hasn't installed Ollama yet (or a CI/sandbox with
# no Ollama at all) should still get a clean Python environment out of
# this, not a wall of errors.
#
# Steps 3 (config validation), 5 (tesseract), and 6 (port 8001) exist
# specifically because of real failures hit live on a real Mac, not
# hypothetical ones: an invalid-but-present config/client.json crashed
# every route that depends on it with an opaque 500 and no indication why
# (core/config.py's load_config() now raises a clear message, and this
# script surfaces the same check before the server is even started);
# tesseract-ocr is a real system dependency for scanned-document ingestion
# that's easy to forget to install since nothing in requirements.txt pulls
# it in; and a stray unrelated process already listening on 8001 would
# produce exactly the "nothing works, no clear reason" experience that an
# earlier port collision on 8000 caused an entire debugging session over.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/6] Installing Python dependencies..."
python3 -m pip install -r requirements.txt

echo "==> [2/6] Checking for Ollama binary..."
if ! command -v ollama >/dev/null 2>&1; then
  echo "    WARNING: 'ollama' not found on PATH. Install from https://ollama.com, then re-run this script."
  OLLAMA_PRESENT=0
else
  OLLAMA_PRESENT=1
fi

echo "==> [3/6] Validating config/client.json..."
GEN_MODEL=""
EMBED_MODEL=""
if [ -f config/client.json ]; then
  # Reuses the real loader/validator (core.config.load_config) rather
  # than a hand-rolled JSON check, so this catches exactly what the real
  # server would reject - malformed JSON and schema mismatches alike -
  # instead of a separate, looser check that could pass here and still
  # fail live.
  if CONFIG_JSON=$(python3 -c "
import json, sys
from core.config import load_config
try:
    cfg = load_config()
    print(json.dumps({'gen_model': cfg.gen_model, 'embed_model': cfg.embed_model}))
except Exception as e:
    print(f'    INVALID: {e}', file=sys.stderr)
    sys.exit(1)
" 2>&1); then
    GEN_MODEL=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['gen_model'])" "$CONFIG_JSON")
    EMBED_MODEL=$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['embed_model'])" "$CONFIG_JSON")
    echo "    config/client.json is valid."
  else
    echo "$CONFIG_JSON"
    echo "    WARNING: config/client.json exists but failed validation (see above) - fix it before starting the server."
  fi
else
  echo "    NOTE: config/client.json not found yet — copy config/client.example.json and fill it in."
fi

echo "==> [4/6] Pulling configured models (skipped if Ollama or config is unavailable)..."
if [ "$OLLAMA_PRESENT" = "1" ] && [ -n "$GEN_MODEL" ]; then
  ollama pull "$GEN_MODEL" || echo "    WARNING: could not pull $GEN_MODEL"
  ollama pull "$EMBED_MODEL" || echo "    WARNING: could not pull $EMBED_MODEL"
else
  echo "    skipped (no ollama binary and/or no valid config/client.json yet)"
fi

echo "==> [5/6] Checking for tesseract-ocr (needed to ingest scanned/image-only pages)..."
if ! command -v tesseract >/dev/null 2>&1; then
  echo "    WARNING: 'tesseract' not found on PATH. Scanned-document ingestion will fail until it's installed"
  echo "    (macOS: brew install tesseract). Digital/text-layer PDFs are unaffected."
else
  echo "    tesseract found."
fi

echo "==> [6/6] Checking port 8001 is free (this app's dev API server port)..."
if command -v lsof >/dev/null 2>&1 && lsof -i :8001 >/dev/null 2>&1; then
  echo "    WARNING: something is already listening on port 8001 - this app's own server won't be able to"
  echo "    bind there. Run 'lsof -i :8001' to see what it is before starting uvicorn."
else
  echo "    port 8001 is free."
fi

echo ""
echo "==> Verifying Ollama reachable..."
if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "    Ollama reachable."
else
  echo "    Ollama NOT reachable at http://localhost:11434 — start it with 'ollama serve'."
fi

echo ""
echo "Setup finished. Step 1 (Python deps) always runs to completion; the"
echo "rest report status without aborting the script, since a given machine"
echo "may not have every optional piece installed/configured yet."
