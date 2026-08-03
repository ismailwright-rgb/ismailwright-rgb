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
    apppass)
      # A Google app password is exactly 16 letters, shown in groups of four.
      # The `key` rule demanded 20+ characters, so a CORRECT app password was
      # rejected as "too short" - and the message sent you looking for a longer
      # secret instead of a different kind of one.
      _clean=$(printf '%s' "$_v" | tr -d ' ')
      _n=$(printf '%s' "$_clean" | wc -c | tr -d ' ')
      _sym=$(printf '%s' "$_clean" | tr -d 'A-Za-z0-9')
      if [ -n "$_sym" ]; then
        printf 'that looks like your normal Google password, not an app password. Gmail refuses account passwords over SMTP. Sign in as the sending account, then Google Account > Security > 2-Step Verification > App passwords, and copy the 16 letters it generates'
        return 0
      fi
      if [ "$_n" -ne 16 ]; then
        printf 'an app password is exactly 16 letters (you gave %s). Google Account > Security > App passwords generates it - it is not any password you chose yourself' "$_n"
        return 0
      fi
      ;;
    pat)
      case "$_v" in
        sbp_*) ;;
        *) printf 'a Supabase access token starts with "sbp_" - create one at supabase.com/dashboard/account/tokens'; return 0 ;;
      esac
      _bad=$(printf '%s' "$_v" | tr -d 'A-Za-z0-9_')
      [ -n "$_bad" ] && printf 'contains characters the token cannot have - the paste was mangled'
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
SUPABASE_PAT='$SUPABASE_PAT'
SMTP_PASS='$SMTP_PASS'
DASHBOARD_URL='$DASHBOARD_URL'
EOF
  chmod 600 "$CONFIG"
  ok "saved to $CONFIG (readable only by you)"
}

KEYS="N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY SERPAPI_KEY OWNER_EMAIL DASHBOARD_URL SUPABASE_PAT SMTP_PASS"

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
      SMTP_PASS)            ask SMTP_PASS "App password for sending client emails - 16 letters from Google, not your own password" apppass;;
      SUPABASE_PAT)         ask SUPABASE_PAT "Supabase access token (supabase.com/dashboard/account/tokens, starts sbp_)" pat;;
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
  # raw.githubusercontent.com sits behind a CDN that caches for several
  # minutes. Without a cache-buster a fix pushed moments ago is invisible and
  # the same failure repeats, which reads as "the fix didn't work".
  curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "$RAW/$1?cb=$(date +%s)" -o "$HOME/.sanaku-$1"
  printf '%s\n' "$HOME/.sanaku-$1"
}

# Replace this script with the current published copy, bypassing the CDN cache.
cmd_update() {
  _self="$HOME/sanaku.sh"
  curl -fsSL -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
    "$RAW/sanaku.sh?cb=$(date +%s)" -o "$_self.new"
  if ! sh -n "$_self.new" 2>/dev/null; then
    rm -f "$_self.new"
    say "Downloaded copy is not valid shell - keeping the current one."
    exit 1
  fi
  mv "$_self.new" "$_self"
  ok "updated $_self"
  rm -f "$HOME"/.sanaku-*.sh   # force engines to be re-fetched too
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

# Read back what Supabase is ACTUALLY configured to do, rather than trusting
# that an earlier command set what you meant. The sender comes from whatever
# OWNER_EMAIL happened to hold when `smtp` ran, and that is easy to get wrong
# by one command's ordering.
cmd_authcheck() {
  ensure_config SUPABASE_URL SUPABASE_PAT
  need_cmd python3
  _ref=$(printf '%s' "$SUPABASE_URL" | sed 's|^https\{0,1\}://||; s|\.supabase\.co.*$||')
  _tmp=$(mktemp -d)

  head1 "What Supabase will actually do"
  _code=$(curl -sS -o "$_tmp/cfg.json" -w '%{http_code}' -m 60 \
    "https://api.supabase.com/v1/projects/$_ref/config/auth" \
    -H "Authorization: Bearer $SUPABASE_PAT" 2>/dev/null) || _code="000"

  case "$_code" in
    2*) ;;
    *) warn "could not read the config (HTTP $_code)"; rm -rf "$_tmp"; return 0 ;;
  esac

  WANT="${OWNER_EMAIL:-}" DASH="${DASHBOARD_URL:-}" python3 - "$_tmp/cfg.json" <<'PY'
import json, os, sys
c = json.load(open(sys.argv[1]))
want, dash = os.environ.get("WANT", ""), os.environ.get("DASH", "").rstrip("/")

