# SANAKU — build 1 (Phases 0–3 + Pipeline dashboard)

Finds local businesses that are visibly losing inbound leads, proves the leak
in dollars, opens a conversation, and books the demo. Phases 4–5b (white-label
deployer, billing, clients page v2) ship after client #1 — the tables already
exist for all of it.

```
sanaku/
├── site/index.html              Public landing page + workflow catalog
│                                (deploy: bash scripts/deploy-site.sh — static, no build)
├── supabase/schema.sql          Phase 0 — run this first
├── n8n/workflows/
│   ├── w1-prospect-scraper.json     Phase 1 — scrape, score, tier, digest
│   ├── w2-outreach-sequencer.json   Phase 2 — approval-gated email sequencer
│   ├── w2b-reply-handler.json       Phase 2 — classify replies, honor opt-outs
│   └── w3-demo-booking.json         Phase 3 — slots API, booking, reminders, no-shows
├── booking/index.html           Phase 3 — Netlify booking page
└── dashboard/                   Phase 5 p.1 — React+Vite command center
```

Validate workflow JSON anytime: `node scripts/validate-workflows.mjs` (repo root).

---

## Day-to-day operations — one script

Install once (works on macOS or inside a Docker container; `sh`, `bash`, or `zsh`):

```bash
curl -fsSL https://raw.githubusercontent.com/ismailwright-rgb/ismailwright-rgb/claude/n8n-prospect-tiering-hgkjb0/sanaku/scripts/sanaku.sh -o ~/sanaku.sh
sh ~/sanaku.sh status
```

The first run asks for your keys **once** and stores them in `~/.sanaku.env`
(chmod 600). After that, no command ever needs a secret pasted into it again.

| Command | What it does |
|---|---|
| `sh ~/sanaku.sh status` | Read-only health check: n8n + Supabase reachable, prospect counts by tier, how many are contactable, recent errors |
| `sh ~/sanaku.sh scrape` | Installs/updates W1 on n8n and runs it now (`MAX_NEW=50 sh ~/sanaku.sh scrape` to raise the cap) |
| `sh ~/sanaku.sh dashboard` | Deploys the internal command center to Netlify |
| `sh ~/sanaku.sh site` | Deploys the public landing page to Netlify |
| `sh ~/sanaku.sh config` | Re-enter stored keys (after rotating a key, say) |

Prompts show what you paste, on purpose — masked prompts silently swallow
pastes in Docker Desktop and other embedded terminals. Every value is
shape-checked as you enter it, so a truncated or mangled paste is caught
immediately instead of surfacing later as a confusing 401.

**Skip the prompts entirely.** Either pass values in the environment:

```bash
N8N_URL=http://... N8N_KEY=eyJ... sh ~/sanaku.sh config    # only asks for the rest
```

…or write the config file directly in one paste (works in any terminal):

```bash
cat > ~/.sanaku.env <<'EOF'
N8N_URL='http://YOUR-N8N-HOST:5678'
N8N_KEY='eyJ...'
SUPABASE_URL='https://YOUR-REF.supabase.co'
SUPABASE_SERVICE_KEY='eyJ...'
SUPABASE_ANON_KEY='eyJ...'
SERPAPI_KEY='...'
OWNER_EMAIL='you@example.com'
EOF
chmod 600 ~/.sanaku.env
```

**Running in Docker?** Two gotchas:
- Mount a volume so the config and the Netlify login survive container restarts:
  `docker run -it -v sanaku-home:/root <image> sh`
