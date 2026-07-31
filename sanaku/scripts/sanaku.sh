#!/bin/sh
# ============================================================================
# sanaku - one control script for day-to-day Sanaku operations.
#
#   sanaku.sh status      health check + current prospect counts (read-only)
#   sanaku.sh scrape      install/update W1 on n8n and run it now
#   sanaku.sh dashboard   deploy the internal command center to Netlify
#   sanaku.sh site        deploy the public landing page to Netlify
#   sanaku.sh config      re-enter the stored keys
#
# Works in sh / bash / zsh, on macOS or inside a Docker container. Keys are
# stored once in ~/.sanaku.env (chmod 600) so no command ever needs secrets
# pasted into it again.
#
# Install:
#   curl -fsSL https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/claude/n8n-prospect-tiering-hgkjb0/sanaku/scripts/sanaku.sh -o ~/sanaku.sh
#   sh ~/sanaku.sh status
# ============================================================================
set -eu

BRANCH="claude/n8n-prospect-tiering-hgkjb0"
RAW="https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/${BRANCH}/sanaku/scripts"
CONFIG="$HOME/.sanaku.env"

# ---------------------------------------------------------------- utilities
say()  { printf '%s\n' "$*"; }
head1() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
ok()   { printf '  . %s\n' "$*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    say "Missing required command: $1"
    [ "$1" = "npm" ] && say "  In Docker? Netlify deploys need Node. Run this one on your Mac, or use a node: image."
    exit 1
  }
}

# Prompt for one value. Works in every shell (no zsh 'read VAR?prompt' syntax).
ask() { # ask VARNAME "Human label" [hidden]
  _var="$1"; _label="$2"; _hidden="${3:-}"
  printf '%s\n> ' "$_label"
  if [ -n "$_hidden" ] && [ -t 0 ]; then
    stty -echo 2>/dev/null || true
    read -r _val
    stty echo 2>/dev/null || true
    printf '\n'
  else
    read -r _val
  fi
  eval "$_var=\$_val"
}

save_config() {
  umask 077
  cat > "$CONFIG" <<EOF
N8N_URL='$N8N_URL'
N8N_KEY='$N8N_KEY'
SUPABASE_URL='$SUPABASE_URL'
SUPABASE_SERVICE_KEY='$SUPABASE_SERVICE_KEY'
SUPABASE_ANON_KEY='$SUPABASE_ANON_KEY'
SERPAPI_KEY='$SERPAPI_KEY'
OWNER_EMAIL='$OWNER_EMAIL'
EOF
  chmod 600 "$CONFIG"
  ok "saved to $CONFIG (readable only by you)"
}

load_config() {
  N8N_URL=""; N8N_KEY=""; SUPABASE_URL=""; SUPABASE_SERVICE_KEY=""
  SUPABASE_ANON_KEY=""; SERPAPI_KEY=""; OWNER_EMAIL=""
  # shellcheck disable=SC1090
  if [ -f "$CONFIG" ]; then . "$CONFIG"; fi
  return 0   # must not return non-zero on first run - set -e would abort here
}

# Prompt only for what's missing, then persist.
ensure_config() { # ensure_config key1 key2 ...
  _missing=""
  for _k in "$@"; do
    eval "_cur=\${$_k:-}"
    [ -z "$_cur" ] && _missing="$_missing $_k"
  done
  [ -z "$_missing" ] && return 0

  head1 "Setup"
  say "Storing these once in $CONFIG so you never paste them again."
  for _k in $_missing; do
    case "$_k" in
      N8N_URL)              ask N8N_URL "n8n URL (e.g. http://64.227.100.126:5678)";;
      N8N_KEY)              ask N8N_KEY "n8n API key (n8n > Settings > n8n API)" hidden;;
      SUPABASE_URL)         ask SUPABASE_URL "Supabase project URL (https://xxx.supabase.co)";;
      SUPABASE_SERVICE_KEY) ask SUPABASE_SERVICE_KEY "Supabase service_role key" hidden;;
      SUPABASE_ANON_KEY)    ask SUPABASE_ANON_KEY "Supabase anon public key" hidden;;
      SERPAPI_KEY)          ask SERPAPI_KEY "SerpAPI key (serpapi.com)" hidden;;
      OWNER_EMAIL)          ask OWNER_EMAIL "Your email (for digests/alerts)";;
    esac
  done
  N8N_URL="${N8N_URL%/}"
  SUPABASE_URL="${SUPABASE_URL%/}"
  save_config
}

sb() { # sb <path-and-query>  -> GET against Supabase REST
  curl -fsS -m 20 \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" \
    "$SUPABASE_URL/rest/v1/$1"
}

