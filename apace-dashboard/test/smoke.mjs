/**
 * Offline smoke test: runs the full analysis against a synthetic Alpaca and
 * exercises the risk guard, so the indicator math, scoring, session resolution
 * and every blocker are checked without touching the network or an account.
 *
 *   node test/smoke.mjs
 */
import assert from 'node:assert/strict';
import { installMock } from './mock-alpaca.mjs';

process.env.ALPACA_KEY_ID ||= 'PKTEST';
process.env.ALPACA_SECRET_KEY ||= 'testsecret';
process.env.WATCHLIST ||= 'NVDA,MSFT,AAPL,GRAB,PLUG';
process.env.OPENROUTER_API_KEY ||= 'mock-key';

const capturedOrders = installMock();

const { runAnalysis } = await import('../server/analyze.js');
const { placeBracketOrder } = await import('../server/alpaca.js');
const { buildTradePlan, evaluateTrade } = await import('../server/guard.js');
const { config } = await import('../server/config.js');

const baseAccount = { equity: '30000', buying_power: '60000', daytrade_count: '0' };
const openSession = { isCurrent: true, minutesToClose: 200, date: '2026-08-05' };
const healthyCandidate = { symbol: 'AAPL', score: 95, spreadBps: 4, news: null, dataQuality: {} };

const check = (name, fn) => {
  fn();
  console.log(`  ✓ ${name}`);
};

const checkAsync = async (name, fn) => {
  await fn();
  console.log(`  ✓ ${name}`);
};

/* --- analysis -------------------------------------------------------------- */
const analysis = await runAnalysis();

check('defaults to the paper endpoint', () => assert.equal(analysis.mode, 'paper'));
check('scores every watchlist symbol, equities and crypto', () =>
  assert.equal(analysis.candidates.length, config.watchlist.length + config.cryptoWatchlist.length));
check('resolves a trading session', () => assert.ok(analysis.session.date));
check('computes the benchmark move', () => assert.notEqual(analysis.benchmark.changePct, null));

check('every score is in range with six explained factors', () => {
  for (const candidate of analysis.candidates) {
    assert.ok(candidate.score >= 0 && candidate.score <= 100, `${candidate.symbol} score out of range`);
    assert.equal(candidate.factors.length, 6, `${candidate.symbol} factor count`);
    for (const factor of candidate.factors) {
      assert.ok(factor.strength >= -1 && factor.strength <= 1, `${candidate.symbol}/${factor.key} strength`);
      assert.ok(factor.detail?.length > 0, `${candidate.symbol}/${factor.key} has no explanation`);
    }
  }
});

check('every viable plan is internally consistent', () => {
  for (const { symbol, plan, group } of analysis.candidates) {
    if (!plan?.viable) continue;
    assert.ok(plan.stopPrice < plan.entryPrice, `${symbol} stop is not below entry`);
    assert.ok(plan.takeProfitPrice > plan.entryPrice, `${symbol} target is not above entry`);

    if (group === 'crypto') {
      // Fractional and separately capped, and no stop rests at the exchange.
      assert.ok(plan.notional <= config.maxNotionalPerOrderCrypto + 0.01, `${symbol} exceeds the crypto cap`);
      assert.ok(plan.qty > 0, `${symbol} qty must be positive`);
      assert.equal(plan.restingStop, false, 'crypto cannot have a resting stop on Alpaca');
      assert.ok(plan.stopDistancePct >= 1, `${symbol} crypto stop must be at least 1% wide`);
    } else {
      assert.ok(plan.notional <= config.maxNotionalPerOrder + 0.01, `${symbol} exceeds the notional cap`);
      assert.ok(plan.qty >= 1 && Number.isInteger(plan.qty), `${symbol} qty must be whole shares`);
    }

    const reward = plan.takeProfitPrice - plan.entryPrice;
    const risk = plan.entryPrice - plan.stopPrice;
    assert.ok(Math.abs(reward / risk - plan.rMultiple) < 0.05, `${symbol} R multiple is wrong`);
  }
});

