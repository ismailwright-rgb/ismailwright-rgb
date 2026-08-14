#!/usr/bin/env bash
# Builds a clean, shippable bundle of this project — a single zip file
# that can be copied to a brand-new machine and installed with nothing
# else needed from this repo/checkout. Exists specifically so onboarding
# a new client is "unzip, run two scripts, drop in their documents" —
# not "figure out which of these files are safe to copy over."
#
# Uses `git archive`, not a hand-maintained copy/exclude list — this
# repo's own .gitignore already draws the exact line that matters here
# (nothing per-client or environment-specific is ever tracked: no
# config/client.json, no data/, no .venv-dev, no web/node_modules, no
# __pycache__/.pytest_cache). `git archive` only ever includes tracked
# files, so it can't drift from that list the way a separately-maintained
# exclude list could - the same rule enforces both "what's safe to
# commit" and "what's safe to ship" with no second list to keep in sync.
#
# What IS included, deliberately: sample_cases/ (the fictional "Maria
# Delgado" demo case) - harmless, useful for showing a new client how the
# tool behaves before their own documents are loaded, and clearly labeled
# fictional throughout. config/client.example.json (not client.json) -
# the template every new install/new client starts from, never a real
# firm's actual branding.
#
# Usage:
#   ./scripts/package-release.sh              # names the zip from the current date
#   ./scripts/package-release.sh v1
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: not a git checkout - git archive needs one to know what's tracked."
  exit 1
fi

LABEL="${1:-$(date +%Y-%m-%d)}"
DIST_DIR="$PROJECT_ROOT/dist"
OUT_FILE="$DIST_DIR/sanaku-case-intel-${LABEL}.zip"
mkdir -p "$DIST_DIR"

# Warn, don't block - an uncommitted local fix is a real reason to
# package anyway sometimes, but silently shipping something that isn't
# what's in git history would be worse than a loud reminder here.
if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: you have uncommitted changes - this bundle will NOT include them"
  echo "(git archive only ever packages what's actually committed). Commit first"
  echo "if they're meant to ship."
  echo ""
fi

echo "==> Packaging $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD) into:"
echo "    $OUT_FILE"
git archive --format=zip --prefix="sanaku-case-intel/" -o "$OUT_FILE" HEAD

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo ""
echo "==> Done. $OUT_FILE ($SIZE)"
echo ""
echo "This zip is the entire hand-off artifact for a new machine - nothing"
echo "else from this checkout needs to go with it. On the new machine:"
echo "    unzip $(basename "$OUT_FILE")"
echo "    cd sanaku-case-intel"
echo "    bash scripts/setup.sh"
echo "    bash scripts/new-client.sh   # see docs/new-client-playbook.md"