sender = c.get("smtp_admin_email") or ""
host   = c.get("smtp_host") or ""
site   = c.get("site_url") or ""
allow  = c.get("uri_allow_list") or ""

def line(label, value, good, hint=""):
    mark = "  ." if good else "  !"
    print("%s %-22s %s" % (mark, label, value or "(not set)"))
    if not good and hint:
        print("      %s" % hint)

line("Emails come from", sender, bool(sender) and (not want or sender == want),
     "Expected %s. Fix: sh ~/sanaku.sh set OWNER_EMAIL %s  then  sh ~/sanaku.sh smtp" % (want, want))
line("Sent via", host or "Supabase's own sender", bool(host),
     "Supabase's built-in sender is rate limited and looks like phishing. Run: sh ~/sanaku.sh smtp")
line("Sender name", c.get("smtp_sender_name") or "", bool(c.get("smtp_sender_name")))
line("Login links go to", site, bool(site) and "localhost" not in site,
     "Invite links will land on localhost. Run: sh ~/sanaku.sh authurl")
line("Redirects allowed", allow, bool(allow) and (not dash or dash in allow),
     "Run: sh ~/sanaku.sh authurl")
PY
  rm -rf "$_tmp"
  say ""
  return 0
}

# Ask Gmail directly whether the app password works.
#
# Worth its own command because a bad credential and a bad Supabase config
# produce the same symptom - an invite that fails with "Error sending invite
# email" - and telling them apart otherwise means digging through auth logs.
# curl answers in two seconds: silence means Gmail accepted it.
cmd_mailtest() {
  ensure_config OWNER_EMAIL SMTP_PASS
  _pw=$(printf '%s' "$SMTP_PASS" | tr -d ' ')
  _msg=$(mktemp)
  printf 'Subject: Sanaku SMTP test\nFrom: %s\nTo: %s\n\nIf you are reading this, Gmail accepted the app password.\n' \
    "$OWNER_EMAIL" "$OWNER_EMAIL" > "$_msg"

  head1 "Asking Gmail to accept $OWNER_EMAIL"
  if curl -sS --ssl-reqd --url 'smtps://smtp.gmail.com:465' \
       --user "$OWNER_EMAIL:$_pw" \
       --mail-from "$OWNER_EMAIL" --mail-rcpt "$OWNER_EMAIL" \
       --upload-file "$_msg" -o /dev/null 2>"$_msg.err"; then
    ok "accepted - check $OWNER_EMAIL for the test message"
    say ""
    say "Use this in Supabase > Authentication > SMTP:"
    say "  Host      smtp.gmail.com      Port  465"
    say "  Username  $OWNER_EMAIL"
    say "  Password  $_pw"
    say "  Sender    $OWNER_EMAIL       Name  Sanaku"
    say ""
    say "Sender MUST equal Username - Gmail refuses to send as anything else."
  else
    warn "Gmail rejected it"
    sed 's/^/    /' "$_msg.err" 2>/dev/null | head -3
    say ""
    say "  535 means the app password is wrong for this account:"
    say "    1. myaccount.google.com/apppasswords - check the avatar is $OWNER_EMAIL"
    say "    2. Delete every existing one, create one, copy the 16 letters"
    say "    3. sh ~/sanaku.sh set SMTP_PASS <those letters>   (spaces are stripped)"
    say "    4. sh ~/sanaku.sh mailtest"
    say ""
    say "  Also check that inbox for a Google 'Critical security alert' -"
    say "  Google blocks logins it does not recognise, and that reads as 535 too."
  fi
  rm -f "$_msg" "$_msg.err"
  return 0
}

# Send client emails from Sanaku, not from noreply@mail.app.supabase.io.
#
# Two reasons this is not cosmetic. Supabase's built-in sender is rate limited
# to a handful of messages an hour, so a run of invites silently stops going
# out. And a password link from an address the client has never heard of, for
# a service they pay hundreds a month for, reads exactly like phishing.
cmd_smtp() {
  ensure_config SUPABASE_URL SUPABASE_PAT OWNER_EMAIL
  need_cmd python3

  case "$OWNER_EMAIL" in
    *@gmail.com) ;;
    *) say "Sender will be $OWNER_EMAIL - make sure that mailbox can send via SMTP." ;;
  esac

  if [ -z "${SMTP_PASS:-}" ]; then
    head1 "Gmail app password"
    say "Gmail refuses your normal password over SMTP. You need an app password:"
    say "  1. Google Account > Security > 2-Step Verification (turn it on if it is off)"
    say "  2. Then: Google Account > Security > App passwords"
    say "  3. Name it Sanaku, create, and copy the 16 characters"
    ask SMTP_PASS "App password for $OWNER_EMAIL - 16 letters like 'abcd efgh ijkl mnop'" apppass
    save_config
  fi

  _ref=$(printf '%s' "$SUPABASE_URL" | sed 's|^https\{0,1\}://||; s|\.supabase\.co.*$||')
  _tmp=$(mktemp -d)

  printf '  sender -> %s ... ' "$OWNER_EMAIL"
  SENDER="$OWNER_EMAIL" PASS="$SMTP_PASS" python3 -c '
