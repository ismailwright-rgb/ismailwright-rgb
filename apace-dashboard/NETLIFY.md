# Deploying to Netlify

The dashboard runs on Netlify as one function plus a background function. Docker
still works exactly as before — this is an additional target, not a replacement.

## Read this before you deploy

**A Netlify URL is public.** Anyone who has the link can load whatever it serves.
That is fine for a marketing page and not fine for a button that trades your
account, so two things are enforced in code and cannot be skipped:

1. **Basic auth is mandatory.** The app refuses to start on Netlify unless
   `DASHBOARD_USER` and `DASHBOARD_PASSWORD` are set. This covers the page itself,
   not only the API — everything is served through the function so nothing is
   reachable anonymously.
2. **Order placement is off by default.** `ENABLE_TRADING` defaults to `false`
   whenever `NETLIFY=true`. The dashboard shows live scores, reasoning, positions
   and P&L; `/api/trade` returns 403 and the Execute buttons render disabled.

My recommendation: **leave trading off on Netlify** and keep execution on the
Docker instance you already have running locally. You get the dashboard anywhere,
and the button that spends money stays on a machine only you can reach. If you
want to trade from the hosted copy anyway, set `ENABLE_TRADING=true` — it works,
and the risk guard still applies, but understand that your password is then the
only thing between the internet and your account.

## Deploy

### 1. Push the branch (already done)

Netlify deploys from GitHub. The code is on
`claude/stock-agent-workflow-l36r04`.

### 2. Create the site

In Netlify: **Add new site → Import an existing project → GitHub →**
`ismailwright-rgb/ismailwright-rgb`.

Then set:

| Setting | Value |
|---|---|
| Branch to deploy | `claude/stock-agent-workflow-l36r04` |
| Base directory | `apace-dashboard` |
| Build command | *(leave blank — `netlify.toml` sets it)* |
| Publish directory | *(leave blank — `netlify.toml` sets it)* |

**Base directory is the one people miss.** Without it Netlify looks at the repo
root, finds no `netlify.toml`, and deploys your profile README.

### 3. Set environment variables

**Site configuration → Environment variables.** All of these are required:

```
ALPACA_KEY_ID          PK...            your paper key
ALPACA_SECRET_KEY      ...              your paper secret
DASHBOARD_USER         you              anything
DASHBOARD_PASSWORD     <long random>    generate one, don't invent one
```

Strongly recommended:

```
OPENROUTER_API_KEY     sk-or-...        turns on the written reasoning
TZ                     America/New_York
```

Only if you have read the warning above and still want it:

```
ENABLE_TRADING         true
```

### 4. Enable Blobs

**Site configuration → Blobs → Enable.** This is where the analysis and trade log
live; functions have no disk that survives an invocation. Without it the dashboard
still runs but re-analyses on every load.

### 5. Deploy

Trigger a deploy. When it finishes, open the site URL — the browser will prompt
for the username and password you set.

## How it works

```
Browser ──> /*  ──(force redirect)──>  functions/api          serves page + API
                                            │
              "Refresh analysis" ──────────> functions/analyze-background
                                            │  (up to 5 min: Alpaca + model)
                                            └──> Netlify Blobs ──> polled by /api/state
```

A full analysis makes several Alpaca calls plus a model call, which is well past
a normal function's budget. `/api/analyze` therefore returns `202` immediately,
hands off to the background function, and the page polls `/api/state` until the
timestamp moves. You'll see the Refresh button count seconds while that happens.

## Verify it before trusting it

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://your-site.netlify.app/
# 401 — good. Anything else means auth is not applied.

curl -s -u you:yourpassword https://your-site.netlify.app/api/health
# {"ok":true,"mode":"paper","trading":false}
```

`"mode":"paper"` and `"trading":false` are the two values worth checking on every
deploy.

## Troubleshooting

**Build fails: `DASHBOARD_USER and DASHBOARD_PASSWORD are required`** — working as
intended. Set them, redeploy.

**Deploys your README instead of the dashboard** — Base directory isn't set to
`apace-dashboard`.

**Page loads but every symbol shows "No data"** — no analysis has been stored yet.
Click **Refresh analysis** and wait; the first run on a cold site takes longest.

**Refresh spins then times out** — check **Functions → analyze-background** in the
Netlify logs. Usually an Alpaca 401 (wrong env var) or a model timeout.

**`Blobs` errors in the logs** — Blobs isn't enabled on the site. Step 4.

**Analysis never updates** — background functions must be invoked over HTTP.
Confirm `URL` is present in the function environment; Netlify sets it
automatically, but a custom `URL` variable would shadow it.

## Local check before pushing

```bash
npm test          # includes the serverless entry point
npx netlify dev   # runs functions locally at http://localhost:8888
```

`npm test` covers the properties that matter here: auth enforced on the page and
the API, trading refused, credentials forwarded to the background function.
