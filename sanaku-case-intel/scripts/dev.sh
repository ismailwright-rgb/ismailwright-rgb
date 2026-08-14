#!/usr/bin/env bash
# One-and-done dev launcher: starts the API server, the UI dev server, and
# (if voice is set up) the local voice service together from a single
# terminal window, then stops everything cleanly on Ctrl+C. Real
# motivation, not a nice-to-have: real debugging time was lost to
# friction that had nothing to do with this app's actual code - juggling
# multiple terminal windows, cd'ing into the wrong directory (the repo
# root instead of web/, or a different checkout entirely), an unrelated
# program already holding a port this app needed (twice - once for the
# API, once for the voice service), forgetting to restart a server after
# `git pull`. This script exists to make every one of those specific
# failure modes impossible, using paths derived from its own location -
# works no matter what directory you're in when you run it.
#
# Usage (from anywhere):
#   ./scripts/dev.sh
#   bash scripts/dev.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

API_PORT=8001
UI_PORT=5173
PIPER_PORT=5001
PIPER_VOICE="${PIPER_VOICE:-en_US-lessac-medium}"
PIPER_DATA_DIR="${PIPER_DATA_DIR:-$HOME/.local/share/sanaku-case-intel/piper-voices}"

echo "======================================================================"
echo " Sanaku Case-Intel — starting from $PROJECT_ROOT"
echo "======================================================================"

# --- Pre-flight checks --------------------------------------------------
# Each one catches a real failure hit live, before it can happen again -
# see README.internal.md's "Error-handling audit" section for the full
# story behind each of these.

if [ ! -d .venv-dev ]; then
  echo ""
  echo "ERROR: .venv-dev not found in $PROJECT_ROOT."
  echo "This is a one-time setup step - run this first:"
  echo "    bash scripts/setup.sh"
  exit 1
fi
# shellcheck disable=SC1091
source .venv-dev/bin/activate

if [ ! -f config/client.json ]; then
  echo ""
  echo "ERROR: config/client.json not found."
  echo "Copy the example and fill it in (this file is gitignored - local"
  echo "and firm-specific, edit it freely):"
  echo "    cp config/client.example.json config/client.json"
  exit 1
fi

