#!/bin/sh
# Install the HTTPS sender for W2s.
#
# WHY THIS EXISTS
# ---------------
# W2s sent nothing for its entire life. It used an SMTP node on
# smtppro.zoho.com:587 and every attempt died with a TCP connection timeout at
# exactly 120 seconds. The droplet cannot open an outbound SMTP connection -
# reaching Zoho IMAP on 993 from the same host works, so it is a port-level
# block, not a Zoho or credential problem. DigitalOcean blocks outbound SMTP on
# droplets by default.
#
# Port 443 works (Supabase and OpenRouter are reached over it all day), so the
# mail now goes through the Zoho Mail REST API. Two bonuses: the API writes a
# copy into the Sent folder, which SMTP submission never does, and it returns a
# message id, so a failure is a failure instead of an empty item.
#
# WHAT YOU HAVE TO DO FIRST (about two minutes, and only you can do it - it is
# authorising your own mailbox)
# ---------------------------------------------------------------------------
#   1. Open https://api-console.zoho.com/
#   2. ADD CLIENT -> Self Client -> CREATE
#   3. Copy the Client ID and Client Secret
#   4. Open the "Generate Code" tab and enter:
#        Scope:    ZohoMail.messages.CREATE,ZohoMail.accounts.READ
#        Duration: 10 minutes
#        Description: sanaku sender
#   5. CREATE, pick your sanakuai.com account, and copy the code.
#      The code dies in 10 minutes - run this straight away.
#
#   sh scripts/install-zoho-api-sender.sh <CLIENT_ID> <CLIENT_SECRET> <CODE>
#
# The refresh token this produces does not expire. It is stored only in an n8n
# credential, which is encrypted at rest - never in the workflow JSON, which is
# committed to git.
#
# Safe to run more than once. Re-running replaces the credential.
set -eu

CLIENT_ID="${1:-}"
CLIENT_SECRET="${2:-}"
CODE="${3:-}"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ] || [ -z "$CODE" ]; then
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
fi

# Zoho is region-partitioned; a US account cannot mint tokens on the EU host.
DC="${ZOHO_DC:-com}"
ACCOUNTS="https://accounts.zoho.${DC}"
MAILAPI="https://mail.zoho.${DC}"

ENVFILE="$HOME/.sanaku.env"
[ -f "$ENVFILE" ] || { echo "missing $ENVFILE"; exit 1; }
# shellcheck disable=SC1090
. "$ENVFILE"

: "${N8N_URL:?N8N_URL not set}"
: "${N8N_KEY:?N8N_KEY not set}"
WF_ID="ekKqw2xahKQox5Kx"
SUPA_CRED="bewGewKvzpMCFasR"   # Supabase Service Role (Custom Auth) - M1
TO="${ZOHO_FROM:-ismail@sanakuai.com}"

