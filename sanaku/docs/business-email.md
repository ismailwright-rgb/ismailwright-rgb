# Moving Sanaku onto its own email

`sanakuuai@gmail.com` — not your personal address.

There are five places your address is wired in. Two of them are one command
each; three need a few clicks. Do them in this order.

---

## 1. Alerts and digests → the Sanaku inbox

Every workflow that notifies you (new Tier 1 prospects, a prospect replying, a
demo booked, a missed call handled) sends to one address, stored once.

```sh
sh ~/sanaku.sh set OWNER_EMAIL sanakuuai@gmail.com
sh ~/sanaku.sh scrape
```

The second command matters. The address is baked into the workflow when it is
imported into n8n, so changing the stored value alone changes nothing until
the workflow is re-imported — which `scrape` does (it replaces the existing
workflow, it does not create a duplicate).

Verify with `sh ~/sanaku.sh doctor` — `OWNER_EMAIL` should read the new address.

---

## 2. Outbound mail → sent *from* Sanaku

Cold outreach, follow-ups and demo confirmations go out through a Gmail
credential in n8n. Right now that credential is whichever Google account you
authorised during setup. If it is your personal one, every prospect sees your
personal address.

1. Sign in to Gmail as **sanakuuai@gmail.com** in your browser
2. n8n → **Credentials** → **Add credential** → **Gmail OAuth2**
3. Name it exactly `Sanaku Gmail` and complete the Google consent screen —
   confirm the account shown is the Sanaku one, not your personal one
4. Open each workflow with a Gmail node (W2 Outreach, W2b Reply Handler,
   W3 Demo Booking) → click the node → switch **Credential to connect with**
   to `Sanaku Gmail` → **Save**

W2b watches the inbox for replies, so this also decides *which inbox* replies
are read from. Point it at the personal account and prospect replies will be
classified out of your personal mail.

---

## 3. Command center login

Your dashboard login is a Supabase account, separate from anything above.

1. Supabase → **Authentication** → **Users** → **Add user**
2. Email `sanakuuai@gmail.com`, set a password, tick **Auto Confirm User**
3. Supabase → **SQL Editor** → **New query** → paste
   [`add-staff.sql`](../supabase/add-staff.sql) → **Run**

This *adds* an operator login; it does not remove the existing one. Sign in as
the Sanaku account, confirm the pipeline loads, and only then remove the
personal account (Authentication → Users → ⋯ → Delete user) if you want to.

Do not use this file to give a client access. Clients get a portal login from
the **Invite** button on the client roster, which scopes them to their own
data. Staff see everything.

---

## 4. Portal invites and password resets

When you invite a client contact, the email currently arrives from
`noreply@mail.app.supabase.io`. For a business charging $500+/month that reads
as a phishing attempt, and Supabase's built-in sender is rate-limited to a
handful of messages an hour.

Supabase → **Project Settings** → **Authentication** → **SMTP Settings** →
**Enable Custom SMTP**:

| Field | Value |
|---|---|
| Host | `smtp.gmail.com` |
| Port | `465` |
| Username | `sanakuuai@gmail.com` |
| Password | a Google **App Password**, not the account password |
| Sender email | `sanakuuai@gmail.com` |
| Sender name | `Sanaku` |

App Password: Google Account → Security → 2-Step Verification (must be on
first) → App passwords. Gmail rejects plain-password SMTP.

Gmail caps sending at roughly 500/day, which is fine for invites and outreach
at this volume. It is not fine for bulk sending, and it is not what you should
be on once you have a domain — see below.

---

## 5. Public-facing addresses

Already set to `sanakuuai@gmail.com`:

- the landing page footer and contact link (`site/index.html`)
- the pilot agreement template (`docs/pilot-agreement.md`)

---

## The thing worth doing next

Every item above still ends in `@gmail.com`. A cold email from a Gmail address
asking a law firm for a $2,000/month retainer gets deleted, and Gmail's own
spam filtering treats gmail.com senders reaching cold inboxes far more harshly
than a domain with SPF, DKIM and DMARC set up.

Buy `sanaku.ai` or `sanaku.co` (~$12–40/year), point Google Workspace at it
(~$7/month), and this becomes `hello@sanaku.ai`. Then redo steps 1–4 with the
new address — the same five places, the same commands. Nothing else changes.

Do it before W2 starts sending cold outreach, not after. Domain reputation is
built from the first message you send, and a burned domain cannot be fixed by
switching addresses later.
