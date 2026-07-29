#!/usr/bin/env bash
# ============================================================================
# Sanaku one-shot setup: installs and test-runs W1 on a reachable n8n instance.
#
#   1. Creates the Supabase + Apollo credentials in n8n (via the n8n API)
#   2. Downloads w1-prospect-scraper.json from GitHub, patches it for this
#      instance (hardcodes the Supabase URL, caps the run at 20 prospects,
#      disables the Gmail digest node, wires the new credential IDs, adds a
#      run-now webhook)
#   3. Imports + activates the workflow and triggers a test run
#   4. Waits for it to finish and prints the scored prospects from Supabase
#
# Usage (all five values required, passed as env vars):
#   N8N_URL=http://host:5678 \
#   N8N_KEY=<n8n api key> \
#   SUPABASE_URL=https://ref.supabase.co \
#   SUPABASE_SERVICE_KEY=<service_role key> \
#   APOLLO_KEY=<apollo api key> \
#   OWNER_EMAIL=you@example.com \
#   bash setup-sanaku.sh
#
# Requires: bash, curl, python3 (all present on macOS by default).
# Never commit real key values into this file.
# ============================================================================
set -euo pipefail

: "${N8N_URL:?Set N8N_URL (e.g. http://1.2.3.4:5678)}"
: "${N8N_KEY:?Set N8N_KEY (n8n Settings > n8n API)}"
: "${SUPABASE_URL:?Set SUPABASE_URL (https://<ref>.supabase.co)}"
: "${SUPABASE_SERVICE_KEY:?Set SUPABASE_SERVICE_KEY (service_role key)}"
: "${SERPAPI_KEY:?Set SERPAPI_KEY (serpapi.com key - free tier, the primary data source)}"
APOLLO_KEY="${APOLLO_KEY:-}"   # optional: Apollo's free plan has no API access
: "${OWNER_EMAIL:?Set OWNER_EMAIL (your email for digests)}"
MAX_NEW="${MAX_NEW:-20}"

N8N_URL="${N8N_URL%/}"
RAW_WF="https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/claude/n8n-prospect-tiering-hgkjb0/sanaku/n8n/workflows/w1-prospect-scraper.json"
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

echo "==> Checking Supabase (schema must already be applied)..."
# BOTH headers are required: apikey alone is treated as an anonymous request
# and RLS silently blanks reads / rejects writes.
curl -fsS "$SUPABASE_URL/rest/v1/sanaku_prospects?select=id&limit=1" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" > /dev/null
echo "    ok"

