#!/usr/bin/env bash
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
set -euo pipefail

: "${N8N_URL:?Set N8N_URL}"
: "${N8N_KEY:?Set N8N_KEY}"
: "${SUPABASE_URL:?Set SUPABASE_URL}"
: "${SUPABASE_SERVICE_KEY:?Set SUPABASE_SERVICE_KEY}"
: "${WF_FILE:?Set WF_FILE (e.g. invite-client-user.json)}"
DASHBOARD_URL="${DASHBOARD_URL:-https://sanaku-command-center.netlify.app}"
OWNER_EMAIL="${OWNER_EMAIL:-}"
SERPAPI_KEY="${SERPAPI_KEY:-}"
ACTIVATE="${ACTIVATE:-1}"

N8N_URL="${N8N_URL%/}"
BRANCH="claude/n8n-prospect-tiering-hgkjb0"
RAW="https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/${BRANCH}/sanaku/n8n/workflows"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

api() { # method path [json-body]
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -fsS -X "$method" "$N8N_URL/api/v1$path" \
      -H "X-N8N-API-KEY: $N8N_KEY" -H "Content-Type: application/json" \
      --data-binary "$body"
  else
    curl -fsS -X "$method" "$N8N_URL/api/v1$path" -H "X-N8N-API-KEY: $N8N_KEY"
  fi
}
jsonget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1"; }

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

echo "==> Patching for this instance..."
export SUPA_CRED_ID DASHBOARD_URL OWNER_EMAIL SERPAPI_KEY TMPDIR_WF="$TMP"
python3 <<'PY'
import json, os, re, sys

tmp = os.environ["TMPDIR_WF"]
wf = json.load(open(f"{tmp}/wf.json"))
supa_id = os.environ["SUPA_CRED_ID"]

# Known values, by the env var name the workflows use.
VALUES = {
    "SUPABASE_URL":       os.environ["SUPABASE_URL"].rstrip("/"),
    "DASHBOARD_URL":      os.environ["DASHBOARD_URL"].rstrip("/"),
    "SANAKU_OWNER_EMAIL": os.environ.get("OWNER_EMAIL", ""),
    "SERPAPI_KEY":        os.environ.get("SERPAPI_KEY", ""),
}
VALUES = {k: v for k, v in VALUES.items() if v}

# Without these the workflow fails in a way that looks like something else:
# a bad SUPABASE_URL reads as an auth error, and a bad DASHBOARD_URL sends
# the client an invite link that 404s.
REQUIRED = {"SUPABASE_URL", "DASHBOARD_URL"}

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
open(f"{tmp}/meta", "w").write(wf["name"] + "\n" + "\n".join(h for h in hooks if h))
print("    patched")
PY

WF_NAME=$(head -1 "$TMP/meta")

echo "==> Replacing any previous copy of \"$WF_NAME\"..."
# Must be exported, not prefixed: a `VAR=x cmd | other` prefix applies only to
# `cmd`, and it is `other` - the python3 on the far side of the pipe - that
# reads it.
export WF_NAME
api GET "/workflows?limit=250" | python3 -c '
import sys, json, os
for w in json.load(sys.stdin).get("data", []):
    if w.get("name") == os.environ["WF_NAME"]:
        print(w["id"])
' | while read -r wid; do
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
