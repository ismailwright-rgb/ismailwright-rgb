// Risk guard. The agent cannot place orders itself - only what survives this node
// becomes a real order. Treat every field coming out of the model as untrusted.
//
// Paste this into the "Risk Guard" Code node, replacing its contents.
//
// FIX: Alpaca returns crypto positions without the slash ("BTCUSD"), while the
// agent recommends the slashed form ("BTC/USD"). Comparing them directly meant
// the "already holding" check could never match a crypto position, so the guard
// would happily buy BTC again on top of one it already owned. Every symbol
// comparison now goes through normalise().

const MAX_NOTIONAL_PER_ORDER        = 500;   // USD per single equity/ETF order
const MAX_NOTIONAL_PER_ORDER_CRYPTO = 150;   // USD per single crypto order - tighter given volatility
const MAX_NOTIONAL_PER_RUN          = 2000;  // USD across the whole run
const MAX_CRYPTO_NOTIONAL_PER_RUN   = 300;   // USD ceiling on total crypto exposure added per run
const MIN_CONFIDENCE                = 55;
const MAX_ORDERS_PER_RUN            = 4;
const MAX_CRYPTO_ORDERS_PER_RUN     = 1;     // at most one new crypto position per run

const ALLOWLIST = [
  'GRAB', 'PLUG', 'GLD', 'SLV', 'CPER', 'SPY', 'QQQ', 'AAPL', 'MSFT',
  'NVDA', 'FCX', 'NEM', 'CAT', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM',
  'BTC/USD', 'ETH/USD',
];
const CRYPTO_SYMBOLS = new Set(['BTC/USD', 'ETH/USD']);

// One canonical form for comparisons: upper case, no spaces, no slash.
// "BTC/USD" and "BTCUSD" are the same position.
const normalise = (value) => String(value ?? '').toUpperCase().replace(/\s+/g, '').replace(/\//g, '');

const ALLOWED = new Set(ALLOWLIST.map(normalise));
const CRYPTO = new Set([...CRYPTO_SYMBOLS].map(normalise));

// The parsed agent output. With the structured parser attached it lands on .output.
const agentJson = $('Trading Agent - Paper').first().json;
const parsed = agentJson.output ?? agentJson;
const recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];

// Symbols already held, from the main-flow positions fetch feeding this node.
const held = new Set($input.all().map((item) => item.json.symbol).filter(Boolean).map(normalise));

const approved = [];
const rejected = [];
let runTotal = 0;
let cryptoRunTotal = 0;
let cryptoOrderCount = 0;

for (const rec of recommendations) {
  // Keep the slashed form for the order body; compare on the normalised one.
  const symbol = String(rec.symbol ?? '').toUpperCase().trim();
  const key = normalise(symbol);
  const isCrypto = CRYPTO.has(key);
  const confidence = Number(rec.confidence);
  const requested = Number(rec.notional_usd);
  const reasons = [];

  if (String(rec.action ?? '').toLowerCase() !== 'buy') {
    reasons.push(`action is ${rec.action}, not Buy`);
  }
  if (!ALLOWED.has(key)) {
    reasons.push(`${symbol || '(blank)'} is not on the allowlist`);
  }
  if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) {
    reasons.push(`confidence ${rec.confidence} is below ${MIN_CONFIDENCE}`);
  }
  if (!Number.isFinite(requested) || requested <= 0) {
    reasons.push(`notional ${rec.notional_usd} is not a positive number`);
  }
  if (held.has(key)) {
    reasons.push('already holding this symbol');
  }
  if (approved.some((a) => normalise(a.symbol) === key)) {
    reasons.push('duplicate recommendation in the same run');
  }
  if (approved.length >= MAX_ORDERS_PER_RUN) {
    reasons.push(`already at the ${MAX_ORDERS_PER_RUN} order limit for this run`);
  }
  if (isCrypto && cryptoOrderCount >= MAX_CRYPTO_ORDERS_PER_RUN) {
    reasons.push(`already at the ${MAX_CRYPTO_ORDERS_PER_RUN} crypto order limit for this run`);
  }

  if (reasons.length) {
    rejected.push({ symbol, reasons });
    continue;
  }

  const perOrderCap = isCrypto ? MAX_NOTIONAL_PER_ORDER_CRYPTO : MAX_NOTIONAL_PER_ORDER;
  const capped = Math.min(requested, perOrderCap);

  if (runTotal + capped > MAX_NOTIONAL_PER_RUN) {
    rejected.push({ symbol, reasons: ['run budget exhausted'] });
    continue;
  }
  if (isCrypto && cryptoRunTotal + capped > MAX_CRYPTO_NOTIONAL_PER_RUN) {
    rejected.push({ symbol, reasons: ['crypto run budget exhausted'] });
    continue;
  }

  runTotal += capped;
  if (isCrypto) {
    cryptoRunTotal += capped;
    cryptoOrderCount += 1;
  }

  approved.push({
    approved: true,
    symbol,
    asset_class: isCrypto ? 'crypto' : 'equity',
    notional: Number(capped.toFixed(2)),
    requested_notional: requested,
    was_capped: capped < requested,
    confidence,
    thesis: rec.thesis ?? '',
    risks: rec.risks ?? '',
    market_comment: parsed.market_comment ?? '',
  });
}

console.log(`approved ${approved.length} / ${recommendations.length}, $${runTotal} ($${cryptoRunTotal} crypto)`);
console.log('rejected:', JSON.stringify(rejected));

// Always emit at least one item so the IF node has something to route.
if (!approved.length) {
  return [{
    json: {
      approved: false,
      reason: 'no recommendation passed the risk guard',
      considered: recommendations.length,
      rejected,
      market_comment: parsed.market_comment ?? '',
    },
  }];
}

return approved.map((json) => ({ json }));
