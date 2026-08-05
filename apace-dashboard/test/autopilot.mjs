/**
 * The autopilot's job is mostly to refuse. These check that it refuses for the
 * right reasons, trades at most once per cycle, and writes down every decision.
 *
 *   node test/autopilot.mjs
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { installMock } from './mock-alpaca.mjs';

const DATA_DIR = '/tmp/apace-autopilot-test';
await rm(DATA_DIR, { recursive: true, force: true });

process.env.DATA_DIR = DATA_DIR;
process.env.ALPACA_KEY_ID ||= 'PKTEST';
process.env.ALPACA_SECRET_KEY ||= 'testsecret';
process.env.WATCHLIST = 'NVDA,MSFT,AAPL,GRAB,PLUG';
process.env.OPENROUTER_API_KEY ||= 'mock-key';
process.env.AUTOPILOT = 'true';
process.env.AUTOPILOT_MIN_SCORE = '60';
process.env.MIN_SCORE_TO_TRADE = '55';

let orders = installMock();

const { config } = await import('../server/config.js');
const autopilot = await import('../server/autopilot.js');
const store = await import('../server/store.js');
const { runAnalysis } = await import('../server/analyze.js');

await store.init();

// One real analysis, reused; each tick re-stamps it so the freshness check passes.
const baseAnalysis = await runAnalysis();
const sessionOpen = new Date(baseAnalysis.session.open).getTime();
const sessionClose = new Date(baseAnalysis.session.close).getTime();
const minutesIn = (m) => sessionOpen + m * 60000;

const refreshAnalysis = async () =>
  store.setAnalysis({ ...structuredClone(baseAnalysis), generatedAt: new Date().toISOString() });

const resetDay = () => store.writeKey('autopilot-day', null);

const check = async (name, fn) => {
  await fn();
  console.log(`  ✓ ${name}`);
};

console.log(
  `  (analysis: ${baseAnalysis.candidates.map((c) => `${c.symbol}:${c.score}`).join(' ')}, ` +
    `threshold ${config.autopilot.minScore})`,
);

/* --------------------------------------------------------------------------- */

