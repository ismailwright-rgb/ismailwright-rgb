import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as store from './store.js';
import { buildTradePlan, evaluateTrade, clientOrderId } from './guard.js';
import { resolveSession } from './session.js';
import { tradeWindow } from './windows.js';
import { flags, setFlags } from './runtime.js';
import { manageExits, rememberEntry } from './exits.js';

/**
 * Unattended trading.
 *
 * Every tick takes the freshest analysis, picks the single best candidate, runs
 * it through the same risk guard a human click would, and either places the
 * order or records why it did not. Nothing here bypasses a check that applies to
 * a manual trade - the autopilot is strictly more conservative, never less.
 *
 * READ THIS BEFORE ENABLING IT
 * The scoring has never been validated against history. The factor weights are
 * reasoned, not fitted, and no backtest exists. Automating an unproven strategy
 * does not make it work; it removes the last human check and applies it faster.
 * Run it on paper, read the journal it writes, and decide from that evidence.
 *
 * Every decision - taken or skipped - is journalled with its reasons, because a
 * strategy you cannot audit afterwards is one you can never improve.
 */

const DAY_STATE_KEY = 'autopilot-day';
const JOURNAL_KEY = 'autopilot-journal';
/**
 * AUTOPILOT sets the default; the dashboard toggle overrides it and persists.
 * Requiring a redeploy to stop a trading loop would be a poor kill switch.
 */
export async function isEnabled() {
  return (await flags()).autopilot;
}

/**
 * Turning the autopilot on enables order placement with it. Splitting the two
 * across a button and an environment variable meant the button silently did
 * nothing, which is worse than either choice on its own.
 */
export async function setEnabled(value) {
  const next = Boolean(value);
  await setFlags(next ? { autopilot: true, trading: true } : { autopilot: false });
  await journal({ action: next ? 'enabled' : 'disabled', by: 'dashboard' });
  return next;
}

function todayKey(session) {
  return session.date;
}

async function loadDay(session) {
  const stored = await store.readKey(DAY_STATE_KEY, null);
  if (stored?.date === todayKey(session)) return stored;

  // First tick of a new session: snapshot equity so the loss limit has a base.
  return {
    date: todayKey(session),
    startEquity: null,
    tradesPlaced: 0,
    symbolsTraded: [],
    haltedReason: null,
    flattened: false,
  };
}

const saveDay = (day) => store.writeKey(DAY_STATE_KEY, day);

async function journal(entry) {
  const existing = await store.readKey(JOURNAL_KEY, []);
  const next = [{ ...entry, at: new Date().toISOString() }, ...existing].slice(0, 500);
  await store.writeKey(JOURNAL_KEY, next);
  return next;
}

export const readJournal = () => store.readKey(JOURNAL_KEY, []);
export const readDayState = () => store.readKey(DAY_STATE_KEY, null);

/** Reasons the autopilot will not trade at all right now, regardless of symbol. */
function globalBlockers({ day, session, window, account, positions, analysisAgeSeconds, enabled, trading }) {
  const blockers = [];

  if (!enabled) blockers.push('Autopilot is off.');
  if (!trading) blockers.push('Order placement is off.');
  if (day.haltedReason) blockers.push(`Halted for the day: ${day.haltedReason}`);

  if (!session.isCurrent) blockers.push('Market is closed.');
  else if (session.minutesToClose < config.minMinutesToClose) {
    blockers.push(`Inside the ${config.minMinutesToClose} minute no-new-entries window.`);
  }

  if (window.quality < config.autopilot.minWindowQuality) {
    blockers.push(
      `${window.label} is rated ${window.quality.toFixed(2)}, below the ${config.autopilot.minWindowQuality} the autopilot requires.`,
    );
  }

  if (day.tradesPlaced >= config.autopilot.maxTradesPerDay) {
    blockers.push(`Already placed ${day.tradesPlaced} trades today (limit ${config.autopilot.maxTradesPerDay}).`);
  }

  if (positions.length >= config.maxOpenPositions) {
    blockers.push(`At the ${config.maxOpenPositions} open position limit.`);
  }

  const equity = Number(account.equity) || 0;
  if (day.startEquity) {
    const drawdownPct = ((day.startEquity - equity) / day.startEquity) * 100;
    if (drawdownPct >= config.autopilot.dailyLossLimitPct) {
      blockers.push(
        `Down ${drawdownPct.toFixed(2)}% today, at or past the ${config.autopilot.dailyLossLimitPct}% daily loss limit.`,
      );
    }
  }

  if (!Number.isFinite(analysisAgeSeconds)) {
    blockers.push('No analysis yet — hit Refresh analysis.');
  } else if (analysisAgeSeconds > config.maxAnalysisAgeSeconds) {
    blockers.push(`Analysis is ${Math.round(analysisAgeSeconds)}s old.`);
  }

  return blockers;
}

/**
 * One decision cycle. `runAnalysis` is injected so the caller controls how fresh
 * the data is and so tests can drive it without the network.
 */