import json, os, sys
# Gmail app passwords are shown in groups of four; people paste the spaces.
pw = os.environ["PASS"].replace(" ", "")
sys.stdout.write(json.dumps({
    "smtp_admin_email": os.environ["SENDER"],
    "smtp_host": "smtp.gmail.com",
    # The API validates this as a string; sending 465 as a number is a 400.
    "smtp_port": "465",
    "smtp_user": os.environ["SENDER"],
    "smtp_pass": pw,
    "smtp_sender_name": "Sanaku",
    # The built-in limit is a few an hour. Gmail allows far more, and an
    # invite that never arrives is indistinguishable from a broken product.
    "rate_limit_email_sent": 100,
}))' > "$_tmp/body.json"

  _code=$(curl -sS -o "$_tmp/resp.txt" -w '%{http_code}' -m 60 -X PATCH \
    "https://api.supabase.com/v1/projects/$_ref/config/auth" \
    -H "Authorization: Bearer $SUPABASE_PAT" \
    -H "Content-Type: application/json" \
    --data-binary "@$_tmp/body.json" 2>/dev/null) || _code="000"

  case "$_code" in
    2*)
      say "set"
      say ""
      ok "Client emails now come from $OWNER_EMAIL"
      cmd_authcheck
      say "  Send yourself a test invite before you send one to a client." ;;
    *)
      say "FAILED (HTTP $_code)"
      # A 5xx from Supabase comes back as a full Cloudflare error page. Dumping
      # 150 lines of HTML at someone buries the one line that matters.
      if head -c 200 "$_tmp/resp.txt" 2>/dev/null | grep -qi '<!DOCTYPE\|<html'; then
        say "    Supabase's API is down right now (not your config, not your token)."
        say "    Wait a few minutes and run this again, or set it by hand below."
      else
        cut -c1-300 "$_tmp/resp.txt" 2>/dev/null | sed 's/^/    /'
      fi
      say ""
      say "  Set it by hand instead: Supabase > Project Settings > Authentication"
      say "  > SMTP Settings > Enable Custom SMTP"
      say "    Host      smtp.gmail.com     Port  465"
      say "    Username  $OWNER_EMAIL"
      say "    Password  your 16-character app password"
      say "    Sender    $OWNER_EMAIL       Name  Sanaku" ;;
  esac
  rm -rf "$_tmp"
  return 0
}

# Point Supabase Auth at the command center.
#
# Supabase ships with Site URL = http://localhost:3000, and it ignores the
# redirect_to we send unless that address is on its allow list. The result is
# an invite email whose link lands on localhost - the client sees "this site
# can't be reached" and there is nothing wrong with the invite at all.
cmd_authurl() {
  ensure_config SUPABASE_URL SUPABASE_PAT DASHBOARD_URL
  need_cmd python3
  _ref=$(printf '%s' "$SUPABASE_URL" | sed 's|^https\{0,1\}://||; s|\.supabase\.co.*$||')
  _url="${DASHBOARD_URL%/}"

  printf '  auth redirect -> %s ... ' "$_url"
  _tmp=$(mktemp -d)
  SITE="$_url" python3 -c 'import json,os,sys; u=os.environ["SITE"]; sys.stdout.write(json.dumps({"site_url": u, "uri_allow_list": u + "/**," + u}))' > "$_tmp/body.json"

  _code=$(curl -sS -o "$_tmp/resp.txt" -w '%{http_code}' -m 60 -X PATCH \
    "https://api.supabase.com/v1/projects/$_ref/config/auth" \
    -H "Authorization: Bearer $SUPABASE_PAT" \
    -H "Content-Type: application/json" \
    --data-binary "@$_tmp/body.json" 2>/dev/null) || _code="000"

  case "$_code" in
    2*) say "set" ;;
    *)
      say "could not set it automatically (HTTP $_code)"
      say "    Do it by hand, once: Supabase > Authentication > URL Configuration"
      say "      Site URL:      $_url"
      say "      Redirect URLs: $_url/**"
      say "    Until then, invite links land on localhost and clients cannot sign in."
      ;;
  esac
  rm -rf "$_tmp"
  return 0   # never block a deploy on this - it is fixable in the dashboard
}

