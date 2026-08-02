"""Send one .sql file to Supabase's Management API.

Called by `sanaku.sh migrate`. Exists so the operator never has to paste SQL
into a web editor - the thing that has caused the most friction in this build.

Reads SQL_FILE, PROJECT_REF and PAT from the environment.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sql = open(os.environ["SQL_FILE"], encoding="utf-8").read()
url = "https://api.supabase.com/v1/projects/%s/database/query" % os.environ["PROJECT_REF"]

req = urllib.request.Request(
    url,
    data=json.dumps({"query": sql}).encode("utf-8"),
    headers={
        "Authorization": "Bearer " + os.environ["PAT"],
        "Content-Type": "application/json",
    },
    method="POST",
)

try:
    urllib.request.urlopen(req, timeout=180).read()
    print("applied")
except urllib.error.HTTPError as e:
    body = e.read().decode("utf-8", "replace")[:500]
    print("FAILED (HTTP %s)" % e.code)
    print("    %s" % body)
    # Separate "your SQL is wrong" from "this script's assumption about the
    # API is wrong" - they need completely different responses.
    if e.code == 404:
        print("    The endpoint does not exist. Paste the file into the SQL")
        print("    Editor instead, and say that migrate 404'd.")
    elif e.code in (401, 403):
        print("    The token was rejected. Make a new one at")
        print("    supabase.com/dashboard/account/tokens, then:")
        print("      sh ~/sanaku.sh set SUPABASE_PAT sbp_...")
    sys.exit(1)
except Exception as e:                              # network, timeout, DNS
    print("FAILED (%s)" % e)
    sys.exit(1)