fetch_engine() { # fetch_engine <script-name>
  curl -fsSL "$RAW/$1" -o "$HOME/.sanaku-$1"
  printf '%s\n' "$HOME/.sanaku-$1"
}

# ---------------------------------------------------------------- commands
cmd_status() {
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY

  head1 "Connections"
  if curl -fsS -m 15 -H "X-N8N-API-KEY: $N8N_KEY" "$N8N_URL/api/v1/workflows?limit=1" >/dev/null 2>&1; then
    ok "n8n reachable at $N8N_URL"
  else
    warn "n8n NOT reachable at $N8N_URL (server down, or the API key was regenerated)"
  fi
  if sb "sanaku_prospects?select=id&limit=1" >/dev/null 2>&1; then
    ok "Supabase reachable"
  else
    warn "Supabase NOT reachable (check the project URL / service_role key)"
    return 0
  fi

  head1 "Pipeline"
  sb "sanaku_prospects?select=tier,status,contact_email,contact_phone,first_seen" 2>/dev/null | python3 -c '
import sys, json
try:
    rows = json.load(sys.stdin)
except Exception:
    print("  (could not read prospects)"); raise SystemExit
if not rows:
    print("  no prospects yet - run:  sanaku.sh scrape"); raise SystemExit
tiers = {}
for r in rows:
    t = r.get("tier")
    tiers[t] = tiers.get(t, 0) + 1
have_email = sum(1 for r in rows if r.get("contact_email"))
have_phone = sum(1 for r in rows if r.get("contact_phone"))
statuses = {}
for r in rows:
    s = r.get("status") or "?"
    statuses[s] = statuses.get(s, 0) + 1
last = max((r.get("first_seen") or "") for r in rows)
print("  %d prospects | Tier 1: %d  Tier 2: %d  Tier 3: %d" % (
    len(rows), tiers.get(1, 0), tiers.get(2, 0), tiers.get(3, 0)))
if tiers.get(None):
    print("  %d unscored/blocked (need a re-scrape)" % tiers[None])
print("  contactable: %d with email, %d with phone" % (have_email, have_phone))
print("  status: " + ", ".join("%s=%d" % kv for kv in sorted(statuses.items())))
print("  newest row: " + (last[:19].replace("T", " ") if last else "?"))
'

  head1 "Recent errors / skips"
  sb "sanaku_errors?select=occurred_at,error&order=occurred_at.desc&limit=5" 2>/dev/null | python3 -c '
import sys, json
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
if not rows:
    print("  none logged")
for r in rows:
    print("  %s  %s" % ((r.get("occurred_at") or "")[:19].replace("T", " "), (r.get("error") or "")[:96]))
'
  printf '\n'
}

cmd_scrape() {
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SERPAPI_KEY OWNER_EMAIL
  need_cmd python3
  _engine=$(fetch_engine setup-sanaku.sh)
  N8N_URL="$N8N_URL" N8N_KEY="$N8N_KEY" \
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  SERPAPI_KEY="$SERPAPI_KEY" OWNER_EMAIL="$OWNER_EMAIL" \
  MAX_NEW="${MAX_NEW:-20}" \
    sh "$_engine"
}

cmd_dashboard() {
  ensure_config SUPABASE_URL SUPABASE_ANON_KEY
  need_cmd npm
  say "(If prompted by Netlify: 'Link to an existing project' -> sanaku-command-center)"
  _engine=$(fetch_engine deploy-dashboard.sh)
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" sh "$_engine"
}

cmd_site() {
  need_cmd npm
  say "(If prompted by Netlify: 'Create & configure a new project', name it: sanaku)"
  _engine=$(fetch_engine deploy-site.sh)
  sh "$_engine"
}

cmd_config() {
  rm -f "$CONFIG"
  load_config
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY SERPAPI_KEY OWNER_EMAIL
  say "Done. Try:  sh ~/sanaku.sh status"
}

usage() {
  cat <<'EOF'
sanaku - control script

  sh ~/sanaku.sh status      health check + prospect counts (start here)
  sh ~/sanaku.sh scrape      run the prospect scraper now
  sh ~/sanaku.sh dashboard   deploy the internal command center
  sh ~/sanaku.sh site        deploy the public landing page
  sh ~/sanaku.sh config      re-enter stored keys

Keys are stored once in ~/.sanaku.env - no command needs secrets pasted in.
In Docker: mount a volume (-v sanaku-home:/root) so that file and the
Netlify login survive; deploys need Node in the image.
EOF
}

# ---------------------------------------------------------------- dispatch
need_cmd curl
load_config
case "${1:-}" in
  status)    cmd_status ;;
  scrape)    cmd_scrape ;;
  dashboard) cmd_dashboard ;;
  site)      cmd_site ;;
  config)    cmd_config ;;
  *)         usage ;;
esac
