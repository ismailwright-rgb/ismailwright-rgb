/**
 * Composite day-trade score.
 *
 * Every factor returns a signed strength in -1..+1 with a human-readable detail
 * string. The score is a weighted blend mapped onto 0..100, and the UI renders
 * the same factor list, so what you see is exactly what produced the number.
 *
 * This is deterministic and computed from price and volume. The language model
 * never sets the score; it can only adjust it via news sentiment, and veto.
 */

const FACTORS = [
  { key: 'trend', label: 'Intraday trend', weight: 25 },
  { key: 'openingRange', label: 'Opening range', weight: 20 },
  { key: 'volume', label: 'Relative volume', weight: 20 },
  { key: 'relativeStrength', label: 'Strength vs SPY', weight: 15 },
  { key: 'momentum', label: 'Momentum (RSI)', weight: 10 },
  { key: 'liquidity', label: 'Spread / liquidity', weight: 10 },
];

const clamp = (value, min = -1, max = 1) => Math.min(max, Math.max(min, value));
const fmt = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : 'n/a');

function trendFactor({ ema9, ema20, last, vwapValue }) {
  if (ema9 == null || ema20 == null || vwapValue == null) {
    return { strength: 0, detail: 'Not enough bars yet', missing: true };
  }

  const emaSpreadPct = ((ema9 - ema20) / ema20) * 100;
  const vwapDistPct = ((last - vwapValue) / vwapValue) * 100;

  // Two half-weights: EMA stack for direction, VWAP side for who is in control.
  const emaPart = clamp(emaSpreadPct / 0.4);
  const vwapPart = clamp(vwapDistPct / 0.5);
  const strength = clamp(emaPart * 0.5 + vwapPart * 0.5);

  const side = last >= vwapValue ? 'above' : 'below';
  return {
    strength,
    detail: `EMA9 ${ema9 > ema20 ? '>' : '<'} EMA20 by ${fmt(Math.abs(emaSpreadPct))}%, price ${side} VWAP by ${fmt(Math.abs(vwapDistPct))}%`,
  };
}

function openingRangeFactor({ orb }) {
  if (!orb) return { strength: 0, detail: 'Opening range not formed yet', missing: true };

  if (orb.state === 'above') {
    return {
      strength: clamp(0.5 + orb.extension * 0.8),
      detail: `Broken above the opening range high (${fmt(orb.high)}), extended ${fmt(orb.extension, 2)}x the range`,
    };
  }
  if (orb.state === 'below') {
    return {
      strength: clamp(-0.5 - orb.extension * 0.8),
      detail: `Broken below the opening range low (${fmt(orb.low)}) - wrong side for a long`,
    };
  }
  return { strength: 0, detail: `Still inside the opening range ${fmt(orb.low)}-${fmt(orb.high)}, no edge yet` };
}

function volumeFactor({ rvol }) {
  if (rvol == null) return { strength: 0, detail: 'No volume baseline', missing: true };

  // 1.0 is an average day. Below 0.8 means nobody is there; above 1.5 is real interest.
  const strength = clamp((rvol - 1) / 0.8);
  const verdict = rvol >= 1.5 ? 'heavy participation' : rvol >= 1 ? 'normal participation' : 'thin participation';
  return { strength, detail: `${fmt(rvol, 2)}x the usual volume for this point in the session - ${verdict}` };
}

function relativeStrengthFactor({ symbolChangePct, benchmarkChangePct }) {
  if (symbolChangePct == null || benchmarkChangePct == null) {
    return { strength: 0, detail: 'No benchmark comparison available', missing: true };
  }

  const diff = symbolChangePct - benchmarkChangePct;
  return {
    strength: clamp(diff / 1.2),
    detail: `${fmt(symbolChangePct)}% vs SPY ${fmt(benchmarkChangePct)}% - ${diff >= 0 ? 'outperforming' : 'lagging'} by ${fmt(Math.abs(diff))}pts`,
  };
}

function momentumFactor({ rsiValue }) {
  if (rsiValue == null) return { strength: 0, detail: 'Not enough bars for RSI', missing: true };

  // Favour a strong-but-not-exhausted 55-70. Punish overbought chasing hardest.
  let strength;
  if (rsiValue >= 80) strength = -0.8;
  else if (rsiValue >= 70) strength = 0.2;
  else if (rsiValue >= 55) strength = 1;
  else if (rsiValue >= 45) strength = 0;
  else if (rsiValue >= 30) strength = -0.6;
  else strength = -0.3; // deeply oversold - not a long signal, but not a chase either

  const note =
    rsiValue >= 80 ? 'overbought, poor entry' : rsiValue >= 55 ? 'constructive' : rsiValue >= 45 ? 'neutral' : 'weak';
  return { strength, detail: `RSI ${fmt(rsiValue, 1)} - ${note}` };
}

function liquidityFactor({ spread, maxSpreadBps }) {
  if (spread == null) return { strength: 0, detail: 'No quote available', missing: true };

  // Penalty-only: a tight spread is table stakes, not an edge.
  const strength = spread <= maxSpreadBps / 2 ? 0.3 : spread <= maxSpreadBps ? -0.2 : -1;
  const verdict = spread <= maxSpreadBps ? 'acceptable' : `too wide (limit ${maxSpreadBps})`;
  return { strength, detail: `${fmt(spread, 1)} bps spread - ${verdict}` };
}

export function scoreSymbol(inputs) {
  const results = {
    trend: trendFactor(inputs),
    openingRange: openingRangeFactor(inputs),
    volume: volumeFactor(inputs),
    relativeStrength: relativeStrengthFactor(inputs),
    momentum: momentumFactor(inputs),
    liquidity: liquidityFactor(inputs),
  };

  let weighted = 0;
  let totalWeight = 0;
  const factors = FACTORS.map(({ key, label, weight }) => {
    const { strength, detail, missing } = results[key];
    weighted += strength * weight;
    totalWeight += weight;
    return { key, label, weight, strength: Number(strength.toFixed(3)), detail, missing: Boolean(missing) };
  });

  // -1..+1 -> 0..100, so 50 is "no signal either way".
  const technicalScore = Math.round(((weighted / totalWeight) + 1) * 50);

  const missingCount = factors.filter((f) => f.missing).length;
  return { technicalScore, factors, confidence: missingCount === 0 ? 'full' : missingCount <= 2 ? 'partial' : 'poor' };
}

/**
 * Blend the news read into the technical score. Sentiment can move the score by
 * up to 12 points; a veto collapses it outright. News can never be the sole
 * reason to buy - it only adjusts a technical setup that already exists.
 */
export function applyNewsAdjustment(technicalScore, news) {
  if (!news) return { score: technicalScore, adjustment: 0, vetoed: false };

  if (news.veto) {
    return { score: Math.min(technicalScore, 40), adjustment: Math.min(0, 40 - technicalScore), vetoed: true };
  }

  const sentiment = Number.isFinite(news.sentiment) ? Math.max(-1, Math.min(1, news.sentiment)) : 0;
  const adjustment = Math.round(sentiment * 12);
  return { score: Math.max(0, Math.min(100, technicalScore + adjustment)), adjustment, vetoed: false };
}

export function actionForScore(score, minScoreToTrade) {
  if (score >= minScoreToTrade) return 'TRADEABLE';
  if (score >= minScoreToTrade - 15) return 'WATCH';
  return 'AVOID';
}

export { FACTORS };