echo "==> Creating credentials in n8n..."
SUPA_CRED_ID=$(api POST "/credentials" "$(python3 -c '
import json, os
key = os.environ["SUPABASE_SERVICE_KEY"]
print(json.dumps({
  "name": "Supabase Service Role (Custom Auth)",
  "type": "httpCustomAuth",
  "data": {"json": json.dumps({"headers": {"apikey": key, "Authorization": "Bearer " + key}})},
}))')" | jsonget 'd["id"]')
APOLLO_CRED_ID=""
if [ -n "$APOLLO_KEY" ]; then
  APOLLO_CRED_ID=$(api POST "/credentials" "$(python3 -c '
import json, os
print(json.dumps({
  "name": "Apollo API Key (Header Auth)",
  "type": "httpHeaderAuth",
  "data": {"name": "x-api-key", "value": os.environ["APOLLO_KEY"]},
}))')" | jsonget 'd["id"]')
fi
echo "    supabase cred: $SUPA_CRED_ID | apollo cred: ${APOLLO_CRED_ID:-skipped (no APOLLO_KEY)}"

echo "==> Downloading + patching W1..."
curl -fsSL "$RAW_WF" -o "$TMP/w1.json"
export SUPA_CRED_ID APOLLO_CRED_ID MAX_NEW TMPDIR_WF="$TMP"
python3 <<'PY'
import json, os

tmp = os.environ["TMPDIR_WF"]
wf = json.load(open(f"{tmp}/w1.json"))
supa_url = os.environ["SUPABASE_URL"].rstrip("/")
owner = os.environ["OWNER_EMAIL"]
supa_id, apollo_id = os.environ["SUPA_CRED_ID"], os.environ["APOLLO_CRED_ID"]
max_new = int(os.environ["MAX_NEW"])

serp_key = os.environ["SERPAPI_KEY"]

def patch_strings(obj):
    if isinstance(obj, dict):
        return {k: patch_strings(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [patch_strings(v) for v in obj]
    if isinstance(obj, str):
        # hardcode values this instance has no env vars for
        obj = obj.replace("{{ $env.SUPABASE_URL }}", supa_url)
        obj = obj.replace("{{ $env.SANAKU_OWNER_EMAIL }}", owner)
        obj = obj.replace("{{ $env.SERPAPI_KEY }}", serp_key)
        # expressions that became pure literals don't need the '=' prefix,
        # but n8n accepts it either way, so leave prefixes alone.
        return obj
    return obj

wf = patch_strings(wf)

for node in wf["nodes"]:
    creds = node.get("credentials", {})
    if "httpHeaderAuth" in creds:
        name = creds["httpHeaderAuth"].get("name", "")
        if "Supabase" in name:
            # Supabase needs two headers (apikey + Authorization), which Header
            # Auth can't express - switch these nodes to the Custom Auth credential.
            node["parameters"]["genericAuthType"] = "httpCustomAuth"
            del creds["httpHeaderAuth"]
            creds["httpCustomAuth"] = {"id": supa_id, "name": "Supabase Service Role (Custom Auth)"}
        elif "Apollo" in name:
            if apollo_id:
                creds["httpHeaderAuth"] = {"id": apollo_id, "name": "Apollo API Key (Header Auth)"}
            else:
                # No Apollo key: the Apollo nodes are gated off (useApollo=false)
                # and must not reference a credential that doesn't exist.
                del creds["httpHeaderAuth"]
                node["parameters"].pop("authentication", None)
                node["parameters"].pop("genericAuthType", None)
    if node["name"] == "Run Config":
        node["parameters"]["jsCode"] = node["parameters"]["jsCode"].replace(
            "maxNewPerRun: 50", f"maxNewPerRun: {max_new}")
    if node["name"] == "Send Digest":
        node["disabled"] = True          # no Gmail credential yet; data still saves
        node.pop("credentials", None)

# a webhook so the workflow can be triggered remotely for the test run
wf["nodes"].append({
    "parameters": {"httpMethod": "GET", "path": "sanaku-run-w1", "options": {}},
    "id": "f1000000-0000-4000-8000-0000000000aa",
    "name": "Manual Run Hook",
    "type": "n8n-nodes-base.webhook",
    "typeVersion": 2,
    "position": [120, 940],
    "webhookId": "f1000000-0000-4000-8000-0000000000ab",
})
wf["connections"]["Manual Run Hook"] = {"main": [[{"node": "Run Config", "type": "main", "index": 0}]]}

payload = {
    "name": wf["name"],
    "nodes": wf["nodes"],
    "connections": wf["connections"],
    "settings": {"executionOrder": "v1", "timezone": "America/Los_Angeles"},
}
json.dump(payload, open(f"{tmp}/w1-patched.json", "w"))
print("    patched")
PY

echo "==> Removing any previous Sanaku W1 imports (idempotent re-runs)..."
api GET "/workflows?limit=250" | python3 -c '
import sys, json
d = json.load(sys.stdin)
for w in d.get("data", []):
    if w.get("name") == "Sanaku - W1 Prospect Scraper & Scorer":
        print(w["id"])
' | while read -r wid; do
  [ -n "$wid" ] && api DELETE "/workflows/$wid" > /dev/null && echo "    deleted stale workflow $wid"
done

echo "==> Importing workflow..."
WF_ID=$(curl -fsS -X POST "$N8N_URL/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_KEY" -H "Content-Type: application/json" \
  --data-binary "@$TMP/w1-patched.json" | jsonget 'd["id"]')
echo "    workflow id: $WF_ID"

echo "==> Activating..."
api POST "/workflows/$WF_ID/activate" > /dev/null
echo "    active (weekly Mon 08:00 PT schedule is now live, capped at $MAX_NEW/run)"

echo "==> Triggering test run..."
sleep 2
curl -fsS -m 20 "$N8N_URL/webhook/sanaku-run-w1" > /dev/null || true
echo "    started - scraping takes 2-5 minutes (2s politeness delay per site)"

echo "==> Waiting for the run to finish..."
STATUS="running"
for i in $(seq 1 60); do
  sleep 10
  STATUS=$(api GET "/executions?workflowId=$WF_ID&limit=1" | \
    jsonget '(d.get("data") or [{}])[0].get("status", "waiting")')
  printf "    %ss elapsed - status: %s\n" $((i * 10)) "$STATUS"
  [ "$STATUS" = "success" ] || [ "$STATUS" = "error" ] || [ "$STATUS" = "crashed" ] && break
done

echo ""
echo "==> Scored prospects in Supabase (best first):"
curl -fsS "$SUPABASE_URL/rest/v1/sanaku_prospects?select=company_name,vertical,tier,intent_score,employee_count,contact_name,contact_email,signals&order=intent_score.desc&limit=25" \
  -H "apikey: $SUPABASE_SERVICE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_KEY" | python3 -c '
import sys, json
rows = json.load(sys.stdin)
if not rows:
    print("  (none - check the execution log in the n8n UI and sanaku_errors in Supabase)")
for i, r in enumerate(rows, 1):
    why = (r.get("signals") or {}).get("reason", "")
    line = "%2d. T%s %3s  %-38s %-13s %s" % (
        i, r.get("tier"), r.get("intent_score"),
        (r.get("company_name") or "")[:38],
        (r.get("vertical") or "")[:13],
        (r.get("contact_email") or "no email")[:30])
    print(line)
    if why:
        print("        why: " + why)
'
echo ""
echo "Done. Errors/skips (if any): $SUPABASE_URL  -> table sanaku_errors"
if [ "$STATUS" != "success" ]; then
  echo "NOTE: final execution status was '$STATUS' - open the execution in the n8n UI to see which node failed."
fi