check('crypto is scored on continuous-market factors, not session ones', () => {
  const btc = analysis.candidates.find((c) => c.symbol === 'BTC/USD');
  assert.ok(btc, 'BTC/USD was not scored');
  assert.equal(btc.group, 'crypto');

  const keys = btc.factors.map((f) => f.key);
  assert.ok(keys.includes('rangeBreak'), 'crypto should use a 24h range break');
  assert.ok(!keys.includes('openingRange'), 'there is no opening range on a 24/7 market');
  assert.ok(btc.score >= 0 && btc.score <= 100);
});

check('crypto is refused until it is explicitly enabled', () => {
  const btc = analysis.candidates.find((c) => c.symbol === 'BTC/USD');
  const verdict = evaluateTrade({
    candidate: { ...btc, score: 99, spreadBps: 4, dataQuality: {} },
    plan: btc.plan,
    account: baseAccount,
    positions: [],
    session: { isCurrent: false, minutesToClose: 0, date: '2026-08-05' },
    analysisAgeSeconds: 5,
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.blockers.some((b) => b.includes('Crypto trading is off')), verdict.blockers.join('; '));
  // A closed equity market must not be a reason to refuse a 24/7 asset.
  assert.ok(!verdict.blockers.some((b) => b.includes('market is closed')), 'crypto trades around the clock');
});

check('candidates are ranked by score', () => {
  const scores = analysis.candidates.map((c) => c.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

check('the news read reaches the candidates', () => {
  assert.equal(analysis.newsRead.available, true);
  const plug = analysis.candidates.find((c) => c.symbol === 'PLUG');
  assert.ok(plug.news?.veto, 'the vetoed symbol did not carry its veto through');
  assert.ok(plug.score <= 40, 'a veto must collapse the score');
});

/* --- sizing ---------------------------------------------------------------- */
check('the per-order cap binds ahead of risk sizing', () => {
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 220, atrValue: 0.2, equity: 1_000_000 });
  assert.ok(plan.viable);
  assert.ok(plan.notional <= config.maxNotionalPerOrder);
});

check('an unaffordable share price is refused, not rounded to zero', () => {
  const plan = buildTradePlan({ symbol: 'BRK.A', entryPrice: 700_000, atrValue: 500, equity: 30_000 });
  assert.equal(plan.viable, false);
  assert.match(plan.reason, /cap/);
});

check('a quiet tape still gets a floored stop', () => {
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 100, atrValue: 0.0001, equity: 50_000 });
  assert.ok(plan.viable);
  assert.ok(plan.entryPrice - plan.stopPrice >= 0.29, 'stop collapsed below the 0.30% floor');
});

/* --- guard ----------------------------------------------------------------- */
const guardCase = (overrides) =>
  evaluateTrade({
    candidate: healthyCandidate,
    plan: buildTradePlan({ symbol: 'AAPL', entryPrice: 220, atrValue: 1.2, equity: 30_000 }),
    account: baseAccount,
    positions: [],
    session: openSession,
    analysisAgeSeconds: 5,
    ...overrides,
  });

check('a clean setup is allowed', () => {
  const verdict = guardCase({});
  assert.equal(verdict.allowed, true, verdict.blockers.join('; '));
});

check('a score below the threshold is blocked', () => {
  const verdict = guardCase({ candidate: { ...healthyCandidate, score: 10 } });
  assert.ok(verdict.blockers.some((b) => b.includes('below the')));
});

check('a news veto is blocked', () => {
  const verdict = guardCase({
    candidate: { ...healthyCandidate, news: { veto: true, vetoReason: 'offering filed' } },
  });
  assert.ok(verdict.blockers.some((b) => b.includes('News veto')));
});

