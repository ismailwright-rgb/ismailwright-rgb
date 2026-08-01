# Sanaku correspondence → the Sanaku account

Business mail about Sanaku lands in `sanakuuai@gmail.com`. Demos booked land on
that account's calendar. Nothing here costs money.

It comes down to **which Google account n8n is connected to**, plus one stored
setting. Three things, in order.

---

## 1. Alerts → the Sanaku inbox

Every workflow that notifies you — a new Tier 1 prospect, a prospect replying,
a demo booked, a missed call handled — sends to one stored address.

```sh
sh ~/sanaku.sh set OWNER_EMAIL sanakuuai@gmail.com
sh ~/sanaku.sh scrape
```

Both lines. The address is substituted into the workflow when it is imported
into n8n, so the first command changes nothing until the workflow is
re-imported — which `scrape` does. It replaces the existing workflow rather
than creating a duplicate.

Confirm with `sh ~/sanaku.sh doctor`.

---

## 2. Mail sent and received → the Sanaku inbox

One Gmail credential in n8n decides both directions:

- **Sent from** — cold outreach (W2), follow-ups, demo confirmations
- **Read from** — W2b watches an inbox and classifies prospect replies

If that credential is your personal account, prospects see your personal
address and their replies get classified out of your personal mail.

1. In your browser, sign in to Gmail as **sanakuuai@gmail.com** first. This is
   the step people skip. n8n's consent screen uses whichever Google account
   the browser is already signed into, and it is easy to click straight past.
2. n8n → **Credentials** → **Add credential** → **Gmail OAuth2**
3. Name it `Sanaku Gmail`
4. Complete the Google consent screen — **read the account shown on the
   consent page and confirm it says sanakuuai@gmail.com** before approving
5. Open each workflow with a Gmail node — **W2 Outreach**, **W2b Reply
   Handler**, **W3 Demo Booking** — click the node, switch **Credential to
   connect with** to `Sanaku Gmail`, **Save**

If you already made a Gmail credential under the personal account, leave it;
just stop pointing nodes at it. Deleting it can break a workflow mid-run.

---

## 3. Booked demos → the Sanaku calendar

W3 writes to `calendars/primary` — the primary calendar of whichever account
holds the Google Calendar credential. There is no calendar ID to configure;
connecting the right account *is* the configuration.

1. Still signed in as sanakuuai@gmail.com
2. n8n → **Credentials** → **Add credential** → **Google Calendar OAuth2**
3. Name it `Sanaku Calendar`, complete consent, confirm the account again
4. Open **W3 Demo Booking** → set that credential on both **Get Busy Times**
   and **Create GCal Event** → **Save**

Both nodes, not one. `Get Busy Times` is what stops the booking page offering
slots you are not free for — if it reads a different calendar from the one
events are written to, the page will happily double-book you.

Events are created with `sendUpdates=all`, so Google emails the invite to the
prospect from the calendar owner. Connect as Sanaku and that invite comes from
Sanaku too.

---

## What you do *not* need

- **A domain.** Everything above works on the free Gmail account. Revisit when
  there is revenue — see below.
- **Custom SMTP in Supabase.** Only affects client *portal* invite emails, and
  you have no portal clients yet.
- **Changing your dashboard login.** The command center login is a Supabase
  account, unrelated to where mail arrives. Yours works. Leave it.
  (If you ever do want a second operator login, `supabase/add-staff.sql` does
  it — but it is not part of this.)

---

## Later, once there is revenue

Cold email from an `@gmail.com` address asking a law firm for a $2,000/month
retainer is a real conversion problem, and Gmail filters gmail.com senders
reaching cold inboxes harder than a domain with SPF, DKIM and DMARC.

That argues for `sanaku.ai` + Google Workspace (~$12–40/yr + ~$7/mo) **before
W2 starts sending cold outreach at volume** — domain reputation is built from
the first message and a burned domain is not fixed by switching addresses.

Until then: warm outreach, replies, and demo bookings on the Gmail account are
completely fine. This is a real constraint to plan around, not a reason to
stall. Gmail sends ~500/day, well past what you need to book the first client.
