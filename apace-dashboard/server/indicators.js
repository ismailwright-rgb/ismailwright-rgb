/**
 * Intraday technical measures, all computed from Alpaca bar objects
 * ({ t, o, h, l, c, v, vw, n }). Every function tolerates short input and
 * returns null rather than a misleading number.
 */

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) {
    value = values[i] * k + value * (1 - k);
  }
  return value;
}

/** Wilder's RSI. */
export function rsi(values, period = 14) {
  if (values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Average True Range over bars. */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prevClose = bars[i - 1].c;
    trueRanges.push(
      Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - prevClose), Math.abs(bars[i].l - prevClose)),
    );
  }
  if (trueRanges.length < period) return null;

  let value = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i += 1) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }
  return value;
}

/** Session VWAP from typical price. Uses each bar's own vw when Alpaca supplies it. */
export function vwap(bars) {
  let pv = 0;
  let volume = 0;
  for (const bar of bars) {
    if (!bar.v) continue;
    const price = bar.vw ?? (bar.h + bar.l + bar.c) / 3;
    pv += price * bar.v;
    volume += bar.v;
  }
  return volume > 0 ? pv / volume : null;
}

/**
 * Opening range: the high/low of the first `minutes` of the session, and where
 * price sits relative to it. The classic day-trade setup is a break and hold
 * above the opening-range high on expanding volume.
 */
export function openingRange(bars, { minutes = 30, barMinutes = 5 } = {}) {
  const barCount = Math.max(1, Math.round(minutes / barMinutes));
  if (bars.length < barCount) return null;

  const window = bars.slice(0, barCount);
  const high = Math.max(...window.map((b) => b.h));
  const low = Math.min(...window.map((b) => b.l));
  const last = bars[bars.length - 1].c;

  let state = 'inside';
  if (last > high) state = 'above';
  else if (last < low) state = 'below';

  const width = high - low;
  return {
    high,
    low,
    state,
    // How far beyond the range price has extended, in units of range width.
    extension: width > 0 ? (state === 'above' ? (last - high) / width : state === 'below' ? (last - low) / width : 0) : 0,
    complete: bars.length > barCount,
  };
}

/**
 * Relative volume: session volume so far versus what an average day would have
 * produced by this point, assuming volume accrues evenly. That last assumption is
 * wrong (real volume is U-shaped) so this reads high near the open - it is a
 * comparative measure across symbols, not an absolute one.
 */
export function relativeVolume(sessionBars, dailyBars, sessionFraction) {
  if (!sessionBars.length || dailyBars.length < 5 || sessionFraction <= 0) return null;

  const sessionVolume = sessionBars.reduce((sum, bar) => sum + (bar.v || 0), 0);
  const recent = dailyBars.slice(-20);
  const avgDaily = recent.reduce((sum, bar) => sum + (bar.v || 0), 0) / recent.length;
  if (!avgDaily) return null;

  return sessionVolume / (avgDaily * sessionFraction);
}

export function percentChange(from, to) {
  if (!from || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

/** Bid-ask spread in basis points - the single best predictor of slippage. */
export function spreadBps(quote) {
  if (!quote) return null;
  const bid = quote.bp;
  const ask = quote.ap;
  if (!bid || !ask || ask <= 0 || bid <= 0) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 10000;
}

/** Fraction of the regular session elapsed, 0..1. */
export function sessionProgress(now, openTime, closeTime) {
  const total = closeTime - openTime;
  if (total <= 0) return 0;
  return Math.min(1, Math.max(0, (now - openTime) / total));
}