check('a wide spread is blocked', () => {
  const verdict = guardCase({ candidate: { ...healthyCandidate, spreadBps: 400 } });
  assert.ok(verdict.blockers.some((b) => b.includes('Spread')));
});

check('the PDT limit is blocked', () => {
  const verdict = guardCase({ account: { equity: '10000', buying_power: '20000', daytrade_count: '3' } });
  assert.ok(verdict.blockers.some((b) => b.includes('PDT')));
});

check('the third day trade warns before the limit', () => {
  const verdict = guardCase({ account: { equity: '10000', buying_power: '20000', daytrade_count: '2' } });
  assert.equal(verdict.allowed, true);
  assert.ok(verdict.warnings.some((w) => w.includes('PDT')));
});

check('no new entries near the bell', () => {
  const verdict = guardCase({ session: { ...openSession, minutesToClose: 5 } });
  assert.ok(verdict.blockers.some((b) => b.includes('close')));
});

check('a closed market is blocked', () => {
  const verdict = guardCase({ session: { ...openSession, isCurrent: false } });
  assert.ok(verdict.blockers.some((b) => b.includes('closed')));
});

check('stale analysis cannot be traded on', () => {
  const verdict = guardCase({ analysisAgeSeconds: 9999 });
  assert.ok(verdict.blockers.some((b) => b.includes('old')));
});

check('adding to an existing position is blocked', () => {
  const verdict = guardCase({ positions: [{ symbol: 'AAPL' }] });
  assert.ok(verdict.blockers.some((b) => b.includes('Already holding')));
});

check('the open-position limit is blocked', () => {
  const positions = Array.from({ length: config.maxOpenPositions }, (_, i) => ({ symbol: `X${i}` }));
  const verdict = guardCase({ positions });
  assert.ok(verdict.blockers.some((b) => b.includes('open positions')));
});

check('an off-watchlist symbol is blocked', () => {
  const verdict = guardCase({ candidate: { ...healthyCandidate, symbol: 'DOGE' } });
  assert.ok(verdict.blockers.some((b) => b.includes('watchlist')));
});

check('insufficient buying power is blocked', () => {
  const verdict = guardCase({ account: { ...baseAccount, buying_power: '1' } });
  assert.ok(verdict.blockers.some((b) => b.includes('buying power')));
});

/* --- session timing -------------------------------------------------------- */
const { tradeWindow } = await import('../server/windows.js');

const sessionOpen = new Date('2026-08-05T13:30:00Z');
const sessionClose = new Date('2026-08-05T20:00:00Z');
const at = (minutes) =>
  tradeWindow(sessionOpen.getTime() + minutes * 60000, { open: sessionOpen, close: sessionClose });

check('the session is divided into the expected windows', () => {
  assert.equal(at(-15).key, 'premarket');
  assert.equal(at(5).key, 'opening_drive');
  assert.equal(at(45).key, 'morning_trend');
  assert.equal(at(150).key, 'midday_lull');
  assert.equal(at(320).key, 'afternoon_trend');
  assert.equal(at(375).key, 'closing_imbalance');
  assert.equal(at(400).key, 'closed');
});

check('the morning trend is rated the best window', () => {
  const qualities = [at(5), at(45), at(150), at(320), at(375)].map((w) => w.quality);
  assert.equal(Math.max(...qualities), at(45).quality);
});

check('a poor window points at the next good one', () => {
  const lull = at(150);
  assert.equal(lull.bestRemaining.key, 'afternoon_trend');
  assert.ok(lull.bestRemaining.inMinutes > 0);
});

check('a half day collapses the middle instead of inverting', () => {
  const shortClose = new Date('2026-08-05T17:00:00Z'); // 3.5 hours
  const window = tradeWindow(sessionOpen.getTime() + 130 * 60000, {
    open: sessionOpen,
    close: shortClose,
  });
  assert.ok(['afternoon_trend', 'closing_imbalance'].includes(window.key), `got ${window.key}`);
  assert.ok(window.quality >= 0);
});

