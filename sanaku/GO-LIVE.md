# Sanaku — go live

Four steps. Do them in order. ~15 minutes total.

---

## ☐ 1. Update the database (5 min)

1. Open your Supabase project → **SQL Editor** → **New query**
2. Open [`supabase/RUN-THIS-NOW.sql`](supabase/RUN-THIS-NOW.sql) on GitHub → click the **copy** icon
3. Paste into the SQL editor → **Run**
4. At the bottom of the output you'll see two check queries. You want:
   - `table_without_rls` → **zero rows**
   - `i_am_staff` → **true**

> **Why this one matters most:** until you run it, your prospect list is readable
> by anyone with a login, and the old prospect-tiering tables are readable with
> no login at all.

---

## ☐ 2. Fix the scraper key (2 min)

The scraper is storing a placeholder instead of your SerpAPI key, which is why it
returns nothing.

```bash
sh ~/sanaku.sh set SERPAPI_KEY 06c13cc2bdadc7104309783caf129bdd24b37f7af4fa0b6507e663d59787211a
```

Then:

```bash
sh ~/sanaku.sh scrape
```

You should see a ranked list of businesses print at the end.

---

## ☐ 3. Push the new dashboard + site (5 min)

```bash
sh ~/sanaku.sh dashboard
```
When Netlify asks: **"Link to an existing project"** → `sanaku-command-center`

```bash
sh ~/sanaku.sh site
```
When Netlify asks: **"Create & configure a new project"** → name it `sanaku`

---

## ☐ 4. Check it worked (3 min)

Open **sanaku-command-center.netlify.app** and confirm:

- Prospects are listed, with **clickable** phone numbers and websites
- A **Best fit** column says which workflow to sell each one
- Clicking **Open** on a row shows the call script, a place to take notes, log a
  call, and set a follow-up
- The **Earnings** tab loads (empty until you have a client — that's correct)

Then open your public site URL and check the leak calculator moves when you drag
the sliders.

---

# You're live. Now go sell.

The system's job is done for now; the next move is yours:

1. Open the dashboard, filter to **Tier 1** + **Home services**
2. Pick the top 5 by intent score
3. Click **Open** on the first one, hit **Copy call script**, and dial the number
4. Log what happened right in the drawer, set a follow-up date, move to the next

Home services first: no ethics rules to navigate, fastest decisions, and the
lowest-priced yes.

---

## When someone says yes

1. **Clients → Onboard client** — pricing rules for their vertical are enforced
   for you, defaults pre-filled ($500 setup / $750 monthly / $50 per lead)
2. Send them [`docs/pilot-agreement.md`](docs/pilot-agreement.md) with the
   brackets filled in
3. Deploying their missed-call text-back needs a Twilio account and a number for
   them (~$1/mo, plus A2P 10DLC registration — **start that the day they sign,
   approval takes a few days**). Then import
   `n8n/workflows/t1-missed-call-textback.json` and `t1-reply-handler.json`,
   point their phone system's missed-call event at the webhook, and fill in their
   row: `inbound_number`, `sending_number`, `business_hours`, `escalation_phone`.

---

## Everyday commands

```bash
sh ~/sanaku.sh status     # is everything up? how many prospects?
sh ~/sanaku.sh scrape     # find more prospects now
sh ~/sanaku.sh doctor     # something's broken — start here
sh ~/sanaku.sh logs       # what did the last scraper run actually do?
sh ~/sanaku.sh dashboard  # ship dashboard changes
sh ~/sanaku.sh site       # ship landing page changes
```

## Still on the list (not blocking you)

- Client portal — clients log in to see their own reports and file requests
- Wiring the email outreach sequencer (built, not connected)
- A real domain + business email (Gmail costs you credibility on cold outreach)
- Rotate the API keys that got pasted around during setup