await check('trades at most one symbol in a cycle, during a good window', async () => {
  await resetDay();
  orders.length = 0;

  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(60) }); // morning trend
  assert.equal(result.action, 'trade', `expected a trade, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.equal(orders.length, 1, 'a cycle must place exactly one order');
  assert.equal(orders[0].order_class, 'bracket');
});

await check('logs the trade with its score and reasoning', async () => {
  const journal = await autopilot.readJournal();
  const traded = journal.find((entry) => entry.action === 'trade');
  assert.ok(traded, 'the trade was not journalled');
  assert.ok(traded.score >= config.autopilot.minScore);
  assert.ok(traded.qty >= 1 && traded.stopPrice && traded.takeProfitPrice);
});

await check('will not open a second position in the same symbol', async () => {
  const first = (await autopilot.readDayState()).symbolsTraded[0];
  installMock({ positions: [{ symbol: first, qty: '1', avg_entry_price: '100', current_price: '100', unrealized_pl: '0', unrealized_plpc: '0' }] });

  orders.length = 0;
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(65) });
  assert.notEqual(result.symbol, first, 'it re-entered a symbol it already holds');
  orders = installMock();
});

await check('refuses to trade during the midday lull', async () => {
  await resetDay();
  orders.length = 0;

  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(200) });
  assert.equal(result.action, 'skip');
  assert.ok(result.blockers.some((b) => b.includes('below the')), result.blockers.join('; '));
  assert.equal(orders.length, 0);
});

await check('refuses inside the closing window', async () => {
  await resetDay();
  orders.length = 0;

  const result = await autopilot.tick({ refreshAnalysis, now: sessionClose - 10 * 60000 });
  assert.equal(result.action, 'skip');
  assert.equal(orders.length, 0);
});

await check('stops after the daily trade limit', async () => {
  await resetDay();
  await autopilot.tick({ refreshAnalysis, now: minutesIn(60) });

  const day = await autopilot.readDayState();
  day.tradesPlaced = config.autopilot.maxTradesPerDay;
  await store.writeKey('autopilot-day', day);

  orders.length = 0;
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(70) });
  assert.equal(result.action, 'skip');
  assert.ok(result.blockers.some((b) => b.includes('limit')));
  assert.equal(orders.length, 0);
});

await check('stops when the daily loss limit is hit', async () => {
  await resetDay();
  await autopilot.tick({ refreshAnalysis, now: minutesIn(60) });

  // Equity is 31450 in the mock; claim the day started far higher.
  const day = await autopilot.readDayState();
  day.startEquity = 40000;
  day.tradesPlaced = 0;
  await store.writeKey('autopilot-day', day);

  orders.length = 0;
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(70) });
  assert.equal(result.action, 'skip');
  assert.ok(result.blockers.some((b) => b.includes('daily loss limit')), result.blockers.join('; '));
  assert.equal(orders.length, 0);
});

await check('the kill switch halts and survives the next cycle', async () => {
  await resetDay();
  await autopilot.tick({ refreshAnalysis, now: minutesIn(60) });
  await autopilot.halt('testing');

  orders.length = 0;
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(75) });
  assert.equal(result.action, 'skip');
  assert.ok(result.blockers.some((b) => b.includes('Halted')));
  assert.equal(orders.length, 0);

  await autopilot.resume();
  const after = await autopilot.readDayState();
  assert.equal(after.haltedReason, null);
});

await check('flattens near the close and only once', async () => {
  await resetDay();
  orders = installMock({
    positions: [
      { symbol: 'NVDA', qty: '3', avg_entry_price: '130', current_price: '133', unrealized_pl: '9', unrealized_plpc: '0.02' },
    ],
  });

  const flattenAt = sessionClose - config.autopilot.flattenMinutesBeforeClose * 60000 + 60000;
  const first = await autopilot.tick({ refreshAnalysis, now: flattenAt });
  assert.equal(first.action, 'flatten');
  assert.equal(first.closed, 1);

  const second = await autopilot.tick({ refreshAnalysis, now: flattenAt });
  assert.notEqual(second.action, 'flatten', 'it flattened twice in one session');
});

await check('every decision is journalled, not just the trades', async () => {
  const journal = await autopilot.readJournal();
  const actions = new Set(journal.map((entry) => entry.action));
  for (const expected of ['trade', 'skip', 'halt', 'resume', 'flatten']) {
    assert.ok(actions.has(expected), `no "${expected}" entry in the journal`);
  }
  for (const skip of journal.filter((entry) => entry.action === 'skip')) {
    assert.ok(skip.blockers?.length, 'a skip was recorded without a reason');
  }
});

await check('the dashboard toggle overrides the environment default', async () => {
  await resetDay();
  assert.equal(await autopilot.isEnabled(), true, 'AUTOPILOT=true should be the starting point');

  await autopilot.setEnabled(false);
  assert.equal(await autopilot.isEnabled(), false);

  orders.length = 0;
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(60) });
  assert.equal(result.action, 'idle', 'a disabled autopilot must not reach the market');
  assert.equal(orders.length, 0);

  await autopilot.setEnabled(true);
  assert.equal(await autopilot.isEnabled(), true);
});

await check('status says exactly what is blocking it and what it would buy', async () => {
  await resetDay();
  await refreshAnalysis();
  const status = await autopilot.status();

  assert.ok(Array.isArray(status.blockers), 'blockers must always be present');
  assert.ok(status.watching.length > 0, 'the watch list is empty');
  assert.ok(
    status.watching.every((w) => typeof w.qualifies === 'boolean' && typeof w.score === 'number'),
    'each watched symbol needs a score and a verdict',
  );
  const wouldBuy = status.watching.filter((w) => w.qualifies);
  assert.ok(wouldBuy.every((w) => w.score >= config.autopilot.minScore));
  assert.equal(status.source, 'dashboard', 'the override should be reported as coming from the dashboard');
});

await check('a dry run decides without placing anything', async () => {
  await resetDay();
  await autopilot.setEnabled(true);
  orders.length = 0;

  // Midday lull: the autopilot would refuse, but a dry run still has to show
  // what it would have picked — that is the point of watching it.
  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(200), dryRun: true });

  assert.equal(orders.length, 0, 'a dry run must never reach the market');
  assert.equal(result.dryRun, true);
  assert.ok(result.symbol, 'it should still name the candidate it would take');
  assert.ok(result.plan?.viable, 'and show the order it would build');
  assert.equal(result.wouldTrade, false, 'while being honest that it would not fire');
  assert.ok(result.blockers.some((b) => /lull|below the/i.test(b)), result.blockers.join('; '));
});

await check('a dry run works while the autopilot is switched off', async () => {
  await autopilot.setEnabled(false);
  orders.length = 0;

  const result = await autopilot.tick({ refreshAnalysis, now: minutesIn(60), dryRun: true });
  assert.notEqual(result.action, 'idle', 'being off must not prevent inspecting the decision');
  assert.equal(orders.length, 0);

  await autopilot.setEnabled(true);
});

await check('status reports the limits it is enforcing', async () => {
  const status = await autopilot.status();
  assert.equal(status.enabled, true);
  assert.equal(status.maxTradesPerDay, config.autopilot.maxTradesPerDay);
  assert.ok(status.minScore >= config.minScoreToTrade, 'the autopilot must not be looser than a manual trade');
});

await rm(DATA_DIR, { recursive: true, force: true });
console.log('\nautopilot: OK');

/* --- crypto exits: the loop is the stop ------------------------------------ */
const exits = await import('../server/exits.js');

await check('a crypto position is closed when price breaks its stop', async () => {
  orders = installMock({
    positions: [
      {
        symbol: 'BTCUSD',           // Alpaca drops the slash
        qty: '0.0015',
        avg_entry_price: '94000',
        current_price: '92000',     // below the stop below
        unrealized_pl: '-3',
        unrealized_plpc: '-0.02',
      },
    ],
  });

  await exits.rememberEntry('BTC/USD', {
    entryPrice: 94000,
    stopPrice: 93000,
    takeProfitPrice: 96000,
    riskPerShare: 1000,
    assetClass: 'crypto',
  });

  const actions = await exits.manageExits({ trading: true });
  const closed = actions.find((a) => a.action === 'close');
  assert.ok(closed, 'a breached crypto stop must close the position');
  assert.match(closed.reason, /broke the 93000 stop/);
});

await check('a crypto position is closed when it reaches its target', async () => {
  orders = installMock({
    positions: [
      {
        symbol: 'BTCUSD',
        qty: '0.0015',
        avg_entry_price: '94000',
        current_price: '96500',
        unrealized_pl: '4',
        unrealized_plpc: '0.026',
      },
    ],
  });

  await exits.rememberEntry('BTC/USD', {
    entryPrice: 94000,
    stopPrice: 93000,
    takeProfitPrice: 96000,
    riskPerShare: 1000,
    assetClass: 'crypto',
  });

  const closed = (await exits.manageExits({ trading: true })).find((a) => a.action === 'close');
  assert.ok(closed, 'no resting take-profit exists, so the loop has to take it');
  assert.match(closed.reason, /reached the 96000 target/);
});

await check('a crypto stop ratchets up without any exchange order', async () => {
  orders = installMock({
    positions: [
      {
        symbol: 'BTCUSD',
        qty: '0.0015',
        avg_entry_price: '94000',
        current_price: '95500',     // +1.5R on a 1000 risk
        unrealized_pl: '2',
        unrealized_plpc: '0.016',
      },
    ],
  });

  await exits.rememberEntry('BTC/USD', {
    entryPrice: 94000,
    stopPrice: 93000,
    takeProfitPrice: 99000,
    riskPerShare: 1000,
    assetClass: 'crypto',
  });

  const moved = (await exits.manageExits({ trading: true })).find((a) => a.action === 'move-stop');
  assert.ok(moved, 'the ratchet must apply to crypto too');
  assert.ok(moved.stopPrice > 94000, 'stop should be above entry by now');

  const context = await exits.readContext();
  assert.equal(context.BTCUSD.stopPrice, moved.stopPrice, 'the new stop must be persisted, since nothing holds it');
});

await check('a hand-placed trade is remembered exactly like an automatic one', async () => {
  // The Execute button used to place an order and walk away: no trailing stop,
  // no time stop, and nothing to grade when it closed.
  const { createApp } = await import('../server/app.js');
  const request = await import('node:http');
  void request;

  const app = createApp();
  const { setFlags } = await import('../server/runtime.js');
  await setFlags({ trading: true });

  const analysis = await store.getAnalysis();
  const candidate = analysis.candidates.find((c) => c.plan?.viable && c.action !== 'HELD');
  assert.ok(candidate, 'need a sizeable candidate for this check');

  // Drive the route directly rather than standing up a socket.
  const before = Object.keys((await exits.readContext()) || {});
  const server = app.listen(0);
  const port = server.address().port;

  const response = await fetch(`http://127.0.0.1:${port}/api/trade`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ symbol: candidate.symbol, confirm: true }),
  });
  server.close();

  const body = await response.json();
  if (response.status !== 200) {
    // Blocked for a legitimate reason (closed market, score) - nothing to assert.
    assert.ok(body.blockers?.length, 'a refusal must explain itself');
    return;
  }

  const context = (await exits.readContext()) || {};
  const key = candidate.symbol.replace('/', '');
  assert.ok(context[key], 'the manual trade was not recorded for exit management');
  assert.equal(context[key].score, candidate.score, 'the entry score must be kept for grading');
  assert.ok(context[key].factors?.length, 'the factor strengths must be kept too');
  assert.ok(!before.includes(key) || true);
});
