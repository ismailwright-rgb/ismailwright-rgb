# Apace — intraday trading console

A small Dockerised dashboard for a **paper** Alpaca account. It scores a watchlist
for day-trade setups, shows the case for and against each one, and places guarded
bracket orders from a button.

The scoring is deterministic and computed from price and volume. A language model
reads the headlines and writes the reasoning, but it cannot set the score — it can
only nudge it by up to 12 points, or veto a name outright.

```
Browser  ──>  Express (this container)  ──>  Alpaca  (keys never leave the server)
                      │
                      └────────────────────>  OpenRouter (headline reasoning, optional)
```

## Run it

```bash
cp .env.example .env      # then fill in your paper keys
docker compose up --build
open http://localhost:8080
```

Without Docker: `npm install && npm start` (Node 20.6+).

### Look at it before wiring anything up

```bash
npm run mock              # http://localhost:8099
```

Runs the real server against a synthetic market — no keys, no account, no open
market required. The Execute button works end to end; orders are captured in
memory and discarded.

### Tests

```bash
npm test
```

25 offline checks covering the indicator math, the scoring, session resolution,
the order payload, and every risk blocker.

## What it shows

**Per candidate**, ranked by score:

- **Score 0–100** with the full factor breakdown — intraday trend (EMA9/EMA20 and
  VWAP side), opening-range break, relative volume, strength versus SPY, RSI, and
  spread. Each factor shows its weight, a diverging bar, and the sentence that
  produced it, so the number is never a black box.
- **Case for / case against**, written from the technicals and the last 36 hours of
  headlines. Every headline is linked so you can check the model's read.
- **The proposed trade** — entry, stop, target, share count, dollars at risk, and
  the R:R ladder — before you commit to anything.
- **Session context** in the rail: market clock with a countdown to the close,
  equity, buying power, and your day-trade count against the PDT limit.

## Sizing and risk

Position size is derived from risk, not from a fixed dollar amount:

```
stop distance = max(1.5 × ATR(14, 5min), 0.30% of entry, $0.02)
shares        = floor(equity × RISK_PCT_PER_TRADE% / stop distance)
                capped so shares × entry ≤ MAX_NOTIONAL_PER_ORDER
target        = entry + stop distance × TARGET_R_MULTIPLE
```

Orders go out as **bracket** orders (`time_in_force: day`) so the stop and target
are attached at entry rather than left to be placed by hand afterwards. Bracket
orders are whole-share only, which is why sizing is in shares rather than notional.

## The risk guard

Every order re-runs the full check **server-side** immediately before sending. The
browser's payload contributes exactly one thing: which symbol was clicked. Trades
are refused when:

- the score is below `MIN_SCORE_TO_TRADE`
- the model vetoed the name (offering, halt, earnings inside the horizon…)
- the spread is wider than `MAX_SPREAD_BPS`
- the market is closed, or the close is within `MIN_MINUTES_TO_CLOSE`
- the analysis is older than `MAX_ANALYSIS_AGE_SECONDS`
- the symbol is already held, or you are at `MAX_OPEN_POSITIONS`
- equity is under $25k and you have already used 3 day trades in 5 sessions (PDT)
- the order exceeds buying power or the per-order notional cap
- the symbol is not on the configured watchlist

You can verify this holds outside the UI:

```bash
curl -X POST localhost:8080/api/trade -H 'content-type: application/json' \
  -d '{"symbol":"AAPL","confirm":true}'
# → 422 {"error":"Trade blocked by risk guard","blockers":["Score 51 is below the 70 threshold."]}
```

## Safety defaults

- **Paper only.** The server refuses to boot against a non-paper endpoint unless
  `ALLOW_LIVE=true` *and* the trading URL was changed — two deliberate acts.
- **Loopback only.** Compose binds `127.0.0.1:8080`. Anyone who can reach the port
  can place orders, so set `DASHBOARD_USER`/`DASHBOARD_PASSWORD` before exposing it.
- **Keys stay server-side.** The browser never sees them; it only talks to this app.
- **Idempotent orders.** Each carries a `client_order_id`, so a double-click or a
  retry cannot double a position.

## Known limits — read these

- **The IEX feed is thin.** On the free plan, volume reflects IEX only, so relative
  volume and VWAP are approximations. Set `ALPACA_DATA_FEED=sip` with a paid
  subscription for consolidated volume, which makes both meaningfully sharper.
- **Early in the session there is not much to compute.** EMA20 needs 20 five-minute
  bars — about 100 minutes. Before that the trend and RSI factors abstain and say so
  rather than guessing.
- **No backtest.** The factor weights are reasoned, not fitted. Nothing here has
  been shown to be profitable. Treat a high score as a prompt to look closer.
- **The model can be wrong about the news.** It is instructed to cite only the
  headlines it was given, but it has no earnings calendar and cannot see a halt.
  The linked headlines are there so you can check it.
- **Long-only.** No shorts, no options, no adding to a winner.

## API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/state` | Cached analysis, account, positions, trade log |
| `POST` | `/api/analyze` | Force a fresh analysis |
| `POST` | `/api/preview` | Dry-run the guard for one symbol |
| `POST` | `/api/trade` | Guard, then place a bracket order |
| `POST` | `/api/positions/:symbol/close` | Close one position at market |
| `POST` | `/api/flatten` | Close everything |
| `GET` | `/api/health` | Liveness (unauthenticated) |

To drive it from n8n, replace the analysis branch with a Schedule Trigger that
POSTs to `/api/analyze` — the dashboard becomes the single source of truth and n8n
just supplies the cron.
