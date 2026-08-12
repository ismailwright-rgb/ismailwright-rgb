#!/usr/bin/env python3
"""Send the outreach drafts Ismail has approved.

WHY THIS RUNS HERE AND NOT ON THE DROPLET
-----------------------------------------
W2s did this in n8n and never delivered a single message. Every attempt ended
in a TCP connection timeout at exactly 120 seconds against smtppro.zoho.com:587.
The droplet cannot open an outbound SMTP connection at all - Zoho IMAP on 993
works fine from the same host, so it is a port-level block rather than a Zoho or
credential problem. DigitalOcean blocks outbound SMTP on droplets by default.

This machine reaches port 587 in 0.1s and authenticates. So the sender moved to
where the network actually works, alongside the illustrator, which already runs
here on the same pattern.

The n8n path is not deleted - install-zoho-api-sender.sh wires W2s to the Zoho
Mail REST API over 443, which the droplet CAN reach. That needs a Self Client
authorised in the Zoho console, which only Ismail can create. When it exists,
the droplet sends and this script becomes the backup. Until then, this is it.

WHAT IT GUARANTEES
------------------
Every brake W2s had, kept:

  1. The global switch. sanaku_send_enabled() must return true. It is a row in
     sanaku_settings, so it can be flipped from the dashboard.
  2. The daily ramp. Each send claims a slot through sanaku_claim_send_slot(),
     which increments and tests in ONE statement, so two runs cannot both take
     the last slot. A failure calls sanaku_record_send_failure(), which gives
     the slot back - the counter therefore measures sends, not attempts.
  3. The recipient gate. status='approved' AND email_verified AND
     decision_maker AND NOT do_not_contact AND a real address AND an approved
     draft body.
  4. Business hours, 08:00-17:00 PT weekdays, in the recipient's timezone.

And one thing W2s did not do: after sending, the message is APPENDed to the
Zoho Sent folder over IMAP. SMTP submission never files a copy, which is why
sent mail was invisible in the mailbox even before the port block was found.

USAGE
    python3 send-approved.py --dry-run          # show what would go, send nothing
    python3 send-approved.py --test-to me       # real send path, redirected to yourself
    python3 send-approved.py                    # send one, for real
    python3 send-approved.py --limit 3          # send up to three
    python3 send-approved.py --force            # ignore the business-hours window
"""

import argparse
import datetime as dt
import email.utils
import fcntl
import json
import os
import smtplib
import ssl
import sys
import time
import urllib.parse
import urllib.request
from email.message import EmailMessage

import certifi
import imaplib

ENV_FILE = os.path.expanduser("~/.sanaku.env")
LOCK_FILE = "/tmp/sanaku-send-approved.lock"

FROM_NAME = "Ismail Rogers-Wright"
MAILING_ADDRESS = os.environ.get("SANAKU_MAILING_ADDRESS", "Sanaku, Los Angeles County, CA")

# The gate, spelled out once. Every condition here is also enforced in SQL by
# the workflow that approves drafts; repeating it is deliberate - this is the
# last code that runs before a stranger receives mail.
SELECT = (
    "sanaku_prospects"
    "?status=eq.approved"
    "&email_verified=is.true"
    "&decision_maker=is.true"
    "&do_not_contact=is.false"
    "&contact_email=not.is.null"
    "&draft_body=not.is.null"
    "&select=id,company_name,contact_name,first_name,contact_email,vertical,status,"
    "email_verified,decision_maker,do_not_contact,draft_subject,draft_body,draft_step"
    # send_failed_at first, nulls first: on 2026-08-11 the sender retried one
    # unreachable address twelve times and burned the whole day's cap, because
    # the only ordering was draft age and a failure left no trace on the row.
    "&order=send_failed_at.asc.nullsfirst,draft_generated_at.asc"
)


def load_env():
    if not os.path.exists(ENV_FILE):
        sys.exit(f"missing {ENV_FILE}")
    for line in open(ENV_FILE):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip("'\""))