say() { printf '  %s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Trade the one-time code for a refresh token
# ---------------------------------------------------------------------------
say "exchanging the authorisation code..."
TOKEN_JSON=$(curl -sS -X POST "$ACCOUNTS/oauth/v2/token" \
  --data-urlencode "grant_type=authorization_code" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "code=$CODE")

REFRESH=$(printf '%s' "$TOKEN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("refresh_token",""))')
ACCESS=$(printf '%s' "$TOKEN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')

if [ -z "$REFRESH" ]; then
  say "FAILED. Zoho said:"
  printf '  %s\n' "$TOKEN_JSON"
  say ""
  say "Most common causes, in order:"
  say "  - the code expired (they last 10 minutes) - generate a new one"
  say "  - the code was already used once; each is single-use"
  say "  - wrong data centre; re-run with ZOHO_DC=eu (or in/au/jp) if your"
  say "    Zoho account is not on .com"
  exit 1
fi
say "got a refresh token (does not expire)"

# ---------------------------------------------------------------------------
# 2. Prove it works before wiring anything to it
# ---------------------------------------------------------------------------
say "looking up the mail account..."
ACCT_JSON=$(curl -sS "$MAILAPI/api/accounts" -H "Authorization: Zoho-oauthtoken $ACCESS")
ACCT_ID=$(printf '%s' "$ACCT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data") or [{}]; print(d[0].get("accountId",""))')
ACCT_ADDR=$(printf '%s' "$ACCT_JSON" | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data") or [{}]; print(d[0].get("primaryEmailAddress",""))')

[ -n "$ACCT_ID" ] || { say "could not read the account id. Zoho said:"; printf '  %s\n' "$ACCT_JSON" | head -c 500; exit 1; }
say "account $ACCT_ADDR (id $ACCT_ID)"

if [ "$ACCT_ADDR" != "$TO" ]; then
  say "WARNING: authorised mailbox ($ACCT_ADDR) is not ZOHO_FROM ($TO)."
  say "Zoho refuses to send with a fromAddress the token does not own."
fi

# ---------------------------------------------------------------------------
# 3. Send one real email - to yourself, never to a prospect
# ---------------------------------------------------------------------------
say "sending a test message to $TO ..."
SEND_JSON=$(curl -sS -X POST "$MAILAPI/api/accounts/$ACCT_ID/messages" \
  -H "Authorization: Zoho-oauthtoken $ACCESS" \
  -H "Content-Type: application/json" \
  -d "$(python3 -c '
import json,sys
to=sys.argv[1]
print(json.dumps({
  "fromAddress": to, "toAddress": to,
  "subject": "Sanaku sender test - HTTPS path",
  "content": ("This is the W2s sender proving it can deliver.\n\n"
              "It went out over the Zoho Mail REST API on 443, because outbound\n"
              "SMTP on 587 is blocked on the droplet and timed out on every\n"
              "attempt.\n\n"
              "If you are reading this, the path works - and because the API was\n"
              "used rather than SMTP, there is also a copy in your Sent folder."),
  "mailFormat": "plaintext", "askReceipt": "no",
}))' "$TO")")

SEND_CODE=$(printf '%s' "$SEND_JSON" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("status") or {}).get("code",""))')
MSG_ID=$(printf '%s' "$SEND_JSON" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("data") or {}).get("messageId",""))')

if [ "$SEND_CODE" != "200" ] || [ -z "$MSG_ID" ]; then
  say "SEND FAILED. Zoho said:"
  printf '  %s\n' "$SEND_JSON" | head -c 600
  say ""
  say "Nothing has been wired up. Fix this before continuing -"
  say "a scope of only ZohoMail.accounts.READ is the usual cause."
  exit 1
fi
say "DELIVERED - messageId $MSG_ID. Check your inbox AND your Sent folder."

# ---------------------------------------------------------------------------
# 4. Store the secrets in an n8n credential
# ---------------------------------------------------------------------------
CRED_NAME="Zoho Mail OAuth (sanakuai.com)"
say "creating the n8n credential..."

CRED_ID=$(python3 - "$N8N_URL" "$N8N_KEY" "$CRED_NAME" "$CLIENT_ID" "$CLIENT_SECRET" "$REFRESH" "$ACCOUNTS" <<'PY'
import json, subprocess, sys
url, key, name, cid, secret, refresh, accounts = sys.argv[1:8]

# HTTP Custom Auth takes one JSON string and merges it into every request the
# node makes. Putting the credentials in qs keeps them out of the workflow and
# out of any execution log that records the body.
payload = {"qs": {
    "grant_type": "refresh_token",
    "client_id": cid,
    "client_secret": secret,
    "refresh_token": refresh,
}}
body = {"name": name, "type": "httpCustomAuth", "data": {"json": json.dumps(payload)}}

out = subprocess.run(
    ["curl", "-sSk", "-X", "POST", f"{url}/api/v1/credentials",
     "-H", f"X-N8N-API-KEY: {key}", "-H", "Content-Type: application/json",
     "-d", json.dumps(body)],
    capture_output=True, text=True).stdout
try:
    print(json.loads(out).get("id", ""))
except Exception:
    print("", file=sys.stdout)
    print(out[:300], file=sys.stderr)
PY
)

[ -n "$CRED_ID" ] || { say "could not create the credential in n8n"; exit 1; }
say "credential id $CRED_ID"

# ---------------------------------------------------------------------------
# 5. Install the workflow, with placeholders resolved
# ---------------------------------------------------------------------------
say "installing W2s..."
python3 - "$N8N_URL" "$N8N_KEY" "$WF_ID" "$CRED_ID" "$CRED_NAME" "$SUPA_CRED" <<'PY'
import json, os, subprocess, sys
url, key, wf_id, zoho_id, zoho_name, supa_id = sys.argv[1:7]

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__))) \
    if "__file__" in dir() else "."
path = os.path.join(os.getcwd(), "n8n/workflows/w2s-send-approved.json")
wf = json.load(open(path))

for n in wf["nodes"]:
    for ctype, c in (n.get("credentials") or {}).items():
        if c.get("id") == "PLACEHOLDER_ZOHO_OAUTH":
            c["id"], c["name"] = zoho_id, zoho_name
        elif c.get("id") == "supabase-custom-auth":
            c["id"], c["name"] = supa_id, "Supabase Service Role (Custom Auth) - M1"

left = [c.get("id") for n in wf["nodes"] for c in (n.get("credentials") or {}).values()
        if str(c.get("id", "")).startswith(("PLACEHOLDER", "REPLACE"))]
if left:
    print("  refusing to install - unresolved placeholders:", left)
    sys.exit(1)

# n8n rejects unknown keys on update.
body = {"name": wf["name"], "nodes": wf["nodes"], "connections": wf["connections"],
        "settings": {"executionOrder": "v1", "timezone": "America/Los_Angeles"}}

out = subprocess.run(
    ["curl", "-sSk", "-X", "PUT", f"{url}/api/v1/workflows/{wf_id}",
     "-H", f"X-N8N-API-KEY: {key}", "-H", "Content-Type: application/json",
     "-d", json.dumps(body)],
    capture_output=True, text=True).stdout
try:
    d = json.loads(out)
    print(f"  installed '{d.get('name')}' - {len(d.get('nodes', []))} nodes, active={d.get('active')}")
except Exception:
    print("  install failed:", out[:400]); sys.exit(1)
PY

say ""
say "Done. W2s is installed but still PAUSED."
say "Turn it on when you are ready:"
say "  curl -sk -X POST \"\$N8N_URL/api/v1/workflows/$WF_ID/activate\" -H \"X-N8N-API-KEY: \$N8N_KEY\""
