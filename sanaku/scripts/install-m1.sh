#!/usr/bin/env bash
# ============================================================================
# Install M1 - the LinkedIn content studio - onto the Sanaku n8n.
#
# n8n/workflows/m1-content-studio.json carries the repo's PLACEHOLDER
# credential ids, the same as every other workflow in that directory. This
# script swaps them for the ids that actually exist on the instance, then
# creates (or updates) and activates the workflow.
#
# Credentials: M1's own pair is created once, from ~/.sanaku.env, and REUSED on
# every later run. Two things drove that.
#
# Inheriting a credential from another workflow does not work. Three separate
# credentials on this instance are all named "Supabase Service Role (Custom
# Auth)" and at least one holds a stale key, so "whichever one the newest
# workflow uses" picked a dead one - and the failure only showed up at run time
# as "401 Invalid API key", three nodes in, looking like a broken credential
# rather than the wrong one.
#
# Creating a fresh pair every run does not work either: that is how the instance
# grew three identical Supabase credentials in the first place. So M1 tags its
# own with a "- M1" suffix and reuses them. ROTATE_CREDS=1 forces new ones,
# which is what to use after rotating a key.
#
# Usage:
#   sh sanaku/scripts/install-m1.sh                 # install + activate
#   ROTATE_CREDS=1 sh sanaku/scripts/install-m1.sh  # after a key rotation
#
# Reads N8N_URL / N8N_KEY from ~/.sanaku.env. Safe to run more than once.
# ============================================================================
set -eu

CONFIG="$HOME/.sanaku.env"
[ -f "$CONFIG" ] || { echo "Missing $CONFIG - run 'sh ~/sanaku.sh config' first."; exit 1; }
# shellcheck disable=SC1090
. "$CONFIG"

HERE="$(cd "$(dirname "$0")" && pwd)"
WF="$HERE/../n8n/workflows/m1-content-studio.json"
[ -f "$WF" ] || { echo "Missing $WF - run: node n8n/build/m1-content-studio.mjs $WF"; exit 1; }

export N8N_URL N8N_KEY WF
export SUPABASE_URL SUPABASE_SERVICE_KEY SUPABASE_ANON_KEY
export OPENROUTER_KEY="${OPENROUTER_KEY:-}"

python3 - <<'PY'
import json, os, subprocess, tempfile

BASE = os.environ["N8N_URL"].rstrip("/")
KEY  = os.environ["N8N_KEY"]
WF   = os.environ["WF"]

def api(method, path, body=None):
    """HTTP via curl, deliberately not urllib.

    A python.org Python on macOS ships with no CA bundle until someone runs
    'Install Certificates.command', so urllib dies with CERTIFICATE_VERIFY_FAILED
    against any https host - which is exactly what breaks 'sanaku.sh migrate' on
    this machine. curl uses the system trust store and just works. The fix is
    curl, never disabling verification.
    """
    cmd = ["curl", "-sS", "-X", method, BASE + path,
           "-H", f"X-N8N-API-KEY: {KEY}", "-H", "Content-Type: application/json",
           "-w", "\n%{http_code}"]
    tmp = None
    if body is not None:
        tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        json.dump(body, tmp); tmp.close()
        cmd += ["--data-binary", "@" + tmp.name]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=120).stdout
    finally:
        if tmp:
            os.unlink(tmp.name)
    payload, _, code = out.rpartition("\n")
    if not code.isdigit() or int(code) >= 300:
        raise SystemExit(f"    !! {method} {path} -> HTTP {code}: {payload[:400]}")
    return json.loads(payload or "{}")

# ------------------------------------------------------------- credentials --
# Supabase: CREATE a fresh credential from ~/.sanaku.env rather than inherit an
# existing one.
#
# Inheriting was the first approach and it failed in a way worth recording:
# there are three separate credentials on this instance all named "Supabase
# Service Role (Custom Auth)", left by repeated installer runs, and at least one
# of them holds a stale key. Picking "the one the most recently updated workflow
# uses" chose a dead one, and the failure surfaced only at run time as
# "Authorization failed - Invalid API key", three nodes in. The key in
# ~/.sanaku.env is the one every other Sanaku tool already authenticates with,
# so it is the only one worth trusting.
found = {}

