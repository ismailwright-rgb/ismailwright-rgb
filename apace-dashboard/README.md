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

**New here? Follow [SETUP.md](SETUP.md)** — a step-by-step walkthrough from
installing Docker to placing a first paper trade, written to assume nothing.

### See it with no keys and no account

```bash
docker compose up demo    # → http://localhost:8099
```

Runs the real server against a synthetic market. The Execute button works end to
end; orders are captured in memory and discarded. Do this first.

### Run it against your paper account

```bash
cp .env.example .env      # then fill in your paper keys
docker compose up --build # → http://localhost:8080
```

Deploying to Netlify instead? See [NETLIFY.md](NETLIFY.md).

Without Docker: `npm install && npm start` (Node 20.6+), or `npm run mock` for the
synthetic market.

### Tests

```bash
npm test
```

36 offline checks covering the indicator math, the scoring, session resolution,
the order payload, every risk blocker, and the serverless auth boundary.

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
- **A dollar amount you choose.** Type an amount, or take the risk-derived
  suggestion, and shares and dollars-at-risk update as you type. The server
  re-derives everything before sending and refuses anything above the risk
  ceiling.
- **Session context** in the rail, refreshed every 15 seconds: equity, buying
  power, open P&L, and your day-trade count against the PDT limit.

## Timing

A strip above the candidates rates the current part of the session for opening a
new day trade, and says how long until the next window:

| Window | Rating | Why |
|---|---|---|
| Opening drive (first 30 min) | Fair | Heaviest volume, but wide spreads and frequent reversals |
| Morning trend (30–120 min) | **Best** | Opening range set, volume still high, time for a move to work |
| Midday lull | Poor | Thinnest volume; breakouts fail more often |
| Afternoon trend (last 2h to 30 min) | Good | Volume returns, less room to run |
| Closing imbalance (last 30 min) | Avoid | Mechanical auction flow; the guard blocks new entries anyway |

Timing never blocks a trade — it warns. These ratings are conventional desk
wisdom, not numbers fitted to your fills.

## Currencies

**Alpaca does not trade forex.** No USD/GBP, no USD/EUR — it offers US equities,
ETFs, options and crypto. A currency view has to be expressed through an ETF that
holds the currency, and three are on the watchlist:

| Symbol | Tracks |
|---|---|
| `UUP` | US dollar index — roughly the inverse of EUR/USD |
| `FXE` | Euro — a proxy for EUR/USD |
| `FXB` | British pound — a proxy for GBP/USD |

They score like any other symbol and are badged `currency` in the list. One real
limitation: they trade only during US equity hours, so a move made during the
London session shows up as a gap at 09:30 ET rather than something you could have
traded into. They also move on the same driver, so treat `UUP` and `FXE` as one
position, not two — the dashboard flags the correlation.

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

## Autopilot

Unattended trading. **Off unless `AUTOPILOT=true`**, and refused outright against
a live endpoint unless `AUTOPILOT_ALLOW_LIVE=true` as well — `ALLOW_LIVE` covers a
human deciding to click, not a loop deciding on its own.

Every cycle (default 5 minutes) it takes the freshest analysis, picks the single
best candidate, and runs it through the same guard a manual click would. It never
gets more latitude than you do — every threshold is stricter:

| Limit | Default | Manual equivalent |
|---|---|---|
| Minimum score | 75 | 70 |
| Window quality | 0.7 — morning and afternoon trend only | none |
| Trades per day | 3 | none |
| Daily loss limit | 2% drawdown, then halts for the session | none |
| Flatten before close | 10 minutes | manual |

It closes everything before the bell: a day trade that sleeps is no longer a day
trade, and an overnight gap can blow through a stop sized for intraday moves.

**The kill switch** is the Stop button on the dashboard, or
`POST /api/autopilot/halt`. Halting lasts the rest of the session, survives a
restart, and clears at the next open.

**Every decision is journalled** — taken or skipped, with the reasons. That
journal is the point. It is the only way to find out whether the scoring has an
edge, and you should read a couple of weeks of it on paper before trusting it
with anything.

### Exits — keeping the profit

The bracket placed at entry is a floor, not a plan. A fixed stop and target give
back every open profit on a trade that runs and then reverses. On every cycle the
autopilot ratchets the stop, measured in R (one R = the per-share risk the
position was sized against, so the same rules fit a $2 stock and a $600 one):

| At | What happens |
|---|---|
| **+1.0R** | Stop moves to breakeven — the trade can no longer cost anything |
| **+1.5R** | Stop trails 0.75R behind price, ratcheting up only |
| **45 min under +0.3R** | Position is closed — capital stops sitting in a dead trade |
| **10 min to the close** | Everything is flattened |

The stop only ever moves up. Exits are managed even on cycles where no new entry
is allowed: a poor window or a used-up trade cap must never stop a stop trailing.

### Validating it — `npm run backtest`

```bash
npm run backtest -- --days 60
```

Replays the strategy bar by bar over real history using the same scoring, the same
window gate and the same exit policy, with no lookahead — each decision sees only
bars that had closed at that moment. Reports win rate, total R, average R, max
drawdown, and a breakdown by exit reason, window and symbol. Full detail lands in
`data/backtest.json`.

**What it cannot model**, and why the number is an estimate with a known bias:

- **No news.** Live scores include a model's read of headlines worth up to 12
  points either way, plus vetoes. The replay is technicals only.
- **Assumed spreads.** Historical quotes are not fetched, so the liquidity factor
  contributes a constant rather than a measurement.
- **Optimistic fills.** Entry is next-bar-open plus slippage; a real market order
  in a fast tape can do worse.
- **Pessimistic bars.** When one bar spans both stop and target, the stop is
  assumed to hit first — intrabar sequence is unknowable from OHLC.

A losing backtest is decisive. A winning one is permission to paper trade, not
evidence of an edge.

### Before you turn it on

The scoring has **never been validated against history**. The factor weights are
reasoned, not fitted, and no backtest exists. Automating an unproven strategy does
not make it work — it removes the last human check and applies the same judgement
faster and more consistently. Paper only, then read the journal.

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
