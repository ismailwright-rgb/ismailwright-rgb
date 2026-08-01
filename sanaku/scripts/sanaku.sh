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
  # Catch template placeholders left unreplaced - they look like valid input.
  case "$_v" in
    *PASTE_*|*YOUR_*|*_HERE*|*xxxxx*|*XXXXX*|'<'*'>')
      printf 'that is the placeholder text, not a real value'
      return 0 ;;
  esac
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
DASHBOARD_URL='$DASHBOARD_URL'
EOF
  chmod 600 "$CONFIG"
  ok "saved to $CONFIG (readable only by you)"
}

KEYS="N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY SERPAPI_KEY OWNER_EMAIL DASHBOARD_URL"

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
      DASHBOARD_URL)        ask DASHBOARD_URL "Command center URL (where client invite links land)" url;;
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

cmd_import() { # cmd_import WORKFLOW-NAME
  _wf="${1:-}"
  if [ -z "$_wf" ]; then
    say "Usage: sh ~/sanaku.sh import <workflow-name>"
    say "e.g.   sh ~/sanaku.sh import invite-client-user"
    exit 1
  fi
  case "$_wf" in *.json) ;; *) _wf="$_wf.json" ;; esac
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY
  need_cmd python3
  _engine=$(fetch_engine import-workflow.sh)
  N8N_URL="$N8N_URL" N8N_KEY="$N8N_KEY" \
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  OWNER_EMAIL="${OWNER_EMAIL:-}" SERPAPI_KEY="${SERPAPI_KEY:-}" \
  DASHBOARD_URL="${DASHBOARD_URL:-https://sanaku-command-center.netlify.app}" \
  WF_FILE="$_wf" \
    sh "$_engine"
}

