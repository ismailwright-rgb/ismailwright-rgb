#!/bin/sh
# ============================================================================
# Import any Sanaku workflow into n8n, patched for THIS instance.
#
# Importing the raw .json through the n8n UI does not work. The files are
# written against environment variables (SUPABASE_URL, DASHBOARD_URL, ...)
# that a stock n8n instance does not define, and they reference credentials
# by name that do not exist there yet. A UI import produces a workflow that
# looks fine, saves fine, and then fails at run time with an unhelpful error.
#
# This script does what the UI cannot: substitutes the real values, creates
# the credential, wires it to the nodes that need it, replaces any previous
# copy of the same workflow, and activates it.
#
# Usage:
#   N8N_URL=... N8N_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
#   WF_FILE=invite-client-user.json \
#   [DASHBOARD_URL=https://sanaku-command-center.netlify.app] \
#   [OWNER_EMAIL=...] [ACTIVATE=0] \
#     bash import-workflow.sh
#
# Called by:  sh ~/sanaku.sh import <name>
# ============================================================================
# POSIX sh, not bash: sanaku.sh invokes this with `sh`, which is dash on most
# Linux images. `set -o pipefail` and `local` are bash-only and abort there.
set -eu

: "${N8N_URL:?Set N8N_URL}"
: "${N8N_KEY:?Set N8N_KEY}"
: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_SERVICE_KEY:?Set SUPABASE_SERVICE_KEY}"
: "${WF_FILE:?Set WF_FILE (e.g. invite-client-user.json)}"
DASHBOARD_URL="${DASHBOARD_URL:-https://sanaku-command-center.netlify.app}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
SERPAPI_KEY="${SERPAPI_KEY:-}"
APOLLO_KEY="${APOLLO_KEY:-}"   # optional: Apollo's free plan has no API access
SUPABASE_ANON_KEY="${SUPABASE_ANON_KEY:-}"
ACTIVATE="${ACTIVATE:-1}"

N8N_URL="${N8N_URL%/}"
BRANCH="claude/n8n-prospect-tiering-hgkjb0"
RAW="https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/${BRANCH}/sanaku/n8n/workflows"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

api() { # method path [json-body]
  _method="$1"; _path="$2"; _body="${3:-}"
  if [ -n "$_body" ]; then
    curl -fsS -X "$_method" "$N8N_URL/api/v1$_path" \
      -H "X-N8N-API-KEY: $N8N_KEY" -H "Content-Type: application/json" \
      --data-binary "$_body"
  else
    curl -fsS -X "$_method" "$N8N_URL/api/v1$_path" -H "X-N8N-API-KEY: $N8N_KEY"
  fi
}
jsonget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

# Printed so a stale cached copy is visible immediately, rather than being
# diagnosed from an identical-looking traceback.
BUILD="8"
echo "import-workflow.sh build $BUILD"

echo "==> Checking n8n API access..."
api GET "/workflows?limit=1" > /dev/null
echo "    ok"

echo "==> Fetching $WF_FILE..."
curl -fsSL "$RAW/$WF_FILE" -o "$TMP/wf.json"
python3 -c "import json,sys; json.load(open('$TMP/wf.json'))" \
  || { echo "    that file is not valid JSON - check the name"; exit 1; }
echo "    ok"

