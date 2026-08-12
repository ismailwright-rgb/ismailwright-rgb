#!/usr/bin/env bash
# ============================================================================
# Sanaku dashboard one-shot deploy to Netlify (no browser UI needed).
#
#   1. Downloads the dashboard source from GitHub
#   2. Builds it with your Supabase URL + anon key baked in
#   3. Logs into Netlify via CLI (first run opens a browser ONCE to authorize)
#   4. Creates/links a Netlify site and deploys to production
#
# Usage:
#   SUPABASE_URL=https://ref.supabase.co \
#   SUPABASE_ANON_KEY=<anon public key> \
#   bash deploy-dashboard.sh
#
# Requires: node/npm (checked below), curl, tar. Never commit key values here.
# NOTE: this creates a CLI-managed site (not git-connected). To ship dashboard
# updates later, just re-run this script - it redeploys the same site.
# ============================================================================
set -euo pipefail

: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_ANON_KEY:?Set SUPABASE_ANON_KEY (the anon PUBLIC key, not service_role)}"

if ! command -v npm >/dev/null 2>&1; then
  echo "npm/node not found. Install Node first:  brew install node   (then re-run)"
  exit 1
fi

BRANCH="claude/n8n-prospect-tiering-hgkjb0"
TARBALL="https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)"
WORK="$HOME/.sanaku-dashboard-build"

echo "==> Downloading dashboard source..."
rm -rf "$WORK" && mkdir -p "$WORK"
curl -fsSL "$TARBALL" | tar xz -C "$WORK" --strip-components=1
cd "$WORK/sanaku/dashboard"

echo "==> Installing dependencies (first time takes ~1 min)..."
npm install --no-audit --no-fund --loglevel=error

echo "==> Building with your Supabase config baked in..."
VITE_SUPABASE_URL="$SUPABASE_URL" VITE_SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  VITE_N8N_WEBHOOK_BASE="${N8N_URL:+$N8N_URL/webhook}" npm run build

# ----------------------------------------------------------------------------
# Refuse to deploy a bundle with no database in it
# ----------------------------------------------------------------------------
# Vite inlines import.meta.env at BUILD time. If the VITE_ variables are absent
# it does not warn - it emits a bundle where the config is simply gone, and the
# result is a dashboard that loads, runs, and shows nothing.
#
# That shipped on 2026-08-12, from a hand-run `npm run build` in a checkout with
# no .env. The deploy succeeded, every asset returned 200, and the page was
# blank. Checking HTTP status told us nothing, because the server was fine.
#
# The bundle either contains the Supabase host or it does not, and that is
# cheap to assert. Anything that reaches Netlify has passed this.
echo "==> Verifying the build actually contains its configuration..."
SUPA_HOST="$(printf '%s' "$SUPABASE_URL" | sed -E 's#^https?://##; s#/.*##')"
if ! grep -rqF "$SUPA_HOST" dist/assets/*.js 2>/dev/null; then
  echo ""
  echo "REFUSING TO DEPLOY: no Supabase host found in the built bundle."
  echo "  expected to find: $SUPA_HOST"
  echo ""
  echo "  The build ran without VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY."
  echo "  Deploying this would replace the dashboard with a blank page."
  exit 1
fi
echo "    ok - $SUPA_HOST is baked in"

echo "==> Netlify login (a browser tab may open ONCE - click 'Authorize')..."
npx -y netlify-cli@17 status >/dev/null 2>&1 || npx -y netlify-cli@17 login

echo "==> Deploying to production..."
echo "    If prompted: choose 'Create & configure a new project', accept the"
echo "    default team, and press enter for a random site name (or type one,"
echo "    e.g. sanaku-command-center)."
npx -y netlify-cli@17 deploy --prod --dir dist

echo ""
echo "Done. The 'Website URL' above is your COMMAND CENTER."
echo "  You sign in there and get Pipeline / Clients / Earnings."
echo "  A client signs in to the SAME address and gets their own portal instead."
echo "  This is a different site from your public landing page (sanaku.sh site)."
echo "Log in with the user you created in Supabase Authentication."
