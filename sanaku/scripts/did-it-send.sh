#!/bin/sh
# Did anything actually send?
#
# Written after 2026-08-11, when the dashboard reported 11 sends and the true
# number was zero. The lesson was that a system asked "did you send?" will
# happily answer from its own bookkeeping. So this reports FOUR independent
# signals and does not average them - where they disagree, that disagreement is
# the finding.
#
#   1. DELIVERED   rows in sanaku_conversations. Written only after Zoho
#                  returned a messageId, so this is the closest thing to proof
#                  the database holds.
#   2. CONTACTED   prospects moved to status='contacted'. Should track (1).
#   3. FAILED      W2s errors in the last 24h. Should be 0.
#   4. ALLOWANCE   sanaku_send_budget.sent. Should EQUAL today's delivered
#                  count - it is a reservation counter, and any gap means
#                  slots were claimed by sends that never happened.
#
# The one signal not listed here is the only external one: your Zoho Sent
# folder. Check it. Nothing in this script can be wrong in the same way that
# folder can.
#
#   sh scripts/did-it-send.sh
set -eu

ENVFILE="$HOME/.sanaku.env"
[ -f "$ENVFILE" ] || { echo "missing $ENVFILE"; exit 1; }
# shellcheck disable=SC1090
. "$ENVFILE"

: "${SUPABASE_URL:?}" ; : "${SUPABASE_SERVICE_KEY:?}"

api() {
  curl -sS "$SUPABASE_URL/rest/v1/$1" \
    -H "apikey: $SUPABASE_SERVICE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_KEY"
}

export SUPABASE_URL SUPABASE_SERVICE_KEY
python3 - <<'PY'
import json, os, subprocess, datetime, urllib.parse

U, K = os.environ['SUPABASE_URL'], os.environ['SUPABASE_SERVICE_KEY']
today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()

# quote() the timestamp: an ISO string ends in "+00:00", and a raw + in a query
# string is decoded as a space, so PostgREST reads "...142376 00:00" and rejects
# it as a malformed timestamp. Encoding it turns the filter back into a filter
# instead of an error that reads as "no failures found".
since = urllib.parse.quote(
    (datetime.datetime.now(datetime.timezone.utc)
     - datetime.timedelta(hours=24)).isoformat())

ERRORS = []

def get(path):
    """Fetch rows, or record WHY not.

    Never returns [] to paper over a failure. A checking tool that answers
    "zero" when it means "I could not tell" is the precise failure mode this
    script exists to catch - an earlier version of it queried a column named
    'company' (the column is 'company_name'), got a 42703 back, swallowed it,
    and cheerfully reported 0 contacted prospects when there were 4.
    """
    out = subprocess.run(
        ["curl", "-sS", f"{U}/rest/v1/{path}",
         "-H", f"apikey: {K}", "-H", f"Authorization: Bearer {K}"],
        capture_output=True, text=True).stdout
    try:
        d = json.loads(out)
    except Exception:
        ERRORS.append(f"{path.split('?')[0]}: unreadable response {out[:120]}")
        return None
    if isinstance(d, list):
        return d
    ERRORS.append(f"{path.split('?')[0]}: {d.get('message', str(d)[:120])}")
    return None


def n(rows):
    """Count, or '?' when the query failed. Never a number we cannot stand behind."""
    return '?' if rows is None else len(rows)

sent_all   = get("sanaku_conversations?select=subject,sent_at,prospect_id"
                 "&channel=eq.email&direction=eq.outbound&order=sent_at.desc")
sent_today = ([r for r in sent_all if str(r.get('sent_at', ''))[:10] == today]
              if sent_all is not None else None)
contacted  = get("sanaku_prospects?select=company_name,contact_email,last_contacted"
                 "&status=eq.contacted")
failures   = get(f"sanaku_errors?select=error,occurred_at&workflow=like.*W2s*"
                 f"&occurred_at=gte.{since}")
budget     = get(f"sanaku_send_budget?select=cap,sent&day=eq.{today}")
blocked    = get("sanaku_prospects?select=company_name,send_last_error&status=eq.send_blocked")
approved   = get("sanaku_prospects?select=id&status=eq.approved")

claimed = budget[0]['sent'] if budget else 0
cap     = budget[0]['cap']  if budget else 15

print()
print(f"  DELIVERED   {n(sent_all)} ever, {n(sent_today)} today")
print(f"  CONTACTED   {n(contacted)} prospects")
print(f"  FAILED      {n(failures)} send errors in the last 24h")
print(f"  ALLOWANCE   {claimed} of {cap} claimed today")
print(f"  WAITING     {n(approved)} approved drafts")
if blocked:
    print(f"  BLOCKED     {n(blocked)} parked after repeated failures")
print()

# A query that failed is reported as a failure, never folded into a count.
for e in ERRORS:
    print(f"  ?? COULD NOT CHECK - {e}")
if ERRORS:
    print("  Counts above marked '?' are unknown, not zero.\n")

# --- where the signals disagree -------------------------------------------
verdict = []
if sent_today is not None and claimed != len(sent_today):
    verdict.append(
        f"MISMATCH: {claimed} slot(s) claimed today but {len(sent_today)} delivered. "
        "Slots were spent on sends that did not happen.")
if failures and not sent_today:
    verdict.append(
        f"The sender looks DOWN: {len(failures)} failure(s) and nothing delivered in 24h.")
elif failures:
    verdict.append(f"Partially working: {len(failures)} failure(s) alongside real deliveries.")
if sent_all is not None and not sent_all:
    verdict.append("No email has EVER been sent from this system.")

for v in verdict:
    print(f"  !! {v}")
if not verdict and not ERRORS:
    print("  All four signals agree.")

if sent_all:
    print("\n  Most recent deliveries:")
    for r in sent_all[:5]:
        print(f"    {str(r.get('sent_at'))[:19]}  {str(r.get('subject'))[:56]}")

if blocked:
    print("\n  Parked prospects:")
    for b in blocked[:5]:
        print(f"    {str(b.get('company_name'))[:30]:32} {str(b.get('send_last_error'))[:60]}")

print("\n  Now confirm externally: open the Sent folder in Zoho Mail.")
print("  It is the only signal here that Sanaku does not write itself.\n")
PY