/* --- custom position size --------------------------------------------------- */
check('a chosen dollar amount sets the share count', () => {
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 100, atrValue: 1, equity: 50_000, requestedNotional: 400 });
  assert.equal(plan.qty, 4);
  assert.equal(plan.custom, true);
  assert.equal(plan.notional, 400);
});

check('a chosen amount is still capped by the per-order limit', () => {
  const plan = buildTradePlan({
    symbol: 'AAPL',
    entryPrice: 100,
    atrValue: 1,
    equity: 500_000,
    requestedNotional: 100_000,
  });
  assert.ok(plan.notional <= config.maxNotionalPerOrder);
  assert.equal(plan.cappedByNotional, true);
});

check('an amount that risks more than the ceiling is refused', () => {
  // Wide stop on a small account: a few hundred dollars breaches 1.5% of equity.
  const equity = 2000;
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 100, atrValue: 8, equity, requestedNotional: 500 });
  assert.ok(plan.viable);
  assert.ok(plan.riskDollars > plan.maxRiskDollars, 'test setup should breach the ceiling');

  const verdict = evaluateTrade({
    candidate: healthyCandidate,
    plan,
    account: { equity: String(equity), buying_power: '4000', daytrade_count: '0' },
    positions: [],
    session: openSession,
    analysisAgeSeconds: 5,
  });
  assert.equal(verdict.allowed, false);
  assert.ok(verdict.blockers.some((b) => b.includes('ceiling')));
});

check('an amount above the target but under the ceiling warns and proceeds', () => {
  const equity = 30_000;
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 100, atrValue: 1, equity, requestedNotional: 500 });
  const budget = (equity * config.riskPctPerTrade) / 100;
  assert.ok(plan.riskDollars <= plan.maxRiskDollars);

  const verdict = evaluateTrade({
    candidate: healthyCandidate,
    plan,
    account: { equity: String(equity), buying_power: '60000', daytrade_count: '0' },
    positions: [],
    session: openSession,
    analysisAgeSeconds: 5,
  });
  assert.equal(verdict.allowed, true, verdict.blockers.join('; '));
  if (plan.riskDollars > budget) {
    assert.ok(verdict.warnings.some((w) => w.includes('above your')));
  }
});

check('a bad window warns but never blocks', () => {
  const verdict = evaluateTrade({
    candidate: healthyCandidate,
    plan: buildTradePlan({ symbol: 'AAPL', entryPrice: 220, atrValue: 1.2, equity: 30_000 }),
    account: baseAccount,
    positions: [],
    session: openSession,
    analysisAgeSeconds: 5,
    window: at(150),
  });
  assert.equal(verdict.allowed, true, 'timing must never be a hard blocker');
  assert.ok(verdict.warnings.some((w) => w.includes('Midday lull')));
});

/* --- exit management -------------------------------------------------------- */
const { decideExit } = await import('../server/exits.js');

// A $100 entry risking $1 per share: 1R = $101, 1.5R = $101.50.
const position = { entryPrice: 100, riskPerShare: 1, currentStop: 99, minutesHeld: 5 };

check('does nothing while the trade is still near entry', () => {
  const decision = decideExit({ ...position, currentPrice: 100.4 });
  assert.equal(decision.action, 'hold');
});

check('moves the stop to breakeven at 1R', () => {
  const decision = decideExit({ ...position, currentPrice: 101 });
  assert.equal(decision.action, 'move-stop');
  assert.ok(decision.stopPrice > 100, 'breakeven stop must sit above entry, not at it');
  assert.ok(decision.stopPrice < 100.5);
});

check('trails behind price once the trade is working', () => {
  const decision = decideExit({ ...position, currentPrice: 103, currentStop: 100.01 });
  assert.equal(decision.action, 'move-stop');
  // 0.75R behind 103 = 102.25
  assert.ok(Math.abs(decision.stopPrice - 102.25) < 0.02, `got ${decision.stopPrice}`);
});