# Apply SQL straight to Supabase, so nothing has to be pasted into a web editor.
#
# curl does the HTTPS, not python. A python.org install on macOS ships without
# CA certificates until you run Install Certificates.command, so urllib fails
# with CERTIFICATE_VERIFY_FAILED on a perfectly good connection. curl uses the
# system trust store and just works. python is still used to build the JSON
# body - that is string work, not network work.
cmd_migrate() {
  ensure_config SUPABASE_URL SUPABASE_PAT
  need_cmd python3
  _ref=$(printf '%s' "$SUPABASE_URL" | sed 's|^https\{0,1\}://||; s|\.supabase\.co.*$||')
  [ -n "$_ref" ] || { warn "could not read the project ref out of SUPABASE_URL"; exit 1; }

  _work="$HOME/.sanaku-migrate"
  rm -rf "$_work"; mkdir -p "$_work"
  curl -fsSL -H 'Cache-Control: no-cache' "https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)" \
    | tar xz -C "$_work" --strip-components=1

  head1 "Applying SQL to project $_ref"
  for _f in "$_work"/sanaku/supabase/RUN-THIS-NOW.sql \
            "$_work"/sanaku/supabase/ADDONS-RUN-THIS.sql \
            "$_work"/sanaku/supabase/VOICE-RUN-THIS.sql \
            "$_work"/sanaku/supabase/SERVICES-RUN-THIS.sql; do
    [ -f "$_f" ] || continue
    printf '  %s ... ' "$(basename "$_f")"

    SQL_FILE="$_f" python3 -c 'import json,os,sys; sys.stdout.write(json.dumps({"query": open(os.environ["SQL_FILE"], encoding="utf-8").read()}))' > "$_work/body.json"

    _code=$(curl -sS -o "$_work/resp.txt" -w '%{http_code}' -m 180 -X POST \
      "https://api.supabase.com/v1/projects/$_ref/database/query" \
      -H "Authorization: Bearer $SUPABASE_PAT" \
      -H "Content-Type: application/json" \
      --data-binary "@$_work/body.json" 2>"$_work/curlerr.txt") || _code="000"

    case "$_code" in
      2*)
        say "applied" ;;
      000)
        say "FAILED (could not connect)"
        sed 's/^/    /' "$_work/curlerr.txt" 2>/dev/null | head -3
        exit 1 ;;
      401|403)
        say "FAILED (token rejected)"
        say "    Make a new one at supabase.com/dashboard/account/tokens, then:"
        say "      sh ~/sanaku.sh set SUPABASE_PAT sbp_..."
        exit 1 ;;
      404)
        say "FAILED (no such endpoint)"
        say "    This script's assumption about the API is wrong, not your SQL."
        say "    Paste the file into the SQL Editor and say that migrate 404'd."
        exit 1 ;;
      *)
        say "FAILED (HTTP $_code)"
        cut -c1-400 "$_work/resp.txt" 2>/dev/null | sed 's/^/    /'
        exit 1 ;;
    esac
  done
  cmd_authurl
  say ""
  ok "database is up to date"
}

# Run SQL read from stdin against Supabase. Same transport cmd_migrate uses -
# split out so the demo commands do not each reimplement it. Leaves the
# response body at $SQL_RESP and returns non-zero on anything but a 2xx.
supabase_sql() {
  ensure_config SUPABASE_URL SUPABASE_PAT
  need_cmd python3
  _ref=$(printf '%s' "$SUPABASE_URL" | sed 's|^https\{0,1\}://||; s|\.supabase\.co.*$||')
  [ -n "$_ref" ] || { warn "could not read the project ref out of SUPABASE_URL"; return 1; }

  _sq="$HOME/.sanaku-sql"; rm -rf "$_sq"; mkdir -p "$_sq"
  cat > "$_sq/q.sql"
  SQL_FILE="$_sq/q.sql" python3 -c 'import json,os,sys; sys.stdout.write(json.dumps({"query": open(os.environ["SQL_FILE"], encoding="utf-8").read()}))' > "$_sq/body.json"

  SQL_RESP="$_sq/resp.txt"
  _code=$(curl -sS -o "$SQL_RESP" -w '%{http_code}' -m 120 -X POST \
    "https://api.supabase.com/v1/projects/$_ref/database/query" \
    -H "Authorization: Bearer $SUPABASE_PAT" \
    -H "Content-Type: application/json" \
    --data-binary "@$_sq/body.json" 2>/dev/null) || _code="000"

  case "$_code" in
    2*) return 0 ;;
    000) warn "could not reach Supabase"; return 1 ;;
    401|403)
      warn "the Supabase token was rejected"
      say "    New one at supabase.com/dashboard/account/tokens, then:"
      say "      sh ~/sanaku.sh set SUPABASE_PAT sbp_..."
      return 1 ;;
    *)
      warn "Supabase answered HTTP $_code"
      cut -c1-400 "$SQL_RESP" 2>/dev/null | sed 's/^/    /'
      return 1 ;;
  esac
}

