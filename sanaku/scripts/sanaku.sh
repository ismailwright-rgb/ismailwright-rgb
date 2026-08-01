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

# Show a short preview of a secret so it can be eyeballed without full exposure.
preview() {
  _p="$1"; _len=$(printf '%s' "$_p" | wc -c | tr -d ' ')
  if [ "$_len" -gt 20 ]; then
    printf '%s...%s (%s chars)' "$(printf '%s' "$_p" | cut -c1-10)" \
      "$(printf '%s' "$_p" | rev | cut -c1-4 | rev)" "$_len"
  else
    printf '%s' "$_p"
  fi
}

# Validate a value by kind. Echoes an error string on failure, nothing on success.
validate() { # validate KIND VALUE
  _kind="$1"; _v="$2"
  [ -z "$_v" ] && { printf 'nothing entered'; return; }
  case "$_kind" in
    url)
      case "$_v" in
        http://*|https://*) ;;
        *) printf 'must start with http:// or https://' ;;
      esac
      ;;
    jwt)
      case "$_v" in
        eyJ*) ;;
        *) printf 'should start with "eyJ" - copy it again with the COPY BUTTON rather than selecting the text'; return 0 ;;
      esac
      # A JWT is base64url + dots ONLY. Some terminals silently replace pasted
      # secrets with bullet characters - that passes a length check but is junk.
      _bad=$(printf '%s' "$_v" | tr -d 'A-Za-z0-9_.-')
      if [ -n "$_bad" ]; then
        printf 'contains characters a JWT cannot have (your terminal replaced the paste with bullets or similar) - open the key in the dashboard and use its COPY BUTTON, or see the TextEdit method in the README'
        return 0
      fi
      _n=$(printf '%s' "$_v" | wc -c | tr -d ' ')
      [ "$_n" -lt 100 ] && printf 'looks truncated (%s chars, expected 200+) - copy it again with the copy button' "$_n"
      ;;
    key)
      _n=$(printf '%s' "$_v" | wc -c | tr -d ' ')
      if [ "$_n" -lt 20 ]; then printf 'looks too short (%s chars)' "$_n"; return 0; fi
      _bad=$(printf '%s' "$_v" | tr -d 'A-Za-z0-9_.:/-')
      [ -n "$_bad" ] && printf 'contains unexpected characters - the paste may have been mangled by your terminal'
      ;;
    email)
      case "$_v" in
        *@*.*) ;;
        *) printf 'does not look like an email address' ;;
      esac
      ;;
  esac
  return 0   # a passing test (e.g. [ n -lt 100 ] = false) must not abort set -e
}

# Prompt for one value. Visible by design: masked prompts silently swallow
# pastes in Docker Desktop and other embedded terminals. Validates at entry.
ask() { # ask VARNAME "Human label" KIND
  _var="$1"; _label="$2"; _kind="${3:-key}"
  _try=0
  while [ "$_try" -lt 3 ]; do
    _try=$((_try + 1))
    printf '\n%s\n> ' "$_label"
    read -r _val || _val=""
    _err=$(validate "$_kind" "$_val")
    if [ -z "$_err" ]; then
      case "$_kind" in
        jwt|key) printf '  accepted: %s\n' "$(preview "$_val")" ;;
        *)       printf '  accepted: %s\n' "$_val" ;;
      esac
      eval "$_var=\$_val"
      return 0
    fi
    printf '  ! %s\n' "$_err"
    [ -t 0 ] || break   # piped input: do not loop forever
  done
  say "Could not read a valid value for $_var. Fix and re-run:  sh ~/sanaku.sh config"
  exit 1
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

KEYS="N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY SERPAPI_KEY OWNER_EMAIL"