cmd_dashboard() {
  ensure_config SUPABASE_URL SUPABASE_ANON_KEY N8N_URL
  need_cmd npm
  say "(If prompted by Netlify: 'Link to an existing project' -> sanaku-command-center)"
  _engine=$(fetch_engine deploy-dashboard.sh)
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" N8N_URL="$N8N_URL" sh "$_engine"
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

# Show what the last scraper run actually did, node by node.
cmd_logs() {
  ensure_config N8N_URL N8N_KEY
  need_cmd python3
  _wf=$(curl -fsS -m 20 -H "X-N8N-API-KEY: $N8N_KEY" "$N8N_URL/api/v1/workflows?limit=250" \
    | python3 -c '
import sys, json
d = json.load(sys.stdin)
for w in d.get("data", []):
    if w.get("name") == "Sanaku - W1 Prospect Scraper & Scorer":
        print(w["id"]); break
')
  if [ -z "$_wf" ]; then warn "W1 is not installed on this n8n - run: sh ~/sanaku.sh scrape"; return 0; fi

  curl -fsS -m 30 -H "X-N8N-API-KEY: $N8N_KEY" \
    "$N8N_URL/api/v1/executions?workflowId=$_wf&limit=1&includeData=true" | python3 -c '
import sys, json
d = json.load(sys.stdin)
runs = d.get("data") or []
if not runs:
    print("  no executions yet"); raise SystemExit
e = runs[0]
rd = (e.get("data") or {}).get("resultData") or {}
err = rd.get("error") or {}
print("\n\033[1mLast run\033[0m")
print("  status:       %s" % e.get("status"))
print("  started:      %s" % (e.get("startedAt") or "")[:19].replace("T", " "))
print("  last node:    %s" % rd.get("lastNodeExecuted"))
if err:
    print("  ERROR at %s: %s" % ((err.get("node") or {}).get("name"), str(err.get("message"))[:160]))
print("\n\033[1mWhat each step produced\033[0m")
run = rd.get("runData") or {}
order = ["Run Config", "Get Existing Prospects", "Build Vertical Queries", "Maps Search (SerpAPI)",
         "Filter & Dedupe", "Collect Candidates", "Per Company", "Fetch Robots", "Check Robots",
         "Robots OK?", "Fetch Website", "Detect & Score", "Keep Unfetchable Lead", "Collect Scored",
         "Cap Reveals", "Build Upsert Rows", "Upsert Prospects"]
seen = set()
for name in order + [n for n in run if n not in order]:
    if name not in run or name in seen:
        continue
    seen.add(name)
    entries = run[name]
    total = 0
    errs = []
    for r in entries:
        for out in ((r.get("data") or {}).get("main") or []):
            total += len(out or [])
        if r.get("error"):
            errs.append(str(r["error"].get("message"))[:90])
    flag = ("  ERR: " + errs[0]) if errs else ""
    print("  %-24s runs:%-4d items out:%-5d%s" % (name[:24], len(entries), total, flag))
rows = run.get("Build Upsert Rows")
if rows:
    try:
        payload = rows[0]["data"]["main"][0][0]["json"]
        print("\n\033[1mRows the run tried to save\033[0m")
        print("  %d rows | counts: %s" % (len(payload.get("rows") or []), json.dumps(payload.get("counts") or {})))
    except Exception:
        pass
print()
'
}


# Inspect the live system and print the ONE next thing to do.
cmd_next() {
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY
  head1 "Next step"

  # 1. migrations applied?
  if ! sb "sanaku_notes?select=id&limit=1" >/dev/null 2>&1; then
    say "  Run the database update."
    say ""
    say "  Supabase -> SQL Editor -> New query, paste this file, Run:"
    say "  https://github.com/ismailwright-rgb/ismailwright-rgb/blob/${BRANCH}/sanaku/supabase/RUN-THIS-NOW.sql"
    say ""
    say "  (Until you do, your prospect list is readable by anyone with a login.)"
    return 0
  fi
  ok "database is up to date"

  # 2. real SerpAPI key?
  case "$SERPAPI_KEY" in
    ''|*PASTE_*|*YOUR_*)
      say ""
      say "  Set your real SerpAPI key (serpapi.com/manage-api-key):"
      say "    sh ~/sanaku.sh set SERPAPI_KEY <your-key>"
      return 0 ;;
  esac
  ok "scraper key is set"

  # 3. any prospects?
  _n=$(sb "sanaku_prospects?select=id" 2>/dev/null | tr -cd '{' | wc -c | tr -d ' ')
  if [ "${_n:-0}" -lt 1 ]; then
    say ""
    say "  Find some prospects:"
    say "    sh ~/sanaku.sh scrape"
    return 0
  fi
  ok "$_n prospects in the database"

  # 4. any clients?
  _c=$(sb "sanaku_clients?select=id" 2>/dev/null | tr -cd '{' | wc -c | tr -d ' ')
  if [ "${_c:-0}" -lt 1 ]; then
    say ""
    say "  Everything is built. The next move is not technical:"
    say ""
    say "    1. Open sanaku-command-center.netlify.app"
    say "    2. Filter to Tier 1 + Home services"
    say "    3. Open the top prospect, Copy call script, and dial"
    say "    4. Log the call in the drawer, set a follow-up, next one"
    say ""
    say "  When someone says yes: Clients -> Onboard client."
    return 0
  fi
  ok "$_c client(s) onboarded"
  say ""
  say "  Check what they owe you:  the Earnings tab"
  say "  Deploy their workflow:    sh ~/sanaku.sh import t1-missed-call-textback"
  printf '\n'
}

cmd_config() { # [KEY ...] - with names, re-ask only those; otherwise all
  if [ "$#" -gt 0 ]; then
    for _k in "$@"; do
      case " $KEYS " in
        *" $_k "*) eval "$_k=''" ;;
        *) say "Unknown key: $_k"; say "Valid: $KEYS"; exit 1 ;;
      esac
    done
    # shellcheck disable=SC2086
    ensure_config $KEYS
  else
    for _k in $KEYS; do
      eval "_ev=\${$_k:-}"
      if [ -z "$_ev" ]; then eval "$_k=''"; fi
    done
    rm -f "$CONFIG"
    # shellcheck disable=SC2086
    ensure_config $KEYS
  fi
  say ""
  say "Done. Try:  sh ~/sanaku.sh status"
}

