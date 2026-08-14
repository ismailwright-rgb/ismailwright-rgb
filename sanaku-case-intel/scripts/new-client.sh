#!/usr/bin/env bash
# One-shot per-client bootstrap: turns a freshly-unzipped/cloned checkout
# into a specific client's branded, ready-to-load install. This is the
# ONLY step meant to change client to client - everything else about
# installing this project (scripts/setup.sh, scripts/dev.sh) is identical
# every single time, on purpose, so that repeating this project for a new
# customer is "run this one script with their details, then load their
# documents," not a fresh strenuous setup each time.
#
# Safe to run non-interactively (all details passed as flags - the
# expected way to run this from an automated hand-off or from another
# Claude session following docs/new-client-playbook.md's prompt) or
# interactively (missing flags are prompted for one at a time).
#
# Usage:
#   ./scripts/new-client.sh \
#     --firm-name "Smith & Associates LLP" \
#     --primary "#0B3D2E" --secondary "#C9A24B" --accent "#F4F1EA" \
#     --case-id smith_v_acme \
#     [--logo /path/to/logo.png] \
#     [--gen-model llama3.1:8b] [--embed-model nomic-embed-text]
#
# Or with no flags at all, from a real terminal, to be prompted for each.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

FIRM_NAME=""
PRIMARY=""
SECONDARY=""
ACCENT=""
LOGO_SRC=""
CASE_ID=""
GEN_MODEL="llama3.1:8b"
EMBED_MODEL="nomic-embed-text"

while [ $# -gt 0 ]; do
  case "$1" in
    --firm-name) FIRM_NAME="$2"; shift 2 ;;
    --primary) PRIMARY="$2"; shift 2 ;;
    --secondary) SECONDARY="$2"; shift 2 ;;
    --accent) ACCENT="$2"; shift 2 ;;
    --logo) LOGO_SRC="$2"; shift 2 ;;
    --case-id) CASE_ID="$2"; shift 2 ;;
    --gen-model) GEN_MODEL="$2"; shift 2 ;;
    --embed-model) EMBED_MODEL="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --firm-name NAME --primary '#hex' --secondary '#hex' --accent '#hex' --case-id id [--logo path] [--gen-model name] [--embed-model name]"
      exit 0
      ;;
    *) echo "Unrecognized argument: $1" >&2; exit 1 ;;
  esac
done

# Any required field left blank falls back to an interactive prompt, but
# ONLY if this is actually a terminal - a non-interactive caller (a
# script, an agent) that left a required field out gets a clear error
# instead of `read` hanging forever waiting for input that will never
# come.
prompt_if_blank() {
  local varname="$1" label="$2" example="$3"
  local current="${!varname}"
  if [ -n "$current" ]; then return; fi
  if [ ! -t 0 ]; then
    echo "ERROR: --${varname,,} not given and this isn't an interactive terminal." >&2
    echo "Pass it as a flag: $0 --${varname//_/-} <value>" >&2
    exit 1
  fi
  read -r -p "$label${example:+ (e.g. $example)}: " REPLY
  printf -v "$varname" '%s' "$REPLY"
}

prompt_if_blank FIRM_NAME  "Firm name" "Smith & Associates LLP"
prompt_if_blank PRIMARY    "Primary brand color (hex)" "#0B3D2E"
prompt_if_blank SECONDARY  "Secondary brand color (hex)" "#C9A24B"
prompt_if_blank ACCENT     "Accent brand color (hex)" "#F4F1EA"
prompt_if_blank CASE_ID    "First case ID (lowercase, underscores, no spaces)" "smith_v_acme"

if [ -z "$FIRM_NAME" ] || [ -z "$PRIMARY" ] || [ -z "$SECONDARY" ] || [ -z "$ACCENT" ] || [ -z "$CASE_ID" ]; then
  echo "ERROR: firm name, all three colors, and a case ID are all required." >&2
  exit 1
fi

if [ ! -f config/client.example.json ]; then
  echo "ERROR: config/client.example.json is missing - this doesn't look like a" >&2
  echo "complete checkout/bundle. Re-unzip from scripts/package-release.sh's output." >&2
  exit 1
fi

# Never silently clobber an existing client's config - this script gets
# run once per new client, but the same machine could be re-run against
# by mistake, or reused for a second client's checkout at the same path.
if [ -f config/client.json ]; then
  BACKUP="config/client.json.bak-$(date +%Y%m%d%H%M%S)"
  echo "==> config/client.json already exists - backing it up to $BACKUP before overwriting."
  cp config/client.json "$BACKUP"
fi

LOGO_PATH_FIELD="config/assets/logo.png"
if [ -n "$LOGO_SRC" ]; then
  if [ ! -f "$LOGO_SRC" ]; then
    echo "ERROR: --logo file not found: $LOGO_SRC" >&2
    exit 1
  fi
  mkdir -p config/assets
  EXT="${LOGO_SRC##*.}"
  DEST="config/assets/logo.${EXT}"
  cp "$LOGO_SRC" "$DEST"
  LOGO_PATH_FIELD="$DEST"
  echo "==> Copied logo to $DEST"
else
  echo "==> No --logo given - the header will show the firm's initials until one's added."
fi

python3 - "$FIRM_NAME" "$PRIMARY" "$SECONDARY" "$ACCENT" "$LOGO_PATH_FIELD" "$GEN_MODEL" "$EMBED_MODEL" <<'PYEOF'
import json
import sys

firm_name, primary, secondary, accent, logo_path, gen_model, embed_model = sys.argv[1:8]

with open("config/client.example.json") as f:
    config = json.load(f)

config["firm_name"] = firm_name
config["colors"] = {"primary": primary, "secondary": secondary, "accent": accent}
config["logo_path"] = logo_path
config["gen_model"] = gen_model
config["embed_model"] = embed_model

with open("config/client.json", "w") as f:
    json.dump(config, f, indent=2)
    f.write("\n")
PYEOF
echo "==> Wrote config/client.json for \"$FIRM_NAME\"."

echo "==> Validating..."
if ! VALIDATION_ERR=$(python3 -c "
from core.config import load_config
load_config()
" 2>&1); then
  echo ""
  echo "ERROR: the config this script just wrote didn't validate:"
  echo "$VALIDATION_ERR" | tail -20
  exit 1
fi
echo "    valid."

mkdir -p "data/cases/${CASE_ID}/documents"
echo "==> Created data/cases/${CASE_ID}/documents/ - drop this client's case files there."

echo ""
echo "======================================================================"
echo " \"$FIRM_NAME\" is set up. Next steps:"
echo "======================================================================"
echo " 1. Copy this client's documents into:"
echo "      data/cases/${CASE_ID}/documents/"
echo " 2. Index them:"
echo "      python3 cli.py ingest --case-id ${CASE_ID}"
echo " 3. Start everything:"
echo "      bash scripts/dev.sh"
echo ""
echo " (If this is a brand-new machine and scripts/setup.sh hasn't been run"
echo " yet - Ollama installed, models pulled - do that first. See"
echo " docs/installation-guide.md.)"
echo "======================================================================"
