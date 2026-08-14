#!/usr/bin/env bash
# One-shot machine setup: install deps, pull the configured Ollama models,
# verify Ollama is reachable. Reports status at each step rather than
# hard-failing on the Ollama-specific steps — a fresh machine that hasn't
# installed Ollama yet (or a CI/sandbox with no Ollama at all) should still
# get a clean Python environment out of this, not a wall of errors.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> [1/4] Installing Python dependencies..."
python3 -m pip install -r requirements.txt

echo "==> [2/4] Checking for Ollama binary..."
if ! command -v ollama >/dev/null 2>&1; then
  echo "    WARNING: 'ollama' not found on PATH. Install from https://ollama.com, then re-run this script."
  OLLAMA_PRESENT=0
else
  OLLAMA_PRESENT=1
fi

GEN_MODEL=""
EMBED_MODEL=""
if [ -f config/client.json ]; then
  GEN_MODEL=$(python3 -c "import json; print(json.load(open('config/client.json'))['gen_model'])" 2>/dev/null || echo "")
  EMBED_MODEL=$(python3 -c "import json; print(json.load(open('config/client.json'))['embed_model'])" 2>/dev/null || echo "")
else
  echo "    NOTE: config/client.json not found yet — copy config/client.example.json and fill it in."
fi

echo "==> [3/4] Pulling configured models (skipped if Ollama or config is unavailable)..."
if [ "$OLLAMA_PRESENT" = "1" ] && [ -n "$GEN_MODEL" ]; then
  ollama pull "$GEN_MODEL" || echo "    WARNING: could not pull $GEN_MODEL"
  ollama pull "$EMBED_MODEL" || echo "    WARNING: could not pull $EMBED_MODEL"
else
  echo "    skipped (no ollama binary and/or no config/client.json yet)"
fi

echo "==> [4/4] Verifying Ollama reachable..."
if curl -fsS http://localhost:11434/api/tags >/dev/null 2>&1; then
  echo "    Ollama reachable."
else
  echo "    Ollama NOT reachable at http://localhost:11434 — start it with 'ollama serve'."
fi

echo ""
echo "Setup finished. Step 1 (Python deps) always runs to completion; steps 2-4"
echo "report Ollama's status without aborting the script, since this machine may"
echo "not have Ollama installed/running yet."