- `dashboard` and `site` need Node in the image (the script says so plainly if
  it's missing). `status` and `scrape` need only curl + python3 — run those
  anywhere.

---

## Setup

### 0. Supabase (5 min)
1. SQL editor → run all of `supabase/schema.sql` (idempotent).
2. Authentication → Users → **Add user** (your email + password). Then
   Authentication → Providers → Email → **disable signups**.
3. Grab from Project Settings → API: project URL, `anon` key, `service_role` key.

### 1. n8n env vars
```
SUPABASE_URL=https://<ref>.supabase.co
SANAKU_OWNER_EMAIL=sanakuuai@gmail.com
SANAKU_MAILING_ADDRESS=Your Name, 123 Street, Azusa CA 91702   # CAN-SPAM footer
SANAKU_BOOKING_URL=https://<your-booking-site>.netlify.app
GOOGLE_PLACES_API_KEY=            # optional; blank = Places skipped gracefully
OPENROUTER_MODEL=                 # optional; defaults to a free Llama 3.3 model
MY_CELL_NUMBER=+1626XXXXXXX       # for the demo-booked SMS
RC_SMS_FROM=+1XXXXXXXXXX          # your RingCentral number
```
On macOS/launchd, add them as `EnvironmentVariables` in the n8n plist (or an
`.env` the launch script sources), then restart n8n.

### 2. n8n credentials (names must match exactly)
| Name | Type | Config |
|---|---|---|
| `Supabase Service Role (Custom Auth)` | Custom Auth | JSON: `{"headers":{"apikey":"<service_role>","Authorization":"Bearer <service_role>"}}` — BOTH headers are required; apikey alone is treated as anonymous and RLS silently blanks reads / rejects writes (`scripts/setup-sanaku.sh` creates this and rewires the workflow automatically) |
| `Apollo API Key (Header Auth)` | Header Auth | header `x-api-key` = Apollo key |
| `OpenRouter (Header Auth)` | Header Auth | header `Authorization` = `Bearer <key>` |
| `RingCentral (Header Auth)` | Header Auth | header `Authorization` = `Bearer <access token>` * |
| `Gmail Account` | Gmail OAuth2 | Google Cloud OAuth client, Gmail API on |
| `Google Calendar account` | Google Calendar OAuth2 | same OAuth client, Calendar API on |

\* RingCentral access tokens expire (~1h). For v1 the SMS node is
non-blocking (`continueRegularOutput`) and the same alert also goes to email,
so a stale token never breaks a booking. Cheapest durable fix later: a tiny
n8n workflow that refreshes a JWT-grant token hourly and stores it — or skip
RC and use a carrier email-to-SMS gateway address as `MY_CELL` alert.

### 3. Import the workflows
Import the four files from `n8n/workflows/`, fix any credential warnings,
**activate W2b and W3** (they're triggers/webhooks), keep W1 and W2 active on
their schedules. Timezone on all four is America/Los_Angeles.

### 4. Booking page (Netlify)
1. Edit `booking/index.html` → set `N8N_BASE` to `https://<your-n8n-host>/webhook`.
2. Netlify → deploy the `booking/` folder (drag-and-drop is fine).
3. Your n8n must be reachable from the internet for the page and for Gmail/GCal
   OAuth callbacks — a Cloudflare Tunnel to the Mac is the free way.

### 5. Dashboard (Netlify, React + Vite)
```bash
cd sanaku/dashboard
cp .env.example .env        # fill VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm install && npm run dev  # local
```
Deploy: new Netlify site from this folder, build command `npm run build`,
publish dir `dist`, and set the two `VITE_*` env vars in Netlify → they are
baked in at build time. `netlify.toml` handles the SPA redirect.

---

## What to test, per phase, and what "correct" looks like

### Phase 0 — schema
- Re-run `schema.sql` → no errors (idempotent).
- `select * from v_top_prospects;` → runs, returns 0 rows (empty is correct).
- In an incognito window, `curl https://<ref>.supabase.co/rest/v1/sanaku_prospects?apikey=<anon>` →
  `[]` or 401-ish, **never data** (RLS blocks anon).

### Phase 1 — W1 scraper (the "run it on 20" milestone)
1. In `Run Config`, temporarily set `maxNewPerRun: 20`.
2. Hit **Execute workflow** (manual trigger).
3. Correct result:
   - `sanaku_prospects` has ≤20 rows, each with `domain`, `tier`, `intent_score`,
     a `signals.reason` one-liner, and `status='new'`.
   - No agencies/vendors in the list; nobody with <2 employees; no duplicates.
   - Tier 1 rows have `ai_maturity_score=0` and `intent_score>=65` — spot-check
     2–3 sites by hand: they really should have no chat widget/booking tool.
   - Digest email arrived with the top-10 table.
   - `sanaku_errors` holds only dead-site/robots rows, not run-killers.
4. Ask the gut-check question: *"would I actually call these people?"* If not,
   tune the weights in `Detect & Score` before building anything else.

### Phase 2 — W2/W2b outreach (email only)
1. Insert a fake prospect with YOUR email:
   ```sql
   insert into sanaku_prospects (company_name, vertical, domain, contact_name,
     contact_email, tier, ai_maturity_score, intent_score, status)
   values ('Test Plumbing Co', 'home_services', 'test-plumbing-co.example',
     'Ismail Test', 'you+test@gmail.com', 1, 0, 80, 'new');
   ```
2. Dashboard → the row shows as `new` → click **Approve** → status becomes `queued`.
3. Run W2 manually. Correct result: one email in your inbox (under 400 chars,
   exactly one question, opt-out footer), a `sanaku_conversations` row with
   `sequence_step=1`, prospect `status='contacted'`, `last_contacted` set.
4. Reply "sounds interesting" from that address → within a minute W2b logs an
   inbound row (`sentiment='positive'`), status flips to `replied`, you get an
   alert email.
5. Reply "no thanks" from a second test prospect → `do_not_contact=true`,
   `status='dnc'`, and W2 never touches it again (verify it's absent from the
   next run's plan).
6. Nothing sends without the Approve click — run W2 with only `new` rows
   present and confirm zero sends.

### Phase 3 — W3 booking
1. `curl https://<n8n>/webhook/sanaku-slots` → `{"slots":[...]}`, weekday
   10:00–16:00 PT only, nothing within 24h, nothing overlapping your calendar.
2. Book through the Netlify page with volume=40, value=2000. Correct result:
   - GCal event on your calendar + invite to the test email, description reads
     `ESTIMATED MONTHLY LOSS: $20,000` (40 × 25% × $2,000).
   - `sanaku_demos` row with `est_monthly_loss=20000`.
   - Prospect status `demo_booked` (when the email matches a prospect).
   - SMS + email alert to you.
3. Reminders: create a demo ~23.5h out → next hourly run sends the 24h email.
4. No-show: set a demo's `scheduled_for` to yesterday, `outcome` null → 8am
   sweep emails a re-book link and sets `outcome='no_show'`.

### Phase 5 p.1 — Pipeline dashboard
- Login works; wrong password fails; logged-out state shows no data.
- Metrics row matches SQL counts; filters/sort work; Signals expander shows
  the evidence; Approve (row + bulk) flips `new → queued` only.
- Thread drawer shows the full conversation with sentiment tags.

---

## Legal guardrails — where each one lives in the build
| Guardrail | Implementation |
|---|---|
| No cold SMS (TCPA) | W2 has **no SMS path at all** in v1. SMS only enters later for repliers/opt-ins, from a registered 10DLC number, 8am–9pm local. |
| Approval gate | W2 reads only `status='queued'`, set exclusively by the dashboard Approve button. |
| STOP/opt-out honored instantly | W2b `opt_out` → `do_not_contact=true` + `status='dnc'`; every W2 query filters `do_not_contact=is.false`. No re-entry. |
| CAN-SPAM | Physical mailing address + working opt-out line in every email footer (`SANAKU_MAILING_ADDRESS`). |
| 45-day re-contact lockout | Enforced in W2 `Plan Touches`. |
| Scraping | Official APIs only (Apollo, Google Places), robots.txt honored, real `SanakuBot` UA, 2s politeness delay, no LinkedIn/Meta scraping. |
| CCPA | Business contact data only; deletion = `delete from sanaku_prospects where …` (conversations cascade). |
| Fee structures | Law firms: flat or retainer+per-lead only. Medical: flat only. Home services: anything. Encode it in `pricing_model` when you close. |

## Free-tier ceilings to watch
- **Apollo**: search is cheap; `people/match` (email reveal) burns the ~50–100/mo
  free credits. W1 caps at 12 reveals/run, Tier 1 only. You WILL hit the
  ceiling by week 2–3 — that's fine, prioritize by intent score; first client
  pays for the $49 plan.
- **Google Places**: needs a billing-enabled GCP project but the monthly $200
  credit covers this volume ~free. Leave the key unset until then — W1 degrades
  gracefully (no reviews signal, slightly weaker scoring).
- **OpenRouter**: defaults to a `:free` model. Free models rate-limit; W2
  falls back to the hand-written question bank on any failure, so sends never block.
- **RingCentral**: SMS from your existing plan; the alert also goes to email
  so RC being down never loses a booking.
- **Netlify/Supabase**: free tiers are far above this usage.
