import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as ind from './indicators.js';
import { scoreSymbol, actionForScore } from './score.js';
import { tradeWindow } from './windows.js';
import { decideExit } from './exits.js';
import { zonedToUtc } from './session.js';

/**
 * Replays the strategy over history, bar by bar, with the same scoring, the same
 * window gate and the same exit policy the live autopilot uses.
 *
 * WHAT THIS DOES NOT MODEL
 *  - News. The model's read of headlines cannot be replayed cheaply, so scores
 *    here are technicals only. Live scores can differ by up to 12 points either
 *    way, and a veto can remove a candidate entirely.
 *  - Real spreads. Historical quotes are not fetched; a fixed assumption stands
 *    in, so the liquidity factor contributes a constant rather than a measurement.
 *  - Fills. Entries are taken at the next bar's open plus slippage. A real market
 *    order in a fast tape can do worse.
 *  - Partial fills, halts, and borrow availability.
 *
 * When a stop and a target both sit inside one bar, the stop is assumed to hit
 * first. That is the pessimistic reading and the honest one - intrabar sequence
 * is unknowable from OHLC.
 *
 * The result is an estimate with a known bias, not a promise. Treat a losing
 * backtest as decisive and a winning one as permission to paper trade.
 */

const BAR_MS = 5 * 60 * 1000;
const BENCHMARK = 'SPY';

function groupBySession(bars, sessions) {
  const bySession = new Map();
  for (const session of sessions) {
    bySession.set(
      session.date,
      bars.filter((bar) => bar.time >= session.open && bar.time <= session.close),
    );
  }
  return bySession;
}

async function loadSessions(days) {
  const end = new Date();
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().slice(0, 10);

  const calendar = await alpaca.getCalendar({ start: iso(start), end: iso(end) });
  return calendar
    .map((day) => ({
      date: day.date,
      open: zonedToUtc(day.date, day.open),
      close: zonedToUtc(day.date, day.close),
    }))
    .filter((session) => session.close <= new Date());
}

export async function runBacktest({
  days = 30,
  symbols = config.watchlist,
  minScore = config.autopilot.minScore,
  minWindowQuality = config.autopilot.minWindowQuality,
  maxTradesPerDay = config.autopilot.maxTradesPerDay,
  slippageBps = 5,
  assumedSpreadBps = 6,
  onProgress = () => {},
} = {}) {
  const universe = Array.from(new Set([...symbols, BENCHMARK]));
  const sessions = await loadSessions(days);
  if (!sessions.length) throw new Error('no completed sessions in that window');

  onProgress(`fetching ${universe.length} symbols over ${sessions.length} sessions…`);

  const start = sessions[0].open.toISOString();
  const [intraday, daily] = await Promise.all([
    alpaca.getIntradayBars(universe, { timeframe: '5Min', start }),
    alpaca.getDailyBars(universe, { days: days + 40 }),
  ]);

  const parsed = {};
  for (const symbol of universe) {
    parsed[symbol] = (intraday[symbol] || [])
      .map((bar) => ({ ...bar, time: new Date(bar.t) }))
      .sort((a, b) => a.time - b.time);
  }

  const sessionBars = {};
  for (const symbol of universe) sessionBars[symbol] = groupBySession(parsed[symbol], sessions);

  const trades = [];
  const skipped = { window: 0, noCandidate: 0, cap: 0 };

  for (const session of sessions) {
    const benchBars = sessionBars[BENCHMARK].get(session.date) || [];
    if (benchBars.length < 12) continue;

    let open = null; // one position at a time, as the autopilot runs it
    let tradesToday = 0;

    const totalBars = benchBars.length;

    for (let i = 6; i < totalBars; i += 1) {
      const now = benchBars[i].time.getTime();
      const window = tradeWindow(now, { open: session.open, close: session.close });

      /* ---- manage an open position first ---- */
      if (open) {
        const bar = (sessionBars[open.symbol].get(session.date) || [])[i];
        if (bar) {
          // Pessimistic: if the bar spans the stop, assume the stop filled.
          if (bar.l <= open.stopPrice) {
            trades.push(closeTrade(open, open.stopPrice, now, 'stop', slippageBps));
            open = null;
          } else if (bar.h >= open.takeProfitPrice) {
            trades.push(closeTrade(open, open.takeProfitPrice, now, 'target', slippageBps));
            open = null;
          } else {
            const decision = decideExit({
              entryPrice: open.entryPrice,
              currentPrice: bar.c,
              riskPerShare: open.riskPerShare,
              currentStop: open.stopPrice,
              minutesHeld: (now - open.openedAt) / 60000,
            });
            if (decision.action === 'close') {
              trades.push(closeTrade(open, bar.c, now, 'time-stop', slippageBps));
              open = null;
            } else if (decision.action === 'move-stop') {
              open.stopPrice = decision.stopPrice;
              open.stopMoves = (open.stopMoves || 0) + 1;
            }
          }
        }

        // Flat by the close, exactly as the autopilot does.
        if (open && window.minutesToClose <= config.autopilot.flattenMinutesBeforeClose) {
          const bar = (sessionBars[open.symbol].get(session.date) || [])[i];
          trades.push(closeTrade(open, bar ? bar.c : open.entryPrice, now, 'close-flat', slippageBps));
          open = null;
        }
      }

      /* ---- look for an entry ---- */
      if (open) continue;
      if (window.quality < minWindowQuality) {
        skipped.window += 1;
        continue;
      }
      if (window.minutesToClose < config.minMinutesToClose) continue;
      if (tradesToday >= maxTradesPerDay) {
        skipped.cap += 1;
        continue;
      }

      const benchmarkChangePct = ind.percentChange(benchBars[0].o, benchBars[i].c);
      const elapsed = Math.max((i + 1) / totalBars, 0.05);

      let best = null;
      for (const symbol of symbols) {
        const all = sessionBars[symbol]?.get(session.date) || [];
        // Only bars up to and including now. No lookahead.
        const bars = all.slice(0, i + 1);
        if (bars.length < 12) continue;

        const closes = bars.map((b) => b.c);
        const last = closes[closes.length - 1];
        const dailyBars = (daily[symbol] || []).filter((b) => new Date(b.t) < session.open);

        const { technicalScore } = scoreSymbol({
          ema9: ind.ema(closes, 9),
          ema20: ind.ema(closes, 20),
          last,
          vwapValue: ind.vwap(bars),
          orb: ind.openingRange(bars, { minutes: 30, barMinutes: 5 }),
          rvol: ind.relativeVolume(bars, dailyBars, elapsed),
          symbolChangePct: ind.percentChange(bars[0].o, last),
          benchmarkChangePct,
          rsiValue: ind.rsi(closes, 14),
          spread: assumedSpreadBps,
          maxSpreadBps: config.maxSpreadBps,
        });

        if (actionForScore(technicalScore, config.minScoreToTrade) !== 'TRADEABLE') continue;
        if (technicalScore < minScore) continue;
        if (!best || technicalScore > best.score) {
          best = { symbol, score: technicalScore, bars, atr: ind.atr(bars, 14), last };
        }
      }

      if (!best) {
        skipped.noCandidate += 1;
        continue;
      }

      // Enter at the NEXT bar's open: the decision is made on a closed bar.
      const nextBar = (sessionBars[best.symbol].get(session.date) || [])[i + 1];
      if (!nextBar) continue;

      const fill = nextBar.o * (1 + slippageBps / 10000);
      const stopDistance = Math.max((best.atr || 0) * 1.5, fill * 0.003, 0.02);
      const entryPrice = Math.round(fill * 100) / 100;
      const stopPrice = Math.round((entryPrice - stopDistance) * 100) / 100;
      const riskPerShare = Math.round((entryPrice - stopPrice) * 100) / 100;
      if (riskPerShare <= 0) continue;

      open = {
        symbol: best.symbol,
        date: session.date,
        score: best.score,
        window: window.key,
        entryPrice,
        stopPrice,
        takeProfitPrice: Math.round((entryPrice + riskPerShare * config.targetRMultiple) * 100) / 100,
        riskPerShare,
        openedAt: nextBar.time.getTime(),
        stopMoves: 0,
      };
      tradesToday += 1;
    }

    if (open) {
      const bars = sessionBars[open.symbol].get(session.date) || [];
      const lastBar = bars[bars.length - 1];
      trades.push(closeTrade(open, lastBar ? lastBar.c : open.entryPrice, session.close.getTime(), 'close-flat', slippageBps));
      open = null;
    }

    onProgress(`${session.date}: ${trades.filter((t) => t.date === session.date).length} trades`);
  }

  return summarise(trades, { sessions: sessions.length, skipped, days, minScore, slippageBps, assumedSpreadBps });
}

