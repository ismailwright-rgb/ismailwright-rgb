import { config } from './config.js';

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Turn a candidate into a concrete bracket order: entry, stop, target, share
 * count. Sizing is risk-first - the stop distance and the equity at risk decide
 * the share count, not a fixed dollar amount.
 */
export function buildTradePlan({ symbol, entryPrice, atrValue, equity }) {
  if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { viable: false, reason: 'no usable entry price' };
  }

  // Everything derives from a penny-rounded entry, so the ratios the UI shows are
  // the ratios the exchange will actually see.
  const entry = round2(entryPrice);

  // Floor the stop at 0.30% and at two cents, so neither a quiet tape nor a
  // low-priced stock produces a stop that the spread alone would take out.
  const atrStop = Number.isFinite(atrValue) && atrValue > 0 ? atrValue * 1.5 : 0;
  const stopDistance = Math.max(atrStop, entry * 0.003, 0.02);

  const stopPrice = round2(entry - stopDistance);
  if (stopPrice <= 0 || stopPrice >= entry) {
    return { viable: false, reason: 'stop price did not resolve above zero and below entry' };
  }

  // Take the R multiple off the ROUNDED stop. Deriving it from the unrounded
  // distance silently inflates the ratio on cheap stocks, where one cent of
  // rounding is a large fraction of the risk.
  const perShareRisk = round2(entry - stopPrice);
  const takeProfitPrice = round2(entry + perShareRisk * config.targetRMultiple);

  if (perShareRisk / entry < 0.0015) {
    return { viable: false, reason: 'stop would sit within a cent or two of entry, which is not a real stop' };
  }

  const riskDollars = (equity * config.riskPctPerTrade) / 100;

  // Bracket orders are whole-share only, so the notional cap is applied in shares.
  const maxQtyByNotional = Math.floor(config.maxNotionalPerOrder / entry);
  const qty = Math.min(Math.floor(riskDollars / perShareRisk), maxQtyByNotional);

  if (qty < 1) {
    return {
      viable: false,
      reason:
        maxQtyByNotional < 1
          ? `one share costs ${entry.toFixed(2)}, above the ${config.maxNotionalPerOrder} per-order cap`
          : `risking ${riskDollars.toFixed(2)} with a ${perShareRisk.toFixed(2)} stop does not buy a whole share`,
    };
  }

  return {
    viable: true,
    entryPrice: entry,
    stopPrice,
    takeProfitPrice,
    qty,
    notional: round2(qty * entry),
    riskDollars: round2(qty * perShareRisk),
    riskPerShare: perShareRisk,
    rMultiple: config.targetRMultiple,
    stopDistancePct: round2((perShareRisk / entry) * 100),
  };
}

/**
 * Every reason this trade must not happen. Runs server-side at execution time
 * against freshly fetched account state - the browser's payload is never trusted
 * for anything except which symbol was clicked.
 */
export function evaluateTrade({ candidate, plan, account, positions, session, analysisAgeSeconds }) {
  const blockers = [];
  const warnings = [];

  if (!config.isPaper && !config.allowLive) {
    blockers.push('Live trading endpoint without ALLOW_LIVE - refusing.');
  }

  if (!candidate) {
    blockers.push('Symbol is not in the current analysis.');
    return { allowed: false, blockers, warnings };
  }

  if (!config.watchlist.includes(candidate.symbol)) {
    blockers.push(`${candidate.symbol} is not on the configured watchlist.`);
  }

  if (analysisAgeSeconds > config.maxAnalysisAgeSeconds) {
    blockers.push(
      `Analysis is ${Math.round(analysisAgeSeconds)}s old (limit ${config.maxAnalysisAgeSeconds}s). Refresh before trading.`,
    );
  }

  if (!session.isCurrent) {
    blockers.push('The market is closed. This view is showing the last completed session.');
  } else if (session.minutesToClose < config.minMinutesToClose) {
    blockers.push(
      `Only ${Math.round(session.minutesToClose)} minutes to the close - inside the ${config.minMinutesToClose} minute no-new-entries window.`,
    );
  }

  if (candidate.score < config.minScoreToTrade) {
    blockers.push(`Score ${candidate.score} is below the ${config.minScoreToTrade} threshold.`);
  }

  if (candidate.news?.veto) {
    blockers.push(`News veto: ${candidate.news.vetoReason || 'flagged as disqualifying'}.`);
  }

  if (candidate.spreadBps != null && candidate.spreadBps > config.maxSpreadBps) {
    blockers.push(`Spread ${candidate.spreadBps.toFixed(1)} bps exceeds the ${config.maxSpreadBps} bps limit.`);
  }

  if (positions.some((p) => p.symbol === candidate.symbol)) {
    blockers.push(`Already holding ${candidate.symbol}. This dashboard does not add to positions.`);
  }

  if (positions.length >= config.maxOpenPositions) {
    blockers.push(`Already at ${positions.length} open positions (limit ${config.maxOpenPositions}).`);
  }

  // Pattern day trader: under 25k equity, a fourth day trade in five business
  // days restricts the account. Alpaca enforces this on paper accounts too.
  const equity = Number(account.equity);
  const dayTrades = Number(account.daytrade_count ?? 0);
  if (equity < 25000 && dayTrades >= 3) {
    blockers.push(`PDT limit: ${dayTrades} day trades used in the last 5 sessions with equity under $25k.`);
  } else if (equity < 25000 && dayTrades === 2) {
    warnings.push('This would be your third day trade in five sessions - one away from the PDT limit.');
  }

  if (!plan.viable) {
    blockers.push(`Cannot size the position: ${plan.reason}.`);
  } else {
    const buyingPower = Number(account.buying_power);
    if (Number.isFinite(buyingPower) && plan.notional > buyingPower) {
      blockers.push(`Order notional ${plan.notional} exceeds buying power ${buyingPower}.`);
    }
    if (plan.notional > config.maxNotionalPerOrder) {
      blockers.push(`Order notional ${plan.notional} exceeds the ${config.maxNotionalPerOrder} cap.`);
    }
  }

  if (candidate.dataQuality?.partial) {
    warnings.push('Some indicators were computed from incomplete data.');
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

export function clientOrderId(symbol, sessionDate) {
  return `apace-${symbol}-${sessionDate}-${Date.now().toString(36)}`;
}