# Re-running must not mint a new pair of credentials every time. The first
# version of this script did, which is how the instance ended up with three
# identically-named Supabase credentials in the first place - the exact mess
# this script exists to navigate around. So: if M1 is already installed and
# already points at credentials this script created, reuse them.
#
# ROTATE_CREDS=1 forces fresh ones. That is the escape hatch for the one case
# reuse gets wrong - the key in ~/.sanaku.env has changed, and the stored
# credential still holds the old one.
ROTATE = os.environ.get("ROTATE_CREDS") == "1"
existing = next((w for w in api("GET", "/api/v1/workflows?limit=250")["data"]
                 if w["name"] == json.load(open(WF))["name"]), None)
if existing and not ROTATE:
    prev = api("GET", f"/api/v1/workflows/{existing['id']}")
    for node in prev.get("nodes", []):
        for ctype, cred in (node.get("credentials") or {}).items():
            if not cred.get("name", "").endswith("- M1"):
                continue
            slot = "supabase" if ctype == "httpCustomAuth" else "openrouter"
            found.setdefault(slot, cred)
    if found:
        print("==> Reusing this workflow's existing credentials "
              "(ROTATE_CREDS=1 to replace them)")
        for slot, cred in found.items():
            print(f"    {slot:10} {cred['id']}")

print("==> Checking the service key actually works...")
supa_url = os.environ.get("SUPABASE_URL", "").rstrip("/")
supa_key = os.environ.get("SUPABASE_SERVICE_KEY", "")
if not supa_url or not supa_key:
    raise SystemExit("    !! SUPABASE_URL / SUPABASE_SERVICE_KEY missing from ~/.sanaku.env")
probe = subprocess.run(
    ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}",
     f"{supa_url}/rest/v1/content_queue?select=id&limit=1",
     "-H", f"apikey: {supa_key}", "-H", f"Authorization: Bearer {supa_key}"],
    capture_output=True, text=True).stdout.strip()
if probe != "200":
    raise SystemExit(f"    !! service key rejected by Supabase (HTTP {probe}) - fix it before installing")
print("    ok")

if "supabase" not in found:
  print("==> Creating the Supabase credential...")
  found["supabase"] = {
      "id": api("POST", "/api/v1/credentials", {
          "name": "Supabase Service Role (Custom Auth) - M1",
          "type": "httpCustomAuth",
          "data": {"json": json.dumps(
              {"headers": {"apikey": supa_key, "Authorization": "Bearer " + supa_key}})},
      })["id"],
      "name": "Supabase Service Role (Custom Auth) - M1",
  }
  print(f"    supabase   {found['supabase']['id']}")

# OpenRouter: create from OPENROUTER_KEY when ~/.sanaku.env has one, otherwise
# fall back to whatever credential the existing content workflows use.
or_key = os.environ.get("OPENROUTER_KEY", "")
if "openrouter" in found:
    pass
elif or_key:
    print("==> Creating the OpenRouter credential...")
    found["openrouter"] = {
        "id": api("POST", "/api/v1/credentials", {
            "name": "OpenRouter Sanaku - M1",
            "type": "httpHeaderAuth",
            "data": {"name": "Authorization", "value": "Bearer " + or_key},
        })["id"],
        "name": "OpenRouter Sanaku - M1",
    }
    print(f"    openrouter {found['openrouter']['id']}")