DEMO_COMPANY="Delgado Plumbing & Rooter"

# A throwaway client to film, and to demo on a sales call.
#
# It exists so a demo never touches a paying client's data and never needs a
# second login. is_demo keeps it out of Active clients, Monthly retainers and
# every statement, so a prop company can carry a $750 retainer and still not
# turn up in what you are owed.
cmd_demo() {
  case "${1:-status}" in
    seed)
      _num="${2:-}"
      if [ -z "$_num" ]; then
        say "Usage: sh ~/sanaku.sh demo seed +17145551234"
        say ""
        say "That number is the one your VAPI assistant answers on. The workflow"
        say "finds the client by it, so it has to match exactly, in E.164."
        return 1
      fi
      case "$_num" in
        +[0-9]*) ;;
        *) warn "the number must be E.164, starting with + and a country code"; return 1 ;;
      esac

      head1 "Creating the demo client"
      _q=$(printf '%s' "$_num" | sed "s/'/''/g")
      supabase_sql <<SQL || return 1
update sanaku_clients set
  inbound_number = '$_q', status = 'active', workflow_enabled = true, is_demo = true,
  brand_name = '$DEMO_COMPANY', brand_primary_color = '#1d4ed8',
  timezone = 'America/Los_Angeles',
  business_hours = '{"mon":["07:00","17:00"],"tue":["07:00","17:00"],"wed":["07:00","17:00"],"thu":["07:00","17:00"],"fri":["07:00","17:00"],"sat":null,"sun":null}'::jsonb,
  notes = 'Demo client. Fictional. Used for sales calls and the demo video.'
where is_demo and company_name = '$DEMO_COMPANY';

insert into sanaku_clients (
  company_name, vertical, status, is_demo, onboarded_at, brand_name,
  brand_primary_color, inbound_number, timezone, business_hours,
  pricing_model, monthly_retainer, per_lead_fee, qualified_definition, notes)
select '$DEMO_COMPANY', 'home_services', 'active', true, current_date - 47,
  '$DEMO_COMPANY', '#1d4ed8', '$_q', 'America/Los_Angeles',
  '{"mon":["07:00","17:00"],"tue":["07:00","17:00"],"wed":["07:00","17:00"],"thu":["07:00","17:00"],"fri":["07:00","17:00"],"sat":null,"sun":null}'::jsonb,
  'retainer_plus_per_lead', 750, 50,
  'A homeowner who described a job we can do and left a number we can reach them on.',
  'Demo client. Fictional. Used for sales calls and the demo video.'
where not exists (select 1 from sanaku_clients
                  where is_demo and company_name = '$DEMO_COMPANY');

select id::text from sanaku_clients where is_demo and company_name = '$DEMO_COMPANY';
SQL
      ok "$DEMO_COMPANY answers on $_num"
      say ""
      say "Business hours are 7am-5pm Mon-Fri, so any call you make in the evening"
      say "lands as 'after hours' - which is the number the whole pitch turns on."
      say ""
      say "To film it: Command center > Clients > the Portal button on that row."
      say "That opens their portal full-screen with no operator chrome in the shot,"
      say "so you do not need a second login."
      say ""
      say "Between takes:  sh ~/sanaku.sh demo reset"
      ;;

    reset)
      head1 "Clearing the demo client's leads"
      supabase_sql <<SQL || return 1
delete from sanaku_client_leads
where client_id in (select id from sanaku_clients
                    where is_demo and company_name = '$DEMO_COMPANY');
SQL
      ok "leads cleared - the portal is empty again, ready for another take"
      ;;

    nuke)
      head1 "Removing the demo client entirely"
      supabase_sql <<SQL || return 1
delete from sanaku_clients where is_demo and company_name = '$DEMO_COMPANY';
SQL
      ok "gone (its leads went with it - they were props)"
      ;;

    status|'')
      head1 "Demo client"
      supabase_sql <<SQL || return 1