check('the stop only ever ratchets up', () => {
  // Price pulled back from 103 to 101.6, stop already trailed to 102.25.
  const decision = decideExit({ ...position, currentPrice: 101.6, currentStop: 102.25 });
  assert.equal(decision.action, 'hold', 'a stop that can move down is not a stop');
});

check('cuts a position that has gone nowhere', () => {
  const decision = decideExit({ ...position, currentPrice: 100.1, minutesHeld: 60 });
  assert.equal(decision.action, 'close');
  assert.match(decision.reason, /not working/);
});

check('leaves a working position alone past the time stop', () => {
  const decision = decideExit({ ...position, currentPrice: 102, minutesHeld: 60 });
  assert.notEqual(decision.action, 'close', 'a winning trade must not be time-stopped');
});

check('refuses to act without a risk basis', () => {
  const decision = decideExit({ entryPrice: 100, currentPrice: 105, riskPerShare: 0, minutesHeld: 5 });
  assert.equal(decision.action, 'hold');
});

/* --- backtest harness ------------------------------------------------------- */
await checkAsync('the backtest replays without lookahead and reports a full summary', async () => {
  const { runBacktest } = await import('../server/backtest.js');
  const result = await runBacktest({ days: 8, minScore: 60, symbols: config.watchlist });

  assert.ok(result.sessions > 0, 'no sessions replayed');
  assert.ok(Array.isArray(result.tradeList));
  for (const key of ['winRate', 'totalR', 'avgR', 'maxDrawdownR', 'byReason', 'byWindow', 'curve']) {
    assert.ok(key in result, `summary is missing ${key}`);
  }

  for (const trade of result.tradeList) {
    assert.ok(trade.openedAt < trade.exitAt, `${trade.symbol} exited before it was entered`);
    assert.ok(trade.entryPrice > 0 && trade.riskPerShare > 0);
    assert.ok(Number.isFinite(trade.r));
    // Entries only happen in windows the autopilot would allow.
    assert.ok(['morning_trend', 'afternoon_trend'].includes(trade.window), `entered during ${trade.window}`);
  }

  assert.ok(result.maxDrawdownR <= 0, 'drawdown must be zero or negative');
});

/* --- order payload --------------------------------------------------------- */
await checkAsync('the submitted order is a day bracket with both legs', async () => {
  const plan = buildTradePlan({ symbol: 'AAPL', entryPrice: 220, atrValue: 1.2, equity: 30_000 });
  await placeBracketOrder({
    symbol: 'AAPL',
    qty: plan.qty,
    entryType: 'market',
    stopPrice: plan.stopPrice,
    takeProfitPrice: plan.takeProfitPrice,
    clientOrderId: 'apace-AAPL-test',
  });

  const order = capturedOrders.at(-1);
  assert.equal(order.order_class, 'bracket');
  assert.equal(order.time_in_force, 'day', 'a day trade must not rest overnight');
  assert.equal(order.side, 'buy');
  assert.equal(order.qty, String(plan.qty));
  assert.equal(order.stop_loss.stop_price, plan.stopPrice.toFixed(2));
  assert.equal(order.take_profit.limit_price, plan.takeProfitPrice.toFixed(2));
  assert.ok(order.client_order_id, 'idempotency key is present');
  assert.ok(!('notional' in order), 'bracket orders must be sized in whole shares, not notional');
});

console.log('\nsmoke: OK');
console.log(`  session     ${analysis.session.date} (${analysis.session.isCurrent ? 'open' : 'closed'})`);
console.log(`  scored      ${analysis.candidates.map((c) => `${c.symbol}:${c.score}`).join('  ')}`);
console.log(`  news read   ${analysis.newsRead.available ? analysis.newsRead.model : analysis.newsRead.reason}`);