else:
    print("==> No OPENROUTER_KEY in ~/.sanaku.env - reusing an existing credential...")
    for w in sorted(api("GET", "/api/v1/workflows?limit=250")["data"],
                    key=lambda x: x.get("updatedAt", ""), reverse=True):
        full = api("GET", f"/api/v1/workflows/{w['id']}")
        for node in full.get("nodes", []):
            for ctype, cred in (node.get("credentials") or {}).items():
                if ctype == "httpHeaderAuth" and "OpenRouter" in cred.get("name", ""):
                    found["openrouter"] = cred
                    print(f"    openrouter {cred['id']}  ({w['name']})")
                    break
            if "openrouter" in found: break
        if "openrouter" in found: break
    if "openrouter" not in found:
        raise SystemExit(
            "    !! No OpenRouter credential found and no OPENROUTER_KEY set.\n"
            "       sh ~/sanaku.sh set OPENROUTER_KEY sk-or-v1-...")

# -------------------------------------------------------------------- wire --
wf = json.load(open(WF))

# Hardcode the Supabase URL, exactly as setup-sanaku.sh does for the T/W
# workflows. This is NOT belt-and-braces - it is required.
#
# The n8n droplet hosts two unrelated stacks, Sanaku and TCR, and has a single
# $env.SUPABASE_URL. It points at TCR (egrouxublcekfsrplxdv). Left as an
# expression, every Sanaku query resolves to the TCR project, authenticates
# with a key that project has never seen, and comes back "401 Invalid API key"
# - which reads like a broken credential and sends you hunting in the wrong
# place. Every installed Sanaku workflow carries the literal URL for this
# reason; M1 is no different.
raw = json.dumps(wf).replace("{{ $env.SUPABASE_URL }}", os.environ["SUPABASE_URL"].rstrip("/"))

# The anon key needs pinning for the same reason and is safe to pin: it is
# already public by design, compiled into the deployed dashboard bundle. It is
# NOT committed - the repo keeps the placeholder and the instance gets the
# literal, exactly as setup-sanaku.sh does for the T/W workflows.
#
# Without this the Generate button's authorisation call goes out with an empty
# apikey header, PostgREST rejects it, and every request - including a genuine
# staff one - comes back "not authorised".
anon = os.environ.get("SUPABASE_ANON_KEY", "")
if not anon:
    raise SystemExit("    !! SUPABASE_ANON_KEY missing from ~/.sanaku.env - the "
                     "Generate button cannot authorise without it")
raw = raw.replace("{{ $env.SUPABASE_ANON_KEY }}", anon)

wf = json.loads(raw)
print(f"==> Pinned Supabase URL to {os.environ['SUPABASE_URL']}")
print("==> Pinned the anon key for the Generate button's auth check")

rewired = 0
for node in wf["nodes"]:
    creds = node.get("credentials") or {}
    if "httpCustomAuth" in creds:
        creds["httpCustomAuth"] = found["supabase"]; rewired += 1
    if "httpHeaderAuth" in creds and "OpenRouter" in creds["httpHeaderAuth"].get("name", ""):
        creds["httpHeaderAuth"] = found["openrouter"]; rewired += 1
print(f"==> Rewired {rewired} credential reference(s)")

# n8n's POST /workflows rejects read-only fields; send only what it accepts.
payload = {k: wf[k] for k in ("name", "nodes", "connections", "settings") if k in wf}

existing = next((w for w in api("GET", "/api/v1/workflows?limit=250")["data"]
                 if w["name"] == wf["name"]), None)
if existing:
    print(f"==> Updating existing workflow {existing['id']}")
    wid = existing["id"]
    api("PUT", f"/api/v1/workflows/{wid}", payload)
else:
    print("==> Creating workflow")
    wid = api("POST", "/api/v1/workflows", payload)["id"]

api("POST", f"/api/v1/workflows/{wid}/activate")
print(f"==> Active: {wid}")
print(f"    {BASE}/workflow/{wid}")
PY

cat <<'NOTE'

Images: the Alexya wrapper listens on the Mac at 127.0.0.1:8000, which the
remote n8n cannot reach. The image step is non-fatal, so items still queue with
their text complete - the illustrations are filled in afterwards by the local
backfill worker (com.sanaku.illustrator). Nothing to do here.
NOTE
