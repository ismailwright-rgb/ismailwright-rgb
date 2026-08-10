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
APOLLO_KEY=''            # optional; leave empty unless Apollo is on a PAID plan
OWNER_EMAIL='you@example.com'
EOF
chmod 600 ~/.sanaku.env
```

**Running in Docker?** Two gotchas:
- Mount a volume so the config and the Netlify login survive container restarts:
  `docker run -it -v sanaku-home:/root <image> sh`
- `dashboard` and `site` need Node in the image (the script says so plainly if
  it's missing). `status` and `scrape` need only curl + python3 — run those
  anywhere. `apollo` also needs Node — it runs W1's real Run Config code to
  build its test query rather than keeping a second hand-typed copy that can
  go stale, so wherever n8n itself runs, this will too.

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
SANAKU_OWNER_EMAIL=you@gmail.com
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

## M1 — the LinkedIn content studio (Marketing tab)

A content studio for **Ismail's personal LinkedIn**, not a company page. One
brand brain feeds every format, so voice and positioning stay identical across
posts, carousels, polls, articles, newsletter editions and Featured assets.

**It generates and stages. It never publishes.** LinkedIn's API will not
reliably post polls, carousels or articles to a personal profile, so the last
step is deliberately a human with a clipboard — and the export is built to make
that one copy and one upload.

### The pieces
| Piece | Where |
|---|---|
| Generator | `n8n/workflows/m1-content-studio.json` (built by `n8n/build/m1-content-studio.mjs`) |
| Brand brain | `brand_brain` rows with `channel = 'linkedin'` — seeded by `supabase/seed-brand-brain-linkedin.sql` |
| Queue | `content_queue`, extended by `supabase/migration-022-marketing-studio.sql` |
| Approval + export | Marketing tab — `dashboard/src/Marketing.jsx`, `dashboard/src/postpack.js` |
| Illustrations | Alexya wrapper, `POST /generate-illustration` → Supabase Storage bucket `sanaku-marketing` |

### The positioning lives in Supabase, not in the workflow
Edit `brand_brain` rows, never the prompt. The seed carries positioning
("AI that never leaves your building"), voice, the five audiences in priority
order, the five bottlenecks, format briefs, and two hard guardrails:
**sell the what and the why, never the how**, and **no invented proof** —
there is no case study yet, so the generator must not manufacture one.

`channel` scopes a row: `NULL` = applies everywhere, `'linkedin'` = this studio,
`'email'` = outbound only. That is what lets the outbound rule "don't say AI"
coexist with a LinkedIn voice whose whole subject is privacy-safe AI.

These rows deliberately have **no embedding**. `match_brand_brain()` is a top-k
similarity search — right for picking snippets for one lead, wrong here, where
every item needs the whole brief. Leaving them unembedded also keeps LinkedIn
voice rules out of cold-email retrieval.

### How it works — two stages, like the Sydney pipeline
V1 was a single LLM call: brand brain in, finished post out. Correct, on-message
and forgettable, because nothing had a point of view before it started writing.

1. **Angle engine.** Reads the brand brain, `content_memory`, the last 14 items
   and real headlines pulled from Google News RSS, then commits to **three
   genuinely different theses** — different audience, bottleneck or argument.
2. **The writer.** Takes ONE thesis and writes to it, in the right format shape.

Deciding what to argue and writing it well are different jobs. Asking one call
to do both is why v1 drifted to whatever the model found easiest.

**It remembers.** After each run it extracts spent arguments, used analogies and
used openers into `content_memory`, and the angle engine is shown them and told
not to repeat. That is what stops draft 40 re-running draft 3.

### Cadence
**Three drafts every morning, seven days a week.** They are alternatives to
choose between — approve the one you want, delete the rest. They share a
`draft_group` so the tab can show them as a set.

### Output format is delimited blocks, not JSON
Free-tier models cannot reliably escape newlines and quotes inside a JSON string
when the value is multi-paragraph prose — two of every three drafts died on
`Expected ',' or '}' after property value` around character 1200. Blocks
(`[POST] … [/POST]`, `[SLIDE] …`) need no escaping, so the writer just writes.
Both stages use them; the angle engine switched too after a reasoning-model
fallback emitted its working instead of JSON.

### The model: a rotating pool, not a primary
The free tier rate-limits constantly, so "the model" is not something you can
depend on — only "a model answering right now" is. Probed live 2026-08-10, and
the result made the point: the configured primary was 429ing at that moment and
one of its two fallbacks did not respond at all.

So OpenRouter's `models` array handles fallback *within* a request (max 3
entries), and the **starting point rotates per call and per day** — the angle
engine, the writer and the memory pass each begin at a different point, so one
throttled provider cannot take out the whole morning.

The angle engine gets a **narrower pool** on purpose. The nemotron models answer
reliably but emit reasoning instead of the requested format. Harmless for the
writer, whose parser ignores loose prose — fatal for structured output, where a
run came back *"We need to output exactly three angles…"* and no `[ANGLE]` block
at all. Only models that returned exactly-formatted output when probed are
eligible there.

| Pool | Used by | Members |
|---|---|---|
| structured | angle engine | `gemma-4-26b-a4b:free`, `gemma-4-31b:free` |
| prose | writer, memory | both gemmas + `nemotron-3-ultra-550b:free`, `nemotron-3-nano-30b:free` |

Override without a rebuild:

```
OPENROUTER_MODEL    pin one model, e.g. anthropic/claude-sonnet-5
OPENROUTER_MODELS   replace the pool entirely, comma-separated
```
A pinned model still carries the free pool behind it, so a paid model being
briefly unavailable does not stop the studio.

~$2/month at this cadence, and a large step up in writing quality. **The paid
OpenRouter balance is currently exhausted ($50 of $50), which is why the free
endpoint is the default.**

### Installing it
```
sh sanaku/scripts/install-m1.sh
```
Discovers/creates the credentials, pins the Supabase URL, creates or updates
the workflow, and activates it. Safe to re-run. Two things it handles that are
easy to get wrong by hand:

- **The Supabase URL must be hardcoded, not `$env.SUPABASE_URL`.** The droplet
  hosts both Sanaku and TCR and has one such variable — it points at TCR. Left
  as an expression, every Sanaku query hits the wrong project and returns
  `401 Invalid API key`, which reads like a broken credential. `setup-sanaku.sh`
  hardcodes it for the T/W workflows for exactly this reason.
- **Credentials are created once and reused.** Three credentials on the instance
  share the name "Supabase Service Role (Custom Auth)" and at least one holds a
  stale key, so inheriting "the one the newest workflow uses" picks a dead one.
  Creating a fresh pair on every run is how that mess started, so M1 tags its
  own with a `- M1` suffix and reuses them. After rotating a key:
  `ROTATE_CREDS=1 sh sanaku/scripts/install-m1.sh`

### Artwork: the droplet cannot reach Alexya
Alexya is bound to `127.0.0.1:8000` on the Mac and M1 runs on the droplet, so
the image step always fails there — **on purpose**. It is non-fatal: the item
queues with its text complete and `image_prompt` set.

`scripts/illustrate-queue.py` closes the gap from the other side. It runs on the
Mac under `com.sanaku.illustrator` every 20 minutes, finds queued items that
wanted a picture and did not get one, draws them locally and writes the public
URL back. If the Mac is asleep or Alexya is down it exits quietly and the work
waits.

That decoupling beats a tunnel: ngrok would work until the Mac slept or the free
URL rotated, and then the failure is a stale `ALEXYA_URL` silently 502ing every
morning. Run it by hand any time with:
```
python3 sanaku/scripts/illustrate-queue.py --limit 5 [--dry-run]
```

### Illustration: a cycling palette, not one look
Eight named styles in `sydney_server.py` — `flat_vector, clay, mural, pastel,
risograph, isometric, papercut, linocut` — listed live at `GET /styles`. The
worker picks one per item, keyed off the row id so a retry redraws the *same*
look and the morning's three drafts almost always differ from each other. A
carousel keeps one style across all its slides.

Every draft gets a **cover image**, approved or not: ~31 credits each, about
2,790/month at three drafts a day against a balance near 27,000 — roughly ten
months. Choosing between three blocks of text with the artwork arriving only
after you have decided is backwards. Full per-slide carousel art (5-8 images,
~217 credits) is what waits for approval.

Alexya exposes no model or checkpoint parameter, so prompt wording is the only
lever there is; verified live across four styles, no reference image needed.

**Lettering is suppressed by default.** The same scene gave a garbled
"IRS MONUEMENT" in linocut and a clean "Client Data Transfer" in pastel — a
correct label is a small bonus, a misspelled one is a hard fail in front of
lawyers and accountants. Pass `allow_text: true` when a label earns its place.

Two scene-wording quirks, found by testing rather than assumed:
- "empty" is ignored for rooms — say "no people, nobody in frame".
- "inside the building" renders as *on top of* it — ask for a "cutaway view".

### Posting is copy + upload
Behind the approval gate every item offers:
- **Copy text** — the exact wording, markdown stripped, ready to paste. (A poll
  is labelled QUESTION / OPTIONS because LinkedIn takes those in separate
  fields and no single blob can be pasted in one go.)
- **Download post pack** — one zip that unzips to one folder:
  `caption.txt`, `slides.txt` for carousels, and images named `slide-01`,
  `slide-02`, … so order survives upload. Named `sanaku_<date>_<theme>.zip`.
- **Download all approved** — one zip of per-item folders; a week in one go.

Images keep their real `.jpg` extension rather than being renamed `.png`, and
an image that cannot be fetched is recorded in `MISSING-IMAGES.txt` inside the
pack rather than silently dropped.

### Not built yet
- **Video** — Phase 2. `content_kind` has the value; nothing generates it. The
  Sydney path is the local Alexya reel endpoint.
- **Auto-posting** — optional later, and only for the one format LinkedIn
  allows: a basic text/image share via OAuth, as **person**, not organization.

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
- **Apollo**: there is no free tier *for the API*. A free-plan key returns
  `API_INACCESSIBLE` on every call — verified against the live account, not
  read off a pricing page. The in-app free credits are usable in Apollo's own
  UI only. So W1 ships with Apollo off and SerpAPI as the source; the trade is
  that a SerpAPI-only prospect has a business but no named decision maker.
  On a paid plan: `sh ~/sanaku.sh set APOLLO_KEY <key>` and re-import — the
  installer creates the credential and turns `useApollo` on. Search is cheap;
  `people/match` (email reveal) is what costs credits, so W1 caps email
  reveals at 25/run by default (`APOLLO_REVEALS=`), best-ranked contact first.
  Direct-dial/mobile reveal is a SEPARATE, much tighter budget — confirmed
  live at **8 credits per reveal**, not 1. It's async: Apollo can take
  several minutes, so W1 kicks it off on one run and resolves it on a later
  one (`phone_reveal_request_id` on `sanaku_prospects`). Defaults to 6/run
  (`APOLLO_PHONE_REVEALS=`), and only for prospects already selected for
  email reveal — never spend a phone credit on someone we haven't already
  confirmed is the right person.
- **Google Places**: needs a billing-enabled GCP project but the monthly $200
  credit covers this volume ~free. Leave the key unset until then — W1 degrades
  gracefully (no reviews signal, slightly weaker scoring).
- **OpenRouter**: defaults to a `:free` model. Free models rate-limit; W2
  falls back to the hand-written question bank on any failure, so sends never block.
- **RingCentral**: SMS from your existing plan; the alert also goes to email
  so RC being down never loses a booking.
- **Netlify/Supabase**: free tiers are far above this usage.
