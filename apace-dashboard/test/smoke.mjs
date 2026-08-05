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
check('scores every watchlist symbol', () =>
  assert.equal(analysis.candidates.length, config.watchlist.length));
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
  for (const { symbol, plan } of analysis.candidates) {
    if (!plan?.viable) continue;
    assert.ok(plan.stopPrice < plan.entryPrice, `${symbol} stop is not below entry`);
    assert.ok(plan.takeProfitPrice > plan.entryPrice, `${symbol} target is not above entry`);
    assert.ok(plan.notional <= config.maxNotionalPerOrder + 0.01, `${symbol} exceeds the notional cap`);
    assert.ok(plan.qty >= 1 && Number.isInteger(plan.qty), `${symbol} qty must be whole shares`);
    const reward = plan.takeProfitPrice - plan.entryPrice;
    const risk = plan.entryPrice - plan.stopPrice;
    assert.ok(Math.abs(reward / risk - plan.rMultiple) < 0.05, `${symbol} R multiple is wrong`);
  }
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