echo "==> Validating config/client.json..."
if ! CONFIG_ERR=$(python3 -c "
from core.config import load_config
load_config()
" 2>&1); then
  echo ""
  echo "ERROR: config/client.json exists but isn't valid:"
  echo "$CONFIG_ERR" | tail -20
  exit 1
fi
echo "    valid."

echo "==> Checking port $API_PORT is free..."
if command -v lsof >/dev/null 2>&1 && lsof -i ":$API_PORT" >/dev/null 2>&1; then
  echo ""
  echo "ERROR: something is already listening on port $API_PORT - this is"
  echo "exactly the failure that cost real debugging time earlier: an"
  echo "unrelated program silently intercepting every request, with every"
  echo "symptom looking like a bug in this app. Find out what it is and"
  echo "stop it first:"
  echo "    lsof -i :$API_PORT"
  exit 1
fi
echo "    free."

if [ ! -d web/node_modules ]; then
  echo "==> Installing UI dependencies (first run only)..."
  (cd web && npm install)
fi

# --- Voice service: optional, started only if it's actually set up ------
# Never a hard failure if it isn't - voice is an optional feature (see
# requirements-voice.txt); every route that needs it already degrades to
# a clean, specific error (not a crash) if it's unavailable, so skipping
# it here just means "Ask by voice" / "Listen to this answer" won't work
# until it's set up, not that the rest of the app is broken.
START_PIPER=0
if python3 -c "import piper" >/dev/null 2>&1; then
  if [ -f "$PIPER_DATA_DIR/$PIPER_VOICE.onnx" ]; then
    if command -v lsof >/dev/null 2>&1 && lsof -i ":$PIPER_PORT" >/dev/null 2>&1; then
      echo "==> Voice: something's already listening on port $PIPER_PORT - assuming that's"
      echo "    your own already-running voice service. Not starting a second one."
    else
      START_PIPER=1
    fi
  else
    echo "==> Voice: piper-tts is installed but no voice model found at"
    echo "    $PIPER_DATA_DIR/$PIPER_VOICE.onnx - skipping the voice service."
    echo "    One-time setup: python3 -m piper.download_voices $PIPER_VOICE --data-dir $PIPER_DATA_DIR"
  fi
else
  echo "==> Voice: piper-tts isn't installed - skipping the voice service."
  echo "    Optional, one-time setup: pip install -r requirements-voice.txt"
fi

# --- Start every server, tracked so Ctrl+C stops all of them ------------
API_LOG="$PROJECT_ROOT/.dev-api.log"
UI_LOG="$PROJECT_ROOT/.dev-ui.log"
PIPER_LOG="$PROJECT_ROOT/.dev-piper.log"

echo "==> Starting the API server on port $API_PORT (--reload: picks up"
echo "    code changes automatically, no manual restart needed)..."
uvicorn api.main:app --port "$API_PORT" --reload > "$API_LOG" 2>&1 &
API_PID=$!

echo "==> Starting the UI dev server on port $UI_PORT..."
(cd web && npm run dev -- --port "$UI_PORT" --strictPort) > "$UI_LOG" 2>&1 &
UI_PID=$!

PIPER_PID=""
if [ "$START_PIPER" = "1" ]; then
  echo "==> Starting the voice service on port $PIPER_PORT..."
  python3 -m piper.http_server --model "$PIPER_VOICE" --data-dir "$PIPER_DATA_DIR" \
    --host 127.0.0.1 --port "$PIPER_PORT" --sentence-silence 0.4 > "$PIPER_LOG" 2>&1 &
  PIPER_PID=$!
fi

CLEANED_UP=0
cleanup() {
  if [ "$CLEANED_UP" = "1" ]; then return; fi
  CLEANED_UP=1
  echo ""
  echo "==> Stopping everything..."
  kill "$API_PID" "$UI_PID" 2>/dev/null || true
  [ -n "$PIPER_PID" ] && kill "$PIPER_PID" 2>/dev/null
  sleep 1
  # Real bug caught live testing this exact script: `npm run dev` spawns
  # its own child process (vite's real dev server) that does NOT reliably
  # die just because npm's own PID got a signal - a well-known npm/job-
  # control quirk, not specific to this script. Killing $UI_PID alone left
  # something still bound to port 5173 after "Stopped" had already
  # printed. Backstop: explicitly free every port this script might have
  # bound, regardless of exactly what shape each process tree turned out
  # to be - `xargs -r` isn't used here since macOS's built-in xargs is
  # the BSD version, which doesn't support that GNU-only flag; checking
  # for a non-empty PID list first is the portable equivalent.
  if command -v lsof >/dev/null 2>&1; then
    for PORT in "$API_PORT" "$UI_PORT" "$PIPER_PORT"; do
      LEFTOVER=$(lsof -ti ":$PORT" 2>/dev/null || true)
      [ -n "$LEFTOVER" ] && echo "$LEFTOVER" | xargs kill -9 2>/dev/null || true
    done
  fi
  wait "$API_PID" "$UI_PID" 2>/dev/null || true
  [ -n "$PIPER_PID" ] && wait "$PIPER_PID" 2>/dev/null
  echo "==> Stopped. (Logs kept at $API_LOG / $UI_LOG${PIPER_PID:+ / $PIPER_LOG} if you need them.)"
}
trap cleanup EXIT INT TERM

echo "==> Waiting for the API to actually respond..."
API_UP=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
    API_UP=1
    break
  fi
  sleep 1
done
if [ "$API_UP" != "1" ]; then
  echo ""
  echo "ERROR: the API never came up after 30s. Last lines of $API_LOG:"
  tail -20 "$API_LOG"
  exit 1
fi
echo "    API is up."

if [ "$START_PIPER" = "1" ]; then
  echo "==> Waiting for the voice service to actually respond..."
  PIPER_UP=0
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PIPER_PORT/" >/dev/null 2>&1; then
      PIPER_UP=1
      break
    fi
    sleep 1
  done
  if [ "$PIPER_UP" != "1" ]; then
    echo "    WARNING: the voice service didn't respond after 30s - continuing without it."
    echo "    Last lines of $PIPER_LOG:"
    tail -20 "$PIPER_LOG"
  else
    echo "    Voice service is up."
  fi
fi

echo ""
echo "======================================================================"
echo " Running:"
echo "   App:    http://localhost:$UI_PORT"
echo "   API:    http://localhost:$API_PORT"
if [ "$START_PIPER" = "1" ]; then
  echo "   Voice:  http://localhost:$PIPER_PORT"
fi
echo ""
echo " Press Ctrl+C in THIS terminal to stop everything."
echo "======================================================================"
echo ""

if command -v open >/dev/null 2>&1; then
  open "http://localhost:$UI_PORT" 2>/dev/null || true
fi

# Keeps this script (and its trap) alive until Ctrl+C - `wait -n` (wait
# for just the first of several jobs) needs bash 4.3+, but macOS ships
# bash 3.2 as /bin/bash by default (Apple won't ship a newer GPLv3 bash),
# so this deliberately uses plain `wait` instead for portability. Ctrl+C
# still stops everything immediately either way, since SIGINT interrupts
# the wait and fires the INT trap above - the only tradeoff is that if one
# server crashed on its own (rare - all three are covered by real error
# handling now) while the others kept running, this would sit waiting for
# the survivors too instead of noticing the crash right away.
wait