select c.company_name, c.inbound_number, count(l.id) as leads
from sanaku_clients c
left join sanaku_client_leads l on l.client_id = c.id
where c.is_demo
group by c.company_name, c.inbound_number;
SQL
      cut -c1-600 "$SQL_RESP" | sed 's/^/  /'
      say ""
      say "  seed:  sh ~/sanaku.sh demo seed +1714...   (the VAPI number)"
      say "  reset: sh ~/sanaku.sh demo reset           (between takes)"
      say "  nuke:  sh ~/sanaku.sh demo nuke            (when you are done)"
      ;;

    *)
      say "Usage: sh ~/sanaku.sh demo [status|seed <number>|reset|nuke]"
      return 1 ;;
  esac
}

# Install the voice workflow and print what VAPI needs pointed at it.
cmd_sellsheet() {
  # Print the services sheet from the LIVE catalog.
  #
  # The prices live in sanaku_addons. A sheet typed by hand drifts from that
  # table the first time a price changes, and the drifted copy is the one that
  # gets handed to a prospect - so this reads the catalog every time.
  need_cmd node
  need_cmd python3
  ensure_config SUPABASE_URL SUPABASE_SERVICE_KEY

  _work="$HOME/.sanaku-sellsheet"
  _out="$HOME/sanaku-sellsheet"
  rm -rf "$_work"; mkdir -p "$_work" "$_out"

  head1 "Reading the catalog"
  sb "sanaku_addons?select=*&order=sort" > "$_work/addons.json" || {
    err "could not read sanaku_addons"; return 1; }
  sb "sanaku_addon_bundle_members?select=bundle_code,member_code" > "$_work/members.json" || {
    err "could not read sanaku_addon_bundle_members"
    say "    Run the migrations first:  sh ~/sanaku.sh migrate"; return 1; }

  ADDONS="$_work/addons.json" MEMBERS="$_work/members.json" OUT="$_work/catalog.json" \
  python3 -c 'import json,os
a=json.load(open(os.environ["ADDONS"]));m=json.load(open(os.environ["MEMBERS"]))
json.dump({"generated_from":"live Supabase catalog","services":a,"bundle_members":m},
          open(os.environ["OUT"],"w"))
print(f"  {len(a)} services, {len(m)} package links")' || return 1

  curl -fsSL -H 'Cache-Control: no-cache' "https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)" \
    | tar xz -C "$_work" --strip-components=1 || { err "could not fetch the generator"; return 1; }

  head1 "Generating"
  # The generator refuses to print a sheet whose bundle arithmetic does not
  # hold, so a failure here means the catalog disagrees with itself.
  node "$_work/sanaku/scripts/sellsheet.mjs" "$_work/catalog.json" "$_out" || {
    err "the catalog does not add up - nothing was written"
    say "    Fix the prices above, then run this again."; return 1; }
  python3 "$_work/sanaku/scripts/sellsheet_xlsx.py" "$_work/catalog.json" \
    "$_out/sanaku-services.xlsx" || return 1
  node "$_work/sanaku/scripts/emailpages.mjs" "$_work/catalog.json" "$_out/email" || return 1

  head1 "Done"
  say "  $_out/sell-sheet.html      open in a browser, then print to PDF"
  say "  $_out/sanaku-services.xlsx every figure a formula off the first tab"
  say "  $_out/email/               one sell page per vertical, ready to email"
  say ""
  say "To send one: open the .html, select all, copy, paste into your email."
  say "A .txt twin sits beside each for anyone who reads mail as plain text."
  say ""
  say "Only services that can actually be delivered are offered for sale on"
  say "those pages. Anything still in build is listed as coming, not sold."
  say ""
  say "Prices come from the catalog. Change one in Supabase and run this again."
}

cmd_voice() {
  cmd_import t2-voice-agent || return 1

  ensure_config N8N_URL
  head1 "Now wire VAPI to it"
  say "1. Import the client's number:  dashboard.vapi.ai > Phone Numbers"
  say "   It must equal inbound_number on their row, or T2 cannot tell whose"
  say "   call it was."
  say ""
  say "2. Create the assistant from sanaku/vapi/assistant-home-services.json"
  say ""
  say "3. On that assistant, set:"
  say "     Server URL       $N8N_URL/webhook/t2-voice-report"
  say "     Server messages  end-of-call-report   (only that one)"
  say "     Recording        on"
  say "     Summary          on"
  say "     Structured data  on, with the schema from that same file"
  say ""
  say "4. Assign the number to the assistant, then call it."
  say ""
  case "$N8N_URL" in
    http://*)
      warn "that URL is plain HTTP, so call transcripts cross the internet in the clear"
      say "    VAPI will still reach it. Fix when you can:  sh ~/sanaku.sh secure"
      say "" ;;
  esac
  say "The owner-alert text needs a Twilio credential picked by hand in n8n"
  say "(Alert The Owner). Without it the lead still lands in the portal - the"
  say "node is set to carry on rather than fail the run."
}

