import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as ind from './indicators.js';
import { scoreSymbol, scoreCrypto, applyNewsAdjustment, actionForScore } from './score.js';
import { analyzeNews } from './llm.js';
import { buildTradePlan, buildCryptoPlan } from './guard.js';
import { resolveSession } from './session.js';
import { tradeWindow } from './windows.js';
import { describe, correlatedWith } from './universe.js';

const BENCHMARK = 'SPY';

/** Bars that fall inside the regular session window. */
function sessionBarsFor(bars, session) {
  return (bars || [])
    .map((bar) => ({ ...bar, time: new Date(bar.t) }))
    .filter((bar) => bar.time >= session.open && bar.time <= session.close)
    .sort((a, b) => a.time - b.time);
}

export async function runAnalysis() {
  const startedAt = Date.now();
  const symbols = Array.from(new Set([...config.watchlist, BENCHMARK]));
  const session = await resolveSession();

  const crypto = config.cryptoWatchlist;

  const [account, positions, quotes, intraday, daily, news, cryptoQuotes, cryptoBars] = await Promise.all([
    alpaca.getAccount(),
    alpaca.getPositions(),
    alpaca.getLatestQuotes(symbols),
    alpaca.getIntradayBars(symbols, { timeframe: '5Min', start: session.open.toISOString() }),
    alpaca.getDailyBars(symbols, { days: 45 }),
    alpaca.getNews(config.watchlist).catch(() => ({})),
    alpaca.getCryptoQuotes(crypto).catch(() => ({})),
    alpaca.getCryptoBars(crypto, { timeframe: '5Min', hoursBack: 48 }).catch(() => ({})),
  ]);

  const progress = ind.sessionProgress(Date.now(), session.open.getTime(), session.close.getTime());
  const elapsed = session.isCurrent ? Math.max(progress, 0.05) : 1;

  // The benchmark's session move, so relative strength means something.
  const benchmarkBars = sessionBarsFor(intraday[BENCHMARK], session);
  const benchmarkChangePct = benchmarkBars.length
    ? ind.percentChange(benchmarkBars[0].o, benchmarkBars[benchmarkBars.length - 1].c)
    : null;

  const heldSymbols = new Set(positions.map((p) => alpaca.normaliseSymbol(p.symbol)));
  const isHeld = (symbol) => heldSymbols.has(alpaca.normaliseSymbol(symbol));
  const candidates = [];

  for (const symbol of config.watchlist) {
    const bars = sessionBarsFor(intraday[symbol], session);
    const dailyBars = daily[symbol] || [];

    const meta = describe(symbol);

    if (!bars.length) {
      candidates.push({
        symbol,
        group: meta.group,
        instrumentNote: meta.note,
        tradable: false,
        score: 0,
        action: 'NO DATA',
        note: `No ${config.feed.toUpperCase()} bars for this session`,
        factors: [],
        news: null,
        sparkline: [],
      });
      continue;
    }

    const closes = bars.map((b) => b.c);
    const last = closes[closes.length - 1];
    const open = bars[0].o;
    const priorClose = dailyBars.length >= 2 ? dailyBars[dailyBars.length - 2].c : null;
    const quote = quotes[symbol];

    const vwapValue = ind.vwap(bars);
    const atrValue = ind.atr(bars, 14);
    const orb = ind.openingRange(bars, { minutes: 30, barMinutes: 5 });
    const rvol = ind.relativeVolume(bars, dailyBars, elapsed);
    const spread = ind.spreadBps(quote);
    const symbolChangePct = ind.percentChange(open, last);

    const { technicalScore, factors, confidence } = scoreSymbol({
      ema9: ind.ema(closes, 9),
      ema20: ind.ema(closes, 20),
      last,
      vwapValue,
      orb,
      rvol,
      symbolChangePct,
      benchmarkChangePct,
      rsiValue: ind.rsi(closes, 14),
      spread,
      maxSpreadBps: config.maxSpreadBps,
    });

    candidates.push({
      symbol,
      group: meta.group,
      instrumentNote: meta.note,
      correlatedWith: correlatedWith(symbol),
      last,
      open,
      priorClose,
      gapPct: priorClose ? ind.percentChange(priorClose, open) : null,
      changePct: symbolChangePct,
      vwap: vwapValue,
      vwapDistPct: vwapValue ? ind.percentChange(vwapValue, last) : null,
      atr: atrValue,
      rvol,
      spreadBps: spread,
      bid: quote?.bp ?? null,
      ask: quote?.ap ?? null,
      orb,
      technicalScore,
      score: technicalScore,
      factors,
      dataQuality: { partial: confidence !== 'full', level: confidence, bars: bars.length },
      held: isHeld(symbol),
      news: null,
      newsArticles: (news[symbol] || []).slice(0, 5),
      sparkline: bars.slice(-78).map((b) => ({ t: b.time.toISOString(), c: b.c })),
    });
  }

  /* --- crypto ---------------------------------------------------------------
   * No session, so nothing here is bounded by the open: "today" is the last 24
   * hours and the reference range is the 24 hours before that. BTC stands in for
   * SPY as the benchmark, since that is what the rest of the market follows.
   */
  const cryptoSeries = {};
  for (const symbol of crypto) {
    cryptoSeries[symbol] = (cryptoBars[symbol] || [])
      .map((bar) => ({ ...bar, time: new Date(bar.t) }))
      .sort((a, b) => a.time - b.time);
  }

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const btcBars = cryptoSeries['BTC/USD'] || [];
  const btcRecent = btcBars.filter((b) => b.time.getTime() >= dayAgo);
  const btcChangePct = btcRecent.length ? ind.percentChange(btcRecent[0].o, btcRecent[btcRecent.length - 1].c) : null;

  for (const symbol of crypto) {
    const all = cryptoSeries[symbol];
    const meta = describe(symbol);

    if (all.length < 20) {
      candidates.push({
        symbol,
        group: 'crypto',
        instrumentNote: meta.note,
        tradable: false,
        score: 0,
        action: 'NO DATA',
        note: 'No crypto bars returned',
        factors: [],
        news: null,
        sparkline: [],
      });
      continue;
    }

    const recent = all.filter((b) => b.time.getTime() >= dayAgo);
    const prior = all.filter((b) => b.time.getTime() < dayAgo);
    const closes = recent.map((b) => b.c);
    const last = closes[closes.length - 1];
    const quote = cryptoQuotes[symbol];

    const priorHigh = prior.length ? Math.max(...prior.map((b) => b.h)) : null;
    const priorLow = prior.length ? Math.min(...prior.map((b) => b.l)) : null;

    // Volume baseline: this 24h against the average 24h over the window held.
    const dayVolume = recent.reduce((sum, b) => sum + (b.v || 0), 0);
    const priorVolume = prior.reduce((sum, b) => sum + (b.v || 0), 0);
    const priorDays = prior.length ? prior.length / Math.max(recent.length, 1) : 0;
    const rvol = priorDays > 0 && priorVolume > 0 ? dayVolume / (priorVolume / priorDays) : null;

    const changePct = recent.length ? ind.percentChange(recent[0].o, last) : null;
    const spread = ind.spreadBps(quote ? { bp: quote.bp, ap: quote.ap } : null);

    const { technicalScore, factors, confidence } = scoreCrypto({
      ema9: ind.ema(closes, 9),
      ema20: ind.ema(closes, 20),
      last,
      vwapValue: ind.vwap(recent),
      priorHigh,
      priorLow,
      rvol,
      symbolChangePct: changePct,
      // BTC is its own benchmark, so it is measured against a flat line.
      benchmarkChangePct: symbol === 'BTC/USD' ? 0 : btcChangePct,
      rsiValue: ind.rsi(closes, 14),
      spread,
      maxSpreadBps: config.maxSpreadBps,
    });

    candidates.push({
      symbol,
      group: 'crypto',
      instrumentNote: meta.note,
      correlatedWith: correlatedWith(symbol),
      last,
      open: recent[0]?.o ?? null,
      changePct,
      vwap: ind.vwap(recent),
      vwapDistPct: ind.vwap(recent) ? ind.percentChange(ind.vwap(recent), last) : null,
      atr: ind.atr(recent, 14),
      rvol,
      spreadBps: spread,
      bid: quote?.bp ?? null,
      ask: quote?.ap ?? null,
      priorHigh,
      priorLow,
      technicalScore,
      score: technicalScore,
      factors,
      dataQuality: { partial: confidence !== 'full', level: confidence, bars: recent.length },
      held: isHeld(symbol),
      news: null,
      newsArticles: [],
      sparkline: recent.slice(-96).map((b) => ({ t: b.time.toISOString(), c: b.c })),
    });
  }

  // Only spend model tokens on names that could plausibly be traded.
  const shortlist = candidates
    .filter((c) => c.factors.length && c.technicalScore >= config.minScoreToTrade - 20)
    .sort((a, b) => b.technicalScore - a.technicalScore)
    .slice(0, 8)
    .map((c) => ({
      symbol: c.symbol,
      last: c.last,
      technicalScore: c.technicalScore,
      factors: c.factors,
      news: c.newsArticles,
    }));

  // Inside a serverless request the whole run shares one short budget. If the
  // data fetches have already eaten it, return the technicals rather than
  // spending what is left on the model and timing the request out.
  const elapsedMs = Date.now() - startedAt;
  const budgetSpent = config.isServerless && elapsedMs > 6000;
  const newsRead = budgetSpent
    ? { available: false, reason: `skipped: data fetches took ${(elapsedMs / 1000).toFixed(1)}s`, bySymbol: {} }
    : await analyzeNews(shortlist);

  const equity = Number(account.equity) || 0;
  for (const candidate of candidates) {
    if (!candidate.factors?.length) continue;

    const read = newsRead.bySymbol[candidate.symbol] || null;
    candidate.news = read;

    const { score, adjustment, vetoed } = applyNewsAdjustment(candidate.technicalScore, read);
    candidate.score = score;
    candidate.newsAdjustment = adjustment;
    candidate.vetoed = vetoed;
    candidate.action = candidate.held ? 'HELD' : actionForScore(score, config.minScoreToTrade);

    // Price the entry off the ask - that is what a market buy actually pays.
    const entryPrice = candidate.ask || candidate.last;
    candidate.plan =
      candidate.group === 'crypto'
        ? buildCryptoPlan({ symbol: candidate.symbol, entryPrice, atrValue: candidate.atr, equity })
        : buildTradePlan({ symbol: candidate.symbol, entryPrice, atrValue: candidate.atr, equity });
  }

  candidates.sort((a, b) => b.score - a.score);

  return {
    generatedAt: new Date().toISOString(),
    tookMs: Date.now() - startedAt,
    window: tradeWindow(Date.now(), { open: session.open, close: session.close }),
    session: {
      date: session.date,
      open: session.open.toISOString(),
      close: session.close.toISOString(),
      isCurrent: session.isCurrent,
      minutesToClose: Math.round(session.minutesToClose),
      halfDay: session.halfDay,
      progress: Number(progress.toFixed(3)),
    },
    account: {
      equity,
      buyingPower: Number(account.buying_power) || 0,
      cash: Number(account.cash) || 0,
      dayTradeCount: Number(account.daytrade_count ?? 0),
      patternDayTrader: Boolean(account.pattern_day_trader),
      pdtRestricted: equity < 25000,
    },
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      avgEntry: Number(p.avg_entry_price),
      current: Number(p.current_price),
      unrealizedPl: Number(p.unrealized_pl),
      unrealizedPlPct: Number(p.unrealized_plpc) * 100,
    })),
    benchmark: { symbol: BENCHMARK, changePct: benchmarkChangePct },
    newsRead: { available: newsRead.available, reason: newsRead.reason || null, model: newsRead.model || null },
    dataFeed: config.feed,
    cryptoTrading: config.cryptoTrading,
    limits: {
      minScoreToTrade: config.minScoreToTrade,
      maxNotionalPerOrderCrypto: config.maxNotionalPerOrderCrypto,
      maxNotionalPerOrder: config.maxNotionalPerOrder,
      maxOpenPositions: config.maxOpenPositions,
      maxSpreadBps: config.maxSpreadBps,
      riskPctPerTrade: config.riskPctPerTrade,
      maxRiskPctPerTrade: config.maxRiskPctPerTrade,
      minMinutesToClose: config.minMinutesToClose,
      targetRMultiple: config.targetRMultiple,
      maxAnalysisAgeSeconds: config.maxAnalysisAgeSeconds,
    },
    mode: config.isPaper ? 'paper' : 'live',
    candidates,
  };
}