class Supa:
    """Thin PostgREST client that never turns a failure into an empty result."""

    def __init__(self):
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        self.key = os.environ["SUPABASE_SERVICE_KEY"]

    def _call(self, path, method="GET", body=None, prefer=None):
        req = urllib.request.Request(f"{self.url}/rest/v1/{path}", method=method)
        req.add_header("apikey", self.key)
        req.add_header("Authorization", f"Bearer {self.key}")
        req.add_header("Content-Type", "application/json")
        if prefer:
            req.add_header("Prefer", prefer)
        data = json.dumps(body).encode() if body is not None else None
        # certifi because this Python ships without a usable CA bundle.
        ctx = ssl.create_default_context(cafile=certifi.where())
        with urllib.request.urlopen(req, data, timeout=30, context=ctx) as r:
            raw = r.read().decode()
        return json.loads(raw) if raw.strip() else None

    def get(self, path):
        return self._call(path)

    def patch(self, path, body):
        return self._call(path, "PATCH", body, prefer="return=minimal")

    def insert(self, table, body):
        return self._call(table, "POST", body, prefer="return=minimal")

    def rpc(self, fn, args=None):
        return self._call(f"rpc/{fn}", "POST", args or {}, prefer="return=representation")


def in_business_hours():
    """08:00-17:00 Pacific, Mon-Fri. A cold email timestamped 03:40 reads as
    machinery no matter how well it is written."""
    try:
        from zoneinfo import ZoneInfo
        now = dt.datetime.now(ZoneInfo("America/Los_Angeles"))
    except Exception:
        now = dt.datetime.now()
    return now.weekday() < 5 and 8 <= now.hour < 17, now


def build_message(p, to_override=None):
    """The body is what Ismail approved, verbatim. This adds only the footer,
    which is a legal requirement rather than copy."""
    frm = os.environ.get("ZOHO_FROM", "ismail@sanakuai.com")
    to = to_override or p["contact_email"]

    footer = "\n".join([
        "", "--",
        FROM_NAME,
        f"Sanaku · {frm}",
        MAILING_ADDRESS,
        "",
        "Reply STOP or say the word and I will not write again.",
    ])

    m = EmailMessage()
    m["From"] = f"{FROM_NAME} <{frm}>"
    m["To"] = to
    m["Subject"] = p["draft_subject"]
    m["Message-ID"] = email.utils.make_msgid(domain="sanakuai.com")
    m["Date"] = email.utils.formatdate(localtime=True)
    # CAN-SPAM wants a working opt-out; a machine-readable one also keeps the
    # domain's reputation intact, because it gives Gmail an alternative to the
    # spam button.
    m["List-Unsubscribe"] = f"<mailto:{frm}?subject=unsubscribe>"
    m.set_content(str(p["draft_body"]).strip() + "\n" + footer)
    return m


def append_to_sent(msg):
    """File a copy in Sent. SMTP submission does not do this - which is exactly
    why sent mail was invisible in the mailbox. Never fatal: the message has
    already been delivered by the time this runs, so a failure here is a
    bookkeeping problem, not a send problem."""
    try:
        ctx = ssl.create_default_context(cafile=certifi.where())
        M = imaplib.IMAP4_SSL("imappro.zoho.com", 993, ssl_context=ctx)
        M.login(os.environ["ZOHO_SMTP_USER"], os.environ["ZOHO_SMTP_PASS"])
        M.append("Sent", "\\Seen",
                 imaplib.Time2Internaldate(dt.datetime.now().timestamp()),
                 msg.as_bytes())
        M.logout()
        return True
    except Exception as e:
        print(f"      (could not file a copy in Sent: {type(e).__name__}: {e})")
        return False


