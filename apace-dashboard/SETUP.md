# Setting up the dashboard, step by step

Written for someone who has never run this project. Nothing here assumes you know
Docker. Total time: about 15 minutes, most of it waiting for downloads.

There are two stages, and **you should do stage one first** — it lets you see and
click the whole dashboard before you go anywhere near an account or a key.

---

## Stage one — see it working (no keys, no account, ~5 min)

### Step 1. Install Docker Desktop

Skip if you already have it. Check by opening a terminal and running:

```bash
docker --version
```

If that prints a version number, you're done. If it says "command not found",
download Docker Desktop from <https://www.docker.com/products/docker-desktop/>,
install it, and **launch the app** — the whale icon has to be running in your menu
bar or system tray, not just installed. Then re-run the command above.

### Step 2. Get the code onto your machine

Open a terminal and pick a folder you don't mind cloning into (your home folder is
fine), then:

```bash
git clone https://github.com/ismailwright-rgb/ismailwright-rgb.git
cd ismailwright-rgb
git checkout claude/stock-agent-workflow-l36r04
cd apace-dashboard
```

> **If you already have this repo cloned somewhere**, go to that folder instead and
> run `git fetch origin && git checkout claude/stock-agent-workflow-l36r04 && cd apace-dashboard`.

Confirm you're in the right place — this should list `Dockerfile`, `server`, `public`:

```bash
ls
```

### Step 3. Start the demo

```bash
docker compose up demo
```

The first run downloads the Node base image and builds the container. Expect one to
three minutes and a lot of scrolling text. It's finished when you see:

```
apace-demo  | Apace dashboard on :8099
apace-demo  |   mode        PAPER
```

### Step 4. Open it

Go to **<http://localhost:8099>** in your browser.

You're looking at the real dashboard driven by a synthetic market. Everything works
— expand a row, read the score breakdown, click **Check & execute** and then the
confirm button. Orders are captured in memory and thrown away. This container has
no credentials and cannot reach a real account.

### Step 5. Stop it

Press `Ctrl+C` in the terminal, then:

```bash
docker compose down
```

**If stage one worked, the software is fine on your machine.** Everything after this
is about pointing it at your actual account.

---

## Stage two — point it at your paper account (~10 min)

### Step 6. Get fresh Alpaca paper keys

1. Sign in at <https://app.alpaca.markets>.
2. Switch to **Paper Trading** — there's a toggle in the top-left. Confirm the URL
   or header says Paper before continuing.
3. In the right-hand panel find **API Keys**, then click **Regenerate** (or
   **Generate New Key** if you've never made one).
4. You'll see a **Key ID** starting with `PK` and a **Secret Key**. **The secret is
   shown exactly once** — copy both somewhere now.

> Regenerate rather than reuse: the keys from your original n8n export were shared
> in our conversation, so treat them as burned.

### Step 7. Create your config file

Still in the `apace-dashboard` folder:

```bash
cp .env.example .env
```

Open the new `.env` in any text editor and fill in the first two lines:

```
ALPACA_KEY_ID=PK...your key id...
ALPACA_SECRET_KEY=...your secret...
```

Leave everything else alone for now. The defaults are deliberately conservative:
$500 max per order, 0.5% of equity risked per trade, 4 open positions, and a score
of 70 required before the Execute button will do anything.

`.env` is already in `.gitignore` and `.dockerignore`, so it will not be committed
or baked into the image.

**Optional — turn on the written reasoning.** Without this the dashboard still
scores everything and shows headlines, it just won't write the for/against case.
Add an OpenRouter key (from <https://openrouter.ai/keys>) to the same file:

```
OPENROUTER_API_KEY=sk-or-...
```

### Step 8. Start it for real

```bash
docker compose up --build
```

Wait for:

```
apace-dashboard  | Apace dashboard on :8080
apace-dashboard  |   mode        PAPER
```

**If it says `LIVE — real money`, stop immediately** and check `ALPACA_TRADING_URL`
in your `.env`. It should be `https://paper-api.alpaca.markets`.

### Step 9. Open the real dashboard

**<http://localhost:8080>**

First load takes a few seconds — it's fetching bars, quotes, and news for the whole
watchlist. You should see your actual equity and buying power in the top rail. If
those numbers match your Alpaca paper account, everything is wired up.

### Step 10. Run it in the background

Once you trust it, run it detached so it survives closing the terminal:

```bash
docker compose up -d
```

Useful commands from then on:

| What | Command |
|---|---|
| See the logs | `docker compose logs -f` |
| Stop it | `docker compose down` |
| Restart after changing `.env` | `docker compose up -d --force-recreate` |
| Pull down code changes | `git pull && docker compose up -d --build` |

---

## Using it day to day

- **Best window is roughly 10:00–15:30 ET.** Before 10:00 there aren't enough bars
  for the trend and RSI factors — they'll say "not enough bars yet" rather than
  guess. After 15:30 the guard stops new entries so nothing gets carried overnight.
- **Hit Refresh analysis** before acting on anything. Analysis older than 10 minutes
  is refused for trading, and the rail shows its age.
- **Read the row before the score.** The number is a summary of six factors, each of
  which prints the sentence that produced it. If the reasoning doesn't convince you,
  the score shouldn't either.
- **Watch the day-trade counter** in the rail. Under $25k equity, a fourth day trade
  in five business days restricts the account — the guard blocks it at three, but
  it's better to see it coming.
- **Flatten all** closes everything at market. Day trades aren't meant to sleep.

## Troubleshooting

**`docker: command not found`** — Docker Desktop isn't installed, or isn't running.
Launch the app and wait for the whale icon to stop animating.

**`port is already allocated`** — something else is on 8080. Change the left-hand
number in `docker-compose.yml` (e.g. `"127.0.0.1:8090:8080"`) and use that port.

**`ALPACA_KEY_ID and ALPACA_SECRET_KEY are required`** — the container didn't find
your `.env`. Make sure it's called exactly `.env` (not `.env.txt`) and sits in the
`apace-dashboard` folder next to `docker-compose.yml`.

**`Alpaca 403`** — the keys are wrong, or they're live keys against the paper
endpoint. Regenerate paper keys and re-copy both values.

**Every symbol says "No data"** — the market hasn't opened yet, or it's a weekend or
holiday. The dashboard falls back to the last completed session and disables
execution; the banner will say so.

**Scores look low and half the factors say "not enough bars"** — it's early in the
session. EMA20 needs twenty 5-minute bars, about 100 minutes after the open.

**Page loads but shows "Could not load"** — check `docker compose logs -f` for the
real error. Usually an Alpaca credential or connectivity problem.

## Security note

`docker-compose.yml` binds to `127.0.0.1` on purpose, so only your own machine can
reach the dashboard. Anyone who can open the page can place orders. Before you
expose it on a network, set `DASHBOARD_USER` and `DASHBOARD_PASSWORD` in `.env` —
the app will then require a login.