function closeTrade(open, exitPrice, exitAt, reason, slippageBps) {
  const slipped = reason === 'stop' || reason === 'time-stop' || reason === 'close-flat'
    ? exitPrice * (1 - slippageBps / 10000)
    : exitPrice;

  const r = (slipped - open.entryPrice) / open.riskPerShare;
  return {
    ...open,
    exitPrice: Math.round(slipped * 100) / 100,
    exitAt,
    reason,
    r: Number(r.toFixed(3)),
    minutesHeld: Math.round((exitAt - open.openedAt) / 60000),
  };
}

function summarise(trades, meta) {
  const wins = trades.filter((t) => t.r > 0);
  const losses = trades.filter((t) => t.r <= 0);
  const totalR = trades.reduce((sum, t) => sum + t.r, 0);

  // Drawdown measured on the cumulative R curve.
  let peak = 0;
  let cumulative = 0;
  let maxDrawdown = 0;
  const curve = [];
  for (const trade of trades) {
    cumulative += trade.r;
    curve.push({ at: trade.exitAt, r: Number(cumulative.toFixed(3)) });
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.min(maxDrawdown, cumulative - peak);
  }

  const by = (key) => {
    const groups = {};
    for (const trade of trades) {
      const k = trade[key];
      (groups[k] ||= { trades: 0, totalR: 0, wins: 0 });
      groups[k].trades += 1;
      groups[k].totalR += trade.r;
      if (trade.r > 0) groups[k].wins += 1;
    }
    return Object.entries(groups)
      .map(([k, v]) => ({
        [key]: k,
        trades: v.trades,
        winRate: v.trades ? (v.wins / v.trades) * 100 : 0,
        totalR: Number(v.totalR.toFixed(2)),
        avgR: Number((v.totalR / v.trades).toFixed(3)),
      }))
      .sort((a, b) => b.totalR - a.totalR);
  };

  return {
    ...meta,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? Number(((wins.length / trades.length) * 100).toFixed(1)) : 0,
    totalR: Number(totalR.toFixed(2)),
    avgR: trades.length ? Number((totalR / trades.length).toFixed(3)) : 0,
    avgWinR: wins.length ? Number((wins.reduce((s, t) => s + t.r, 0) / wins.length).toFixed(3)) : 0,
    avgLossR: losses.length ? Number((losses.reduce((s, t) => s + t.r, 0) / losses.length).toFixed(3)) : 0,
    maxDrawdownR: Number(maxDrawdown.toFixed(2)),
    byReason: by('reason'),
    bySymbol: by('symbol').slice(0, 12),
    byWindow: by('window'),
    curve,
    tradeList: trades,
  };
}