load_config() {
  # Values passed in the environment win over the stored file, so a fully
  # non-interactive setup is possible:  N8N_KEY=... sh sanaku.sh config
  for _k in $KEYS; do
    eval "_env_$_k=\${$_k:-}"
    eval "$_k=''"
  done
  # shellcheck disable=SC1090
  if [ -f "$CONFIG" ]; then . "$CONFIG"; fi
  for _k in $KEYS; do
    eval "_ev=\$_env_$_k"
    if [ -n "$_ev" ]; then eval "$_k=\$_ev"; fi
  done
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
  say "(Values are shown as you paste them - masked prompts break pasting in Docker.)"
  for _k in $_missing; do
    case "$_k" in
      N8N_URL)              ask N8N_URL "n8n URL (e.g. http://64.227.100.126:5678)" url;;
      N8N_KEY)              ask N8N_KEY "n8n API key (n8n > Settings > n8n API)" jwt;;
      SUPABASE_URL)         ask SUPABASE_URL "Supabase project URL (https://xxx.supabase.co)" url;;
      SUPABASE_SERVICE_KEY) ask SUPABASE_SERVICE_KEY "Supabase service_role key (Project Settings > API)" jwt;;
      SUPABASE_ANON_KEY)    ask SUPABASE_ANON_KEY "Supabase anon public key (Project Settings > API)" jwt;;
      SERPAPI_KEY)          ask SERPAPI_KEY "SerpAPI key (serpapi.com/manage-api-key)" key;;
      OWNER_EMAIL)          ask OWNER_EMAIL "Your email (for digests/alerts)" email;;
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

cmd_doctor() {
  head1 "1. Stored values"
  if [ ! -f "$CONFIG" ]; then
    warn "no config yet - run: sh ~/sanaku.sh config"
    return 0
  fi
  for _k in $KEYS; do
    eval "_v=\${$_k:-}"
    _n=$(printf '%s' "$_v" | wc -c | tr -d ' ')
    if [ -z "$_v" ]; then
      printf '  - %-22s (not set)\n' "$_k"
      continue
    fi
    case "$_k" in
      *KEY)
        _bad=$(printf '%s' "$_v" | tr -d 'A-Za-z0-9_.:/-')
        if [ -n "$_bad" ]; then
          printf '  ! %-22s %s chars - MANGLED (terminal replaced the paste)\n' "$_k" "$_n"
        else
          printf '  . %-22s %s chars - characters look valid\n' "$_k" "$_n"
        fi
        ;;
      *) printf '  . %-22s %s\n' "$_k" "$_v" ;;
    esac
  done

  head1 "2. Can this machine reach the servers at all? (no keys used)"
  _code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$N8N_URL/" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  if [ "$_code" = "000" ]; then
    warn "n8n: no response at all - the droplet or its n8n container is DOWN (or blocked by a firewall)"
  else
    ok "n8n: responded HTTP $_code - the server is up"
  fi
  _code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$SUPABASE_URL/rest/v1/" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  if [ "$_code" = "000" ]; then
    warn "supabase: no response - check your internet connection or the project URL"
  else
    ok "supabase: responded HTTP $_code (401 here is normal - no key was sent)"
  fi

  head1 "3. Do the keys work?"
  _code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "X-N8N-API-KEY: $N8N_KEY" "$N8N_URL/api/v1/workflows?limit=1" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  case "$_code" in
    200) ok  "n8n key: valid" ;;
    401) warn "n8n key: REJECTED - mint a new one in n8n > Settings > n8n API, then: sh ~/sanaku.sh config" ;;
    000) warn "n8n key: untestable while the server is unreachable (see step 2)" ;;
    *)   warn "n8n key: unexpected HTTP $_code" ;;
  esac
  _code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" "$SUPABASE_URL/rest/v1/sanaku_prospects?select=id&limit=1" 2>/dev/null) || true
  [ -n "$_code" ] || _code=000
  case "$_code" in
    200) ok  "supabase key: valid" ;;
    401) warn "supabase key: REJECTED - re-copy the service_role key (Project Settings > API)" ;;
    404) warn "supabase key: works, but table sanaku_prospects is missing - run supabase/schema.sql" ;;
    000) warn "supabase key: untestable (see step 2)" ;;
    *)   warn "supabase: unexpected HTTP $_code" ;;
  esac
  printf '\n'
}

cmd_config() {
  # Anything supplied via the environment is kept; the rest is re-asked.
  for _k in $KEYS; do
    eval "_ev=\${$_k:-}"
    if [ -z "$_ev" ]; then eval "$_k=''"; fi
  done
  rm -f "$CONFIG"
  # shellcheck disable=SC2086
  ensure_config $KEYS
  say ""
  say "Done. Try:  sh ~/sanaku.sh status"
}

usage() {
  cat <<'EOF'
sanaku - control script

  sh ~/sanaku.sh status      health check + prospect counts (start here)
  sh ~/sanaku.sh doctor      diagnose connection/key problems step by step
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
  doctor)    cmd_doctor ;;
  scrape)    cmd_scrape ;;
  dashboard) cmd_dashboard ;;
  site)      cmd_site ;;
  config)    cmd_config ;;
  *)         usage ;;
esac