# Everything, in the right order, in one command.
cmd_ship() {
  head1 "1/4  Database"
  cmd_migrate
  head1 "2/4  Client invite workflow"
  cmd_import invite-client-user || warn "workflow import failed - Invite will fall back to manual steps"
  head1 "3/4  Command center"
  cmd_dashboard
  head1 "4/4  Public site"
  cmd_site
  say ""
  ok "Everything is live."
}

cmd_audit() {
  need_cmd node
  _work="$HOME/.sanaku-audit"
  rm -rf "$_work"; mkdir -p "$_work"
  curl -fsSL -H 'Cache-Control: no-cache' "https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)" \
    | tar xz -C "$_work" --strip-components=1
  ( cd "$_work" && node sanaku/scripts/audit.mjs )
}

cmd_import() { # cmd_import WORKFLOW-NAME
  _wf="${1:-}"
  if [ -z "$_wf" ]; then
    say "Usage: sh ~/sanaku.sh import <workflow-name>"
    say "e.g.   sh ~/sanaku.sh import invite-client-user"
    exit 1
  fi
  case "$_wf" in *.json) ;; *) _wf="$_wf.json" ;; esac
  ensure_config N8N_URL N8N_KEY SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY
  need_cmd python3
  _engine=$(fetch_engine import-workflow.sh)
  N8N_URL="$N8N_URL" N8N_KEY="$N8N_KEY" \
  SUPABASE_URL="$SUPABASE_URL" SUPABASE_SERVICE_KEY="$SUPABASE_SERVICE_KEY" \
  OWNER_EMAIL="${OWNER_EMAIL:-}" SERPAPI_KEY="${SERPAPI_KEY:-}" \
  SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  DASHBOARD_URL="${DASHBOARD_URL:-https://sanaku-command-center.netlify.app}" \
  WF_FILE="$_wf" \
    sh "$_engine"
}

cmd_secure() {
  ensure_config N8N_URL
  case "$N8N_URL" in
    https://*) ok "n8n is already on HTTPS - nothing to do."; return 0 ;;
  esac
  _ip=$(printf '%s' "$N8N_URL" | sed 's|^https\{0,1\}://||; s|:.*$||; s|/.*$||')
  head1 "Put n8n behind HTTPS"
  say "Your dashboard is HTTPS; n8n is plain HTTP. Browsers block an HTTPS page"
  say "from calling an HTTP endpoint, so the Invite button cannot work until"
  say "this is done. It is free and takes about five minutes."
  say ""
  say "Run these THREE lines. The first opens a session on the droplet;"
  say "the next two run there, not on your Mac:"
  say ""
  say "  ssh root@$_ip"
  say "  curl -fsSL $RAW/secure-n8n.sh -o secure-n8n.sh"
  say "  sh secure-n8n.sh"
  say ""
  say "When it finishes it prints your new https:// address. Then, back here:"
  say ""
  say "  sh ~/sanaku.sh set N8N_URL https://$_ip.nip.io"
  say "  sh ~/sanaku.sh dashboard"
  say ""
}

cmd_pdf() {
  need_cmd node
  say "Building the leak-audit PDF..."
  _which="${1:-home}"
  _work="$HOME/.sanaku-site-build"
  rm -rf "$_work"; mkdir -p "$_work"
  curl -fsSL -H 'Cache-Control: no-cache' "https://github.com/ismailwright-rgb/ismailwright-rgb/archive/refs/heads/${BRANCH}.tar.gz?cb=$(date +%s)" \
    | tar xz -C "$_work" --strip-components=1
  ( cd "$_work/sanaku" && node scripts/make-pdf.mjs "$_which" "$HOME/Sanaku_Leak_Audit_$_which.pdf" )
  ok "saved to $HOME/Sanaku_Leak_Audit_$_which.pdf"
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
    SUPABASE_PAT) _kind=pat ;;
    SMTP_PASS)    _kind=apppass ;;
    *URL)        _kind=url ;;
    *EMAIL)      _kind=email ;;
    SERPAPI_KEY) _kind=key ;;
    *KEY)        _kind=jwt ;;
    *)           _kind=key ;;
  esac
  _err=$(validate "$_kind" "$_value")
  if [ -n "$_err" ]; then warn "rejected: $_err"; exit 1; fi

  eval "$_target=\$_value"
  # NOT ensure_config here. Setting one value must never interrogate you about
  # every other one - adding a new key to KEYS would then turn `set ANYTHING`
  # into a questionnaire. load_config has already read whatever was stored;
  # anything still unset is simply written back empty.
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
    SUPABASE_PAT) _kind=pat ;;
    SMTP_PASS)    _kind=apppass ;;
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
  # see cmd_set: one value in, one value out
     # fills anything else still missing
  save_config
  ok "$_target set from clipboard: $(preview "$_clip")"
  say "Check it with:  sh ~/sanaku.sh doctor"
}