export async function tick({ refreshAnalysis, now = Date.now(), dryRun = false }) {
  // Checked before any network call, so an idle loop costs nothing.
  const { autopilot: enabled, trading } = await flags();
  if (!enabled && !dryRun) return { action: 'idle', reason: 'autopilot is off' };

  const resolved = await resolveSession(new Date(now));
  // Recompute against the injected clock so a test can place itself anywhere in
  // the session without waiting for it.
  const session = {
    ...resolved,
    minutesToClose: Math.max(0, (resolved.close.getTime() - now) / 60000),
    isCurrent: now < resolved.close.getTime(),
  };
  const window = tradeWindow(now, { open: session.open, close: session.close });
  const day = await loadDay(session);

  const [account, positions] = await Promise.all([alpaca.getAccount(), alpaca.getPositions()]);
  const equity = Number(account.equity) || 0;

  if (!day.startEquity && equity > 0) {
    day.startEquity = equity;
    await saveDay(day);
  }

  // Manage what is already open BEFORE deciding whether to open anything new.
  // A poor window or a used-up trade cap must never stop a stop from trailing.
  if (positions.length && trading && !dryRun) {
    const exitActions = await manageExits({ now, trading });
    for (const action of exitActions.filter((a) => a.action !== 'hold' && a.action !== 'skip')) {
      await journal({
        action: action.action === 'close' ? 'time-stop' : 'move-stop',
        symbol: action.symbol,
        r: Number(action.r?.toFixed?.(2)),
        stopPrice: action.stopPrice ?? null,
        reason: action.reason,
      });
    }
  }

  // Flat by the close: a day trade that sleeps is no longer a day trade, and an
  // overnight gap can exceed the stop that was sized for intraday moves.
  if (
    session.isCurrent &&
    positions.length > 0 &&
    session.minutesToClose <= config.autopilot.flattenMinutesBeforeClose &&
    !day.flattened &&
    trading &&
    !dryRun
  ) {
    // Equities only: crypto has no close to be flat by, and closing it here
    // would exit a position purely because the stock market shut.
    const equityPositions = positions.filter((p) => !alpaca.normaliseSymbol(p.symbol).endsWith('USD'));
    for (const position of equityPositions) {
      await alpaca.closePosition(position.symbol).catch(() => {});
    }
    day.flattened = true;
    await saveDay(day);
    await store.appendTrade({ symbol: '*', status: 'auto-flattened', count: positions.length });
    return journal({
      action: 'flatten',
      reason: `${Math.round(session.minutesToClose)} minutes to the close`,
      positions: positions.map((p) => p.symbol),
    }).then(() => ({ action: 'flatten', closed: positions.length }));
  }

  // Refresh before deciding, so the guard's freshness check can pass.
  await refreshAnalysis();
  const analysis = store.getAnalysis();
  const analysisAgeSeconds = store.analysisAgeSeconds();

  const blockers = globalBlockers({ day, session, window, account, positions, analysisAgeSeconds, enabled, trading });
  if (blockers.length && !dryRun) {
    await journal({ action: 'skip', scope: 'session', blockers, window: window.key });
    return { action: 'skip', blockers };
  }

  const held = new Set(positions.map((p) => alpaca.normaliseSymbol(p.symbol)));
  const ranked = (analysis?.candidates || [])
    .filter(
      (c) =>
        c.action === 'TRADEABLE' &&
        !held.has(alpaca.normaliseSymbol(c.symbol)) &&
        c.score >= config.autopilot.minScore &&
        // Unattended crypto without a resting stop is a different risk entirely.
        (c.group !== 'crypto' || config.cryptoTrading),
    )
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    const reason = `Nothing scored ${config.autopilot.minScore} or better.`;
    const best = analysis?.candidates?.[0]
      ? `${analysis.candidates[0].symbol} ${analysis.candidates[0].score}`
      : null;
    if (!dryRun) {
      await journal({ action: 'skip', scope: 'candidates', blockers: [reason], best, window: window.key });
    }
    return { action: 'skip', dryRun, blockers: [...blockers, reason], best, window: window.key };
  }

  const candidate = ranked[0];
  const plan = candidate.plan?.viable
    ? candidate.plan
    : buildTradePlan({
        symbol: candidate.symbol,
        entryPrice: candidate.ask || candidate.last,
        atrValue: candidate.atr,
        equity,
      });

  const verdict = evaluateTrade({
    candidate,
    plan,
    account,
    positions,
    session,
    analysisAgeSeconds,
    window,
  });

  if (dryRun) {
    return {
      action: 'dry-run',
      dryRun: true,
      symbol: candidate.symbol,
      score: candidate.score,
      window: window.key,
      wouldTrade: verdict.allowed && blockers.length === 0,
      blockers: [...blockers, ...verdict.blockers],
      warnings: verdict.warnings,
      plan,
      runnerUp: ranked[1] ? `${ranked[1].symbol} ${ranked[1].score}` : null,
    };
  }

  if (!verdict.allowed) {
    await journal({
      action: 'skip',
      scope: 'guard',
      symbol: candidate.symbol,
      score: candidate.score,
      blockers: verdict.blockers,
      window: window.key,
    });
    return { action: 'skip', symbol: candidate.symbol, blockers: verdict.blockers };
  }

  const orderId = clientOrderId(alpaca.normaliseSymbol(candidate.symbol), session.date);
  const order =
    candidate.group === 'crypto'
      ? await alpaca.placeCryptoOrder({
          symbol: candidate.symbol,
          notional: plan.notional,
          clientOrderId: orderId,
        })
      : await alpaca.placeBracketOrder({
          symbol: candidate.symbol,
          qty: plan.qty,
          entryType: 'market',
          stopPrice: plan.stopPrice,
          takeProfitPrice: plan.takeProfitPrice,
          clientOrderId: orderId,
        });

  day.tradesPlaced += 1;
  day.symbolsTraded = [...day.symbolsTraded, candidate.symbol];
  await saveDay(day);

  // Record what this position was sized against so R is meaningful later.
  await rememberEntry(candidate.symbol, {
    entryPrice: plan.entryPrice,
    stopPrice: plan.stopPrice,
    takeProfitPrice: plan.takeProfitPrice,
    riskPerShare: plan.riskPerShare,
    placedAt: new Date(now).toISOString(),
    assetClass: candidate.group === 'crypto' ? 'crypto' : 'equity',
    score: candidate.score,
    factors: candidate.factors,
    window: window.key,
  });

  const entry = {
    symbol: candidate.symbol,
    status: 'submitted',
    source: 'autopilot',
    orderId: order.id,
    qty: plan.qty,
    stopPrice: plan.stopPrice,
    takeProfitPrice: plan.takeProfitPrice,
    notional: plan.notional,
    riskDollars: plan.riskDollars,
    score: candidate.score,
    warnings: verdict.warnings,
  };
  await store.appendTrade(entry);

  await journal({
    action: 'trade',
    symbol: candidate.symbol,
    score: candidate.score,
    window: window.key,
    qty: plan.qty,
    notional: plan.notional,
    riskDollars: plan.riskDollars,
    stopPrice: plan.stopPrice,
    takeProfitPrice: plan.takeProfitPrice,
    thesis: candidate.news?.reasonsFor?.[0] ?? null,
    warnings: verdict.warnings,
  });

  return { action: 'trade', symbol: candidate.symbol, order, plan };
}