def smtp_send(msg):
    ctx = ssl.create_default_context(cafile=certifi.where())
    s = smtplib.SMTP(os.environ["ZOHO_SMTP_HOST"],
                     int(os.environ["ZOHO_SMTP_PORT"]), timeout=45)
    try:
        s.starttls(context=ctx)
        s.login(os.environ["ZOHO_SMTP_USER"], os.environ["ZOHO_SMTP_PASS"])
        s.send_message(msg)
    finally:
        try:
            s.quit()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=1,
                    help="how many to send this run (default 1, matching the drip)")
    ap.add_argument("--dry-run", action="store_true", help="show, send nothing, claim nothing")
    ap.add_argument("--test-to", metavar="ADDR",
                    help="run the real send path but redirect to this address "
                         "('me' = your own). Touches no prospect rows.")
    ap.add_argument("--force", action="store_true", help="ignore the business-hours window")
    ap.add_argument("--pace", type=int, default=0, metavar="SECONDS",
                    help="wait this long between sends. Fifteen messages leaving a "
                         "new domain inside one minute is the shape of a mailing, not "
                         "a person - pace them when sending more than a couple.")
    args = ap.parse_args()

    load_env()

    # One sender at a time. Two concurrent runs would each claim slots and the
    # drip would arrive as a burst.
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[send] another run is in progress - stopping")
        return 0

    supa = Supa()

    test_to = args.test_to
    if test_to == "me":
        test_to = os.environ.get("ZOHO_FROM", "ismail@sanakuai.com")

    # ---- brake 1: the global switch ---------------------------------------
    enabled = supa.rpc("sanaku_send_enabled")
    if isinstance(enabled, list):
        enabled = enabled[0] if enabled else False
    if not enabled and not (args.dry_run or test_to):
        print("[send] send_enabled is off in sanaku_settings - nothing will send")
        return 0

    # ---- brake 4: business hours ------------------------------------------
    ok_hours, now = in_business_hours()
    if not ok_hours and not (args.force or args.dry_run or test_to):
        print(f"[send] outside 08:00-17:00 PT Mon-Fri ({now:%a %H:%M}) - holding")
        return 0

    rows = supa.get(SELECT + f"&limit={max(1, args.limit)}")
    if not rows:
        print("[send] nothing approved is waiting")
        return 0

    print(f"[send] {len(rows)} approved draft(s) ready"
          f"{' [DRY RUN]' if args.dry_run else ''}"
          f"{f' [TEST -> {test_to}]' if test_to else ''}")

    sent = 0
    for idx, p in enumerate(rows):
        # Pace BEFORE each send after the first, so the gap is between messages
        # rather than trailing pointlessly after the last one.
        if idx and args.pace and not args.dry_run:
            print(f"     (pausing {args.pace}s)")
            time.sleep(args.pace)

        who = p.get("contact_name") or p.get("company_name") or "?"
        dest = test_to or p["contact_email"]
        print(f"  -> {who} <{dest}>")
        print(f"     subject: {p['draft_subject']}")

        if args.dry_run:
            body = str(p["draft_body"]).strip()
            for line in body.splitlines()[:6]:
                print(f"     | {line}")
            if len(body.splitlines()) > 6:
                print(f"     | ... ({len(body.splitlines()) - 6} more lines)")
            continue

        # ---- brake 2: claim a slot, atomically -----------------------------
        # Not claimed on the test path: a test must not consume the day's real
        # allowance, and it writes nothing to the prospect either way.
        if not test_to:
            claimed = supa.rpc("sanaku_claim_send_slot")
            if isinstance(claimed, list):
                claimed = claimed[0] if claimed else False
            if claimed is not True:
                print("     daily send cap reached - stopping")
                break

        msg = build_message(p, to_override=test_to)

        try:
            smtp_send(msg)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            print(f"     FAILED: {err}")
            if not test_to:
                # Releases the slot, stamps the prospect so the next run picks
                # somebody else, and parks it after three consecutive failures.
                verdict = supa.rpc("sanaku_record_send_failure",
                                   {"p_prospect": p["id"], "p_error": err[:500]})
                print(f"     recorded: {verdict}")
            continue

        filed = append_to_sent(msg)
        print(f"     SENT{' (copy in Sent)' if filed else ''}")
        sent += 1

        if test_to:
            print("     test send - no prospect rows touched")
            continue

        # ---- record it, in the order that fails safe ------------------------
        # Conversation first, then the prospect. If the second write fails the
        # send is still on record; the reverse would lose it entirely.
        supa.insert("sanaku_conversations", {
            "prospect_id": p["id"],
            "direction": "outbound",
            "channel": "email",
            "subject": p["draft_subject"],
            "body": msg.get_content(),
            "sequence_step": p.get("draft_step") or 1,
            "sent_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
        supa.patch(f"sanaku_prospects?id=eq.{p['id']}", {
            "status": "contacted",
            "last_contacted": dt.datetime.now(dt.timezone.utc).isoformat(),
            "last_activity_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            # Clear the draft so the record cannot be re-approved and re-sent.
            "draft_subject": None, "draft_body": None, "draft_step": None,
            "draft_angle": None, "draft_generated_at": None,
            "send_failures": 0, "send_failed_at": None, "send_last_error": None,
        })
        print("     logged and marked contacted")

    print(f"[send] done, {sent} sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
