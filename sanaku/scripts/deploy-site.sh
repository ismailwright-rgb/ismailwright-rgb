#!/usr/bin/env bash
# ============================================================================
# Sanaku landing page one-shot deploy to Netlify.
# Static page - no build step, no env vars, nothing secret.
#
# Usage:  bash deploy-site.sh
#
# Reuses the Netlify CLI login already authorized on this machine (from the
# dashboard deploy). Creates a SECOND Netlify site for the public page -
# when prompted, choose "Create & configure a new project" and name it
# something like  sanaku  (=> https://sanaku.netlify.app if free).
# Re-run anytime to ship updates; choose "Link to an existing project" then.
# ============================================================================
set -euo pipefail

BRANCH="claude/n8n-prospect-tiering-hgkjb0"
TARBALL="https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)"
WORK="$HOME/.sanaku-site-build"

echo "==> Downloading site source..."
rm -rf "$WORK" && mkdir -p "$WORK"
curl -fsSL "$TARBALL" | tar xz -C "$WORK" --strip-components=1
cd "$WORK/sanaku/site"

echo "==> Netlify login check (a browser tab may open once - click Authorize)..."
npx -y netlify-cli@17 status >/dev/null 2>&1 || npx -y netlify-cli@17 login

echo "==> Deploying to production..."
echo "    If prompted: 'Create & configure a new project' -> default team ->"
echo "    site name: sanaku (or leave blank for a random one)."
npx -y netlify-cli@17 deploy --prod --dir .

echo ""
echo "Done. The 'Website URL' above is your public landing page."