/** Stop for the rest of the session. Survives a restart; clears at the next open. */
export async function halt(reason) {
  const session = await resolveSession();
  const day = await loadDay(session);
  day.haltedReason = reason || 'stopped by hand';
  await saveDay(day);
  await journal({ action: 'halt', reason: day.haltedReason });
  return day;
}

export async function resume() {
  const session = await resolveSession();
  const day = await loadDay(session);
  day.haltedReason = null;
  await saveDay(day);
  await journal({ action: 'resume' });
  return day;
}

export async function status() {
  const session = await resolveSession();
  const [day, runtime, account, positions] = await Promise.all([
    loadDay(session),
    flags(),
    alpaca.getAccount().catch(() => ({})),
    alpaca.getPositions().catch(() => []),
  ]);

  const equity = Number(account.equity) || 0;
  const window = tradeWindow(Date.now(), { open: session.open, close: session.close });
  const analysis = store.getAnalysis();

  // Exactly what is stopping it right now, so the panel never just says "idle".
  const blockers = globalBlockers({
    day,
    session,
    window,
    account,
    positions,
    analysisAgeSeconds: store.analysisAgeSeconds(),
    enabled: runtime.autopilot,
    trading: runtime.trading,
  });

  const held = new Set(positions.map((p) => alpaca.normaliseSymbol(p.symbol)));

  // What it would take, in the order it would take them.
  const watching = (analysis?.candidates || [])
    .filter((c) => c.factors?.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((c) => ({
      symbol: c.symbol,
      score: c.score,
      action: c.action,
      held: held.has(c.symbol),
      qualifies: c.action === 'TRADEABLE' && !held.has(c.symbol) && c.score >= config.autopilot.minScore,
      shortfall: Math.max(0, config.autopilot.minScore - c.score),
    }));

  return {
    enabled: runtime.autopilot,
    source: runtime.source.autopilot,
    envDefault: config.autopilot.enabled,
    tradingEnabled: runtime.trading,
    paper: config.isPaper,
    intervalMinutes: config.autopilot.intervalMinutes,
    minScore: config.autopilot.minScore,
    minWindowQuality: config.autopilot.minWindowQuality,
    maxTradesPerDay: config.autopilot.maxTradesPerDay,
    dailyLossLimitPct: config.autopilot.dailyLossLimitPct,
    day,
    window: { key: window.key, label: window.label, quality: window.quality },
    dayPnlPct: day.startEquity && equity ? ((equity - day.startEquity) / day.startEquity) * 100 : null,
    blockers,
    watching,
    positions: positions.map((p) => ({
      symbol: p.symbol,
      qty: Number(p.qty),
      unrealizedPl: Number(p.unrealized_pl),
    })),
  };
}