echo "==> Creating the Supabase credential in n8n..."
# n8n's public API cannot LIST credentials, only create them, so a re-import
# leaves an extra copy behind. Harmless - the workflow points at the newest.
SUPA_CRED_ID=$(api POST "/credentials" "$(python3 -c '
import json, os
key = os.environ["SUPABASE_SERVICE_KEY"]
print(json.dumps({
  "name": "Supabase Service Role (Custom Auth)",
  "type": "httpCustomAuth",
  "data": {"json": json.dumps({"headers": {"apikey": key, "Authorization": "Bearer " + key}})},
}))')" | jsonget 'd["id"]')
echo "    credential: $SUPA_CRED_ID"

# Apollo is opt-in. Without a key the workflow's Apollo nodes must lose their
# credential reference entirely: pointing at an id that does not exist in this
# instance fails at run time with "credential not found", which reads like an
# n8n problem rather than a missing key.
APOLLO_CRED_ID=""
if [ -n "$APOLLO_KEY" ]; then
  echo "==> Creating the Apollo credential in n8n..."
  APOLLO_CRED_ID=$(api POST "/credentials" "$(python3 -c '
import json, os
print(json.dumps({
  "name": "Apollo API Key (Header Auth)",
  "type": "httpHeaderAuth",
  "data": {"name": "x-api-key", "value": os.environ["APOLLO_KEY"]},
}))')" | jsonget 'd["id"]')
  echo "    credential: $APOLLO_CRED_ID"
fi

echo "==> Patching for this instance..."
export SUPA_CRED_ID APOLLO_CRED_ID DASHBOARD_URL OWNER_EMAIL SERPAPI_KEY SUPABASE_ANON_KEY TMPDIR_WF="$TMP"
python3 <<'PY'
import json, os, re, sys

tmp = os.environ["TMPDIR_WF"]
wf = json.load(open(f"{tmp}/wf.json"))
supa_id = os.environ["SUPA_CRED_ID"]
apollo_id = os.environ.get("APOLLO_CRED_ID", "")

# Known values, by the env var name the workflows use.
VALUES = {
    "SUPABASE_URL":       os.environ["SUPABASE_URL"].rstrip("/"),
    "DASHBOARD_URL":      os.environ["DASHBOARD_URL"].rstrip("/"),
    "SANAKU_OWNER_EMAIL": os.environ.get("OWNER_EMAIL", ""),
    "SERPAPI_KEY":        os.environ.get("SERPAPI_KEY", ""),
    "SUPABASE_ANON_KEY":  os.environ.get("SUPABASE_ANON_KEY", ""),
}
VALUES = {k: v for k, v in VALUES.items() if v}

# Without these the workflow fails in a way that looks like something else:
# a bad SUPABASE_URL reads as an auth error, and a bad DASHBOARD_URL sends
# the client an invite link that 404s.
# Without the anon key, /auth/v1/user rejects the call and every invite
# reports "not authorized" no matter who is signed in.
REQUIRED = {"SUPABASE_URL", "DASHBOARD_URL", "SUPABASE_ANON_KEY"}

def patch(obj):
    if isinstance(obj, dict):
        return {k: patch(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [patch(v) for v in obj]
    if isinstance(obj, str):
        for name, val in VALUES.items():
            # Two shapes appear in these files and they are NOT interchangeable:
            #   "{{ $env.X }}"  - inside an n8n expression: interpolated, so the
            #                     raw value goes in unquoted
            #   "$env.X"        - inside a Code node's JavaScript: it is an
            #                     expression, so it needs a quoted JS literal
            #                     or the code is a syntax error
            obj = obj.replace("{{ $env.%s }}" % name, val)
            obj = re.sub(r"\$env\.%s\b" % name, json.dumps(val).replace("\\", "\\\\"), obj)
        return obj
    return obj

wf = patch(wf)

for node in wf["nodes"]:
    creds = node.get("credentials", {})
    # Supabase needs TWO headers (apikey + Authorization). Header Auth carries
    # only one, and apikey alone authenticates as anonymous - reads come back
    # blank and writes are rejected by RLS. Custom Auth is the only shape that
    # works, so any node pointed at a Supabase Header Auth cred is switched.
    if "httpHeaderAuth" in creds and "Supabase" in creds["httpHeaderAuth"].get("name", ""):
        node.setdefault("parameters", {})["genericAuthType"] = "httpCustomAuth"
        del creds["httpHeaderAuth"]
        creds["httpCustomAuth"] = {"id": supa_id, "name": "Supabase Service Role (Custom Auth)"}
    elif "httpCustomAuth" in creds:
        creds["httpCustomAuth"] = {"id": supa_id, "name": "Supabase Service Role (Custom Auth)"}
    if "httpHeaderAuth" in creds and "Apollo" in creds["httpHeaderAuth"].get("name", ""):
        if apollo_id:
            creds["httpHeaderAuth"] = {"id": apollo_id, "name": "Apollo API Key (Header Auth)"}
        else:
            del creds["httpHeaderAuth"]
            node["parameters"].pop("authentication", None)
            node["parameters"].pop("genericAuthType", None)

# W1 only. The flag is a CONSEQUENCE of having a key, never a hand-edit: true
# with no credential fails every Apollo node mid-run, after the SerpAPI branch
# it replaced has already been skipped.
for node in wf["nodes"]:
    if node["name"] == "Run Config" and "useApollo" in node.get("parameters", {}).get("jsCode", ""):
        code, n = re.subn(r"useApollo:\s*(?:true|false)",
                          "useApollo: " + ("true" if apollo_id else "false"),
                          node["parameters"]["jsCode"])
        if n != 1:
            print(f"    !! Run Config has {n} useApollo flags, expected 1 - aborting", file=sys.stderr)
            sys.exit(1)
        node["parameters"]["jsCode"] = code
        print("    apollo people-search: " + ("on" if apollo_id else "off (no APOLLO_KEY)"))

# Anything still referencing $env would resolve to undefined at run time.
# Fail on the ones that break the workflow; report the rest, since several are
# optional settings with their own fallbacks in the node code.
blob = json.dumps(wf)
missing = sorted(set(re.findall(r"\$env\.([A-Z_]+)", blob)))
fatal = [m for m in missing if m in REQUIRED]
if fatal:
    print(f"    !! no value for {', '.join(fatal)} - aborting", file=sys.stderr)
    print("    !! run: sh ~/sanaku.sh config", file=sys.stderr)
    sys.exit(1)
for m in missing:
    print(f"    note: {m} is not set - the node using it falls back to a default")

# Nodes needing a credential this script does not create (Gmail, Calendar,
# RingCentral) are disabled rather than left to fail mid-run. Connect the
# credential in the n8n UI, then re-enable.
NEEDS_MANUAL = ("gmail", "googleCalendar", "googleSheets")
for node in wf["nodes"]:
    if any(m.lower() in node["type"].lower() for m in NEEDS_MANUAL):
        node["disabled"] = True
        node.pop("credentials", None)
        print(f"    disabled (needs a Google credential): {node['name']}")

hooks = [n["parameters"].get("path") for n in wf["nodes"]
         if n["type"] == "n8n-nodes-base.webhook"]
json.dump({
    "name": wf["name"],
    "nodes": wf["nodes"],
    "connections": wf["connections"],
    "settings": {"executionOrder": "v1", "timezone": "America/Los_Angeles"},
}, open(f"{tmp}/patched.json", "w"))
# Trailing newline matters: `while read` discards a final line without one,
# which silently swallowed the webhook URL this script exists to tell you.
open(f"{tmp}/meta", "w").write(
    "".join(line + "\n" for line in [wf["name"]] + [h for h in hooks if h]))
print("    patched")
PY

WF_NAME=$(head -1 "$TMP/meta")

cat > "$TMP/find.py" <<'PY'
import json, sys
listing, want = sys.argv[1], sys.argv[2]
for w in json.load(open(listing)).get("data", []):
    if w.get("name") == want:
        print(w["id"])
PY

echo "==> Replacing any previous copy of \"$WF_NAME\"..."
# The name is passed as an ARGUMENT, not through the environment. An earlier
# version piped n8n's response into `python3 -c` and read the name from an
# env var, which is fragile in two ways at once: a `VAR=x cmd | other` prefix
# applies to `cmd` and not to the `other` that reads it, and an env var that
# is set-but-unexported vanishes at the process boundary. Argv has neither
# failure mode. Writing the response to a file also drops the pipe entirely.
api GET "/workflows?limit=250" > "$TMP/list.json"
python3 "$TMP/find.py" "$TMP/list.json" "$WF_NAME" | while read -r wid; do
  [ -n "$wid" ] && api DELETE "/workflows/$wid" > /dev/null && echo "    deleted old copy $wid"
done

echo "==> Importing..."
WF_ID=$(curl -fsS -X POST "$N8N_URL/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_KEY" -H "Content-Type: application/json" \
  --data-binary "@$TMP/patched.json" | jsonget 'd["id"]')
echo "    workflow id: $WF_ID"

if [ "$ACTIVATE" = "1" ]; then
  echo "==> Activating..."
  if api POST "/workflows/$WF_ID/activate" > /dev/null 2>&1; then
    echo "    active"
  else
    echo "    could not auto-activate (workflow may have no trigger)."
    echo "    Open it in n8n and toggle Active if it needs to be."
  fi
fi

echo
echo "Imported: $WF_NAME"
tail -n +2 "$TMP/meta" | while read -r p; do
  [ -n "$p" ] && echo "  webhook: $N8N_URL/webhook/$p"
done
echo