# Set one value passed as an argument. Pasting at the shell prompt is clean in
# terminals that mangle `read` prompts, so this is the most reliable path.
cmd_set() { # cmd_set KEYNAME VALUE
  _target="${1:-}"; _value="${2:-}"
  case " $KEYS " in
    *" $_target "*) ;;
    *) say "Usage: sh ~/sanaku.sh set KEYNAME VALUE"; say "Valid: $KEYS"; exit 1 ;;
  esac
  [ -n "$_value" ] || { say "No value given. Usage: sh ~/sanaku.sh set $_target <value>"; exit 1; }

  case "$_target" in
    *URL)        _kind=url ;;
    *EMAIL)      _kind=email ;;
    SERPAPI_KEY) _kind=key ;;
    *KEY)        _kind=jwt ;;
    *)           _kind=key ;;
  esac
  _err=$(validate "$_kind" "$_value")
  if [ -n "$_err" ]; then warn "rejected: $_err"; exit 1; fi

  eval "$_target=\$_value"
  # shellcheck disable=SC2086
  ensure_config $KEYS
  save_config
  ok "$_target set: $(preview "$_value")"
  say "Check it with:  sh ~/sanaku.sh doctor"
}

# Read a value straight from the system clipboard - bypasses the terminal's
# paste handling entirely, which some terminals use to mask (and destroy) secrets.
cmd_paste() { # cmd_paste KEYNAME
  _target="${1:-}"
  case " $KEYS " in
    *" $_target "*) ;;
    *) say "Usage: sh ~/sanaku.sh paste KEYNAME"; say "Valid: $KEYS"; exit 1 ;;
  esac

  if command -v pbpaste >/dev/null 2>&1; then _clip=$(pbpaste)
  elif command -v xclip >/dev/null 2>&1; then _clip=$(xclip -o -selection clipboard)
  elif command -v powershell.exe >/dev/null 2>&1; then _clip=$(powershell.exe -c Get-Clipboard | tr -d '\r')
  else
    say "No clipboard tool found (pbpaste/xclip). Use: sh ~/sanaku.sh config $_target"
    exit 1
  fi
  _clip=$(printf '%s' "$_clip" | tr -d '\n\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')

  case "$_target" in
    *URL)   _kind=url ;;
    *EMAIL) _kind=email ;;
    SERPAPI_KEY) _kind=key ;;
    *KEY)   _kind=jwt ;;
    *)      _kind=key ;;
  esac
  _err=$(validate "$_kind" "$_clip")
  if [ -n "$_err" ]; then
    warn "clipboard content rejected: $_err"
    exit 1
  fi
  eval "$_target=\$_clip"
  # shellcheck disable=SC2086
  ensure_config $KEYS   # fills anything else still missing
  save_config
  ok "$_target set from clipboard: $(preview "$_clip")"
  say "Check it with:  sh ~/sanaku.sh doctor"
}

usage() {
  cat <<'EOF'
sanaku - control script

  sh ~/sanaku.sh next        what should I do right now? (start here)
  sh ~/sanaku.sh status      health check + prospect counts
  sh ~/sanaku.sh doctor      diagnose connection/key problems step by step
  sh ~/sanaku.sh logs        show what the last scraper run did, node by node
  sh ~/sanaku.sh scrape      run the prospect scraper now
  sh ~/sanaku.sh import NAME  install a workflow into n8n (see list below)
  sh ~/sanaku.sh dashboard   deploy the internal command center
  sh ~/sanaku.sh site        deploy the public landing page
  sh ~/sanaku.sh config      re-enter stored keys (add names to redo just those)
  sh ~/sanaku.sh paste KEY   read one value straight from the system clipboard
  sh ~/sanaku.sh set KEY VAL set one value directly (paste the value on the line)

Workflow names for 'import' (the .json suffix is optional):
  invite-client-user     let a client sign in to their portal
  t1-missed-call-textback  the missed-call product
  t1-reply-handler       replies to those texts
  w2-outreach-sequencer  cold outreach
  w2b-reply-handler      classifies prospect replies
  w3-demo-booking        booking page + calendar

Import through this script, NOT the n8n UI: the files reference environment
variables and credentials a stock n8n does not have, so a UI import saves
cleanly and then fails at run time.

If your terminal mangles pasted secrets into bullets, copy the key in the
dashboard and use:  sh ~/sanaku.sh paste N8N_KEY

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
  logs)      cmd_logs ;;
  next)      cmd_next ;;
  scrape)    cmd_scrape ;;
  import)    shift; cmd_import "$@" ;;
  dashboard) cmd_dashboard ;;
  site)      cmd_site ;;
  config)    shift; cmd_config "$@" ;;
  paste)     shift; cmd_paste "$@" ;;
  set)       shift; cmd_set "$@" ;;
  *)         usage ;;
esac