usage() {
  cat <<'EOF'
sanaku - control script

  sh ~/sanaku.sh update      pull the latest version of this script
  sh ~/sanaku.sh ship        do EVERYTHING: database, workflow, both sites
  sh ~/sanaku.sh migrate     apply pending SQL to Supabase (no copy-paste)
  sh ~/sanaku.sh authurl     point Supabase login links at the command center
  sh ~/sanaku.sh smtp        send client emails from your address, not Supabase's
  sh ~/sanaku.sh mailtest    ask Gmail directly whether your app password works
  sh ~/sanaku.sh authcheck   show what Supabase will ACTUALLY send, and from where
  sh ~/sanaku.sh next        what should I do right now? (start here)
  sh ~/sanaku.sh status      health check + prospect counts
  sh ~/sanaku.sh doctor      diagnose connection/key problems step by step
  sh ~/sanaku.sh audit       check the project for gaps before you go live
  sh ~/sanaku.sh logs        show what the last scraper run did, node by node
  sh ~/sanaku.sh scrape      run the prospect scraper now
  sh ~/sanaku.sh import NAME  install a workflow into n8n (see list below)
  sh ~/sanaku.sh voice       install the AI phone agent + how to wire VAPI
  sh ~/sanaku.sh demo        a throwaway client to film and to demo on calls
  sh ~/sanaku.sh sellsheet   print services + pricing from the live catalog
  sh ~/sanaku.sh dashboard   deploy the internal command center
  sh ~/sanaku.sh site        deploy the public landing page
  sh ~/sanaku.sh secure      how to put n8n behind HTTPS (needed for Invite)
  sh ~/sanaku.sh pdf [which] make an emailable leak-audit PDF (home|dental|law)
  sh ~/sanaku.sh config      re-enter stored keys (add names to redo just those)
  sh ~/sanaku.sh paste KEY   read one value straight from the system clipboard
  sh ~/sanaku.sh set KEY VAL set one value directly (paste the value on the line)

Workflow names for 'import' (the .json suffix is optional):
  invite-client-user     let a client sign in to their portal
  t1-missed-call-textback  the missed-call product
  t1-reply-handler       replies to those texts
  t2-voice-agent         the AI phone agent (use 'voice' instead - it also
                         prints the VAPI setup)
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
  update)    cmd_update ;;
  doctor)    cmd_doctor ;;
  audit)     cmd_audit ;;
  migrate)   cmd_migrate ;;
  authurl)   cmd_authurl ;;
  smtp)      cmd_smtp ;;
  mailtest)  cmd_mailtest ;;
  authcheck) cmd_authcheck ;;
  ship)      cmd_ship ;;
  logs)      cmd_logs ;;
  next)      cmd_next ;;
  scrape)    cmd_scrape ;;
  import)    shift; cmd_import "$@" ;;
  voice)     cmd_voice ;;
  sellsheet) cmd_sellsheet ;;
  demo)      shift; cmd_demo "$@" ;;
  dashboard) cmd_dashboard ;;
  site)      cmd_site ;;
  secure)    cmd_secure ;;
  pdf)       shift; cmd_pdf "$@" ;;
  config)    shift; cmd_config "$@" ;;
  paste)     shift; cmd_paste "$@" ;;
  set)       shift; cmd_set "$@" ;;
  *)
    # An unknown command almost always means this copy predates it. Saying so
    # is the difference between a one-line fix and staring at a usage dump.
    if [ -n "${1:-}" ]; then
      say "Unknown command: $1"
      say ""
      say "Your copy of this script is probably out of date. Refresh it:"
      say "  curl -fsSL -H 'Cache-Control: no-cache' \\"
      say "    \"$RAW/sanaku.sh?cb=\$(date +%s)\" -o ~/sanaku.sh"
      say ""
    fi
    usage ;;
esac
