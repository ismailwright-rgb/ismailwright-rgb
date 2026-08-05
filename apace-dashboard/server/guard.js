import { config } from './config.js';

const round2 = (value) => Math.round(value * 100) / 100;

/**
 * Turn a candidate into a concrete bracket order: entry, stop, target, share
 * count. Sizing is risk-first - the stop distance and the equity at risk decide
 * the share count, not a fixed dollar amount.
 */
export function buildTradePlan({ symbol, entryPrice, atrValue, equity, requestedNotional = null }) {
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

  const riskBudget = (equity * config.riskPctPerTrade) / 100;

  // Bracket orders are whole-share only, so the notional cap is applied in shares.
  const maxQtyByNotional = Math.floor(config.maxNotionalPerOrder / entry);

  // A hand-entered amount sets the share count directly; otherwise size from the
  // risk budget. Either way the per-order cap is the last word.
  const custom = Number.isFinite(requestedNotional) && requestedNotional > 0;
  const targetQty = custom
    ? Math.floor(requestedNotional / entry)
    : Math.floor(riskBudget / perShareRisk);
  const qty = Math.min(targetQty, maxQtyByNotional);

  if (qty < 1) {
    return {
      viable: false,
      reason:
        maxQtyByNotional < 1
          ? `one share costs ${entry.toFixed(2)}, above the ${config.maxNotionalPerOrder} per-order cap`
          : custom
            ? `${requestedNotional.toFixed(2)} does not buy a whole share at ${entry.toFixed(2)}`
            : `risking ${riskBudget.toFixed(2)} with a ${perShareRisk.toFixed(2)} stop does not buy a whole share`,
    };
  }

  const riskDollars = round2(qty * perShareRisk);
  const riskPct = equity > 0 ? (riskDollars / equity) * 100 : 0;

  return {
    viable: true,
    entryPrice: entry,
    stopPrice,
    takeProfitPrice,
    qty,
    notional: round2(qty * entry),
    riskDollars,
    riskPct: round2(riskPct),
    riskPerShare: perShareRisk,
    rMultiple: config.targetRMultiple,
    stopDistancePct: round2((perShareRisk / entry) * 100),

    // What the UI needs to explain the number it is showing.
    custom,
    requestedNotional: custom ? round2(requestedNotional) : null,
    cappedByNotional: targetQty > maxQtyByNotional,
    suggestedNotional: round2(Math.min(Math.floor(riskBudget / perShareRisk), maxQtyByNotional) * entry),
    riskBudget: round2(riskBudget),
    overRiskBudget: riskDollars > riskBudget,
    maxRiskDollars: round2((equity * config.maxRiskPctPerTrade) / 100),

    // Echoed so the amount selector can recompute without another round trip.
    equity: round2(equity),
    maxNotional: config.maxNotionalPerOrder,
  };
}

/**
 * Sizing for crypto.
 *
 * Fractional, so it is sized in dollars rather than whole shares. The stop is
 * wider - a 0.3% floor is noise on an asset that routinely moves 3% in an hour -
 * and, critically, it is NOT a resting order: Alpaca will not attach a bracket
 * to crypto, so the stop is only enforced while the exit loop is running.
 */
export function buildCryptoPlan({ symbol, entryPrice, atrValue, equity, requestedNotional = null }) {
  if (!entryPrice || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return { viable: false, reason: 'no usable entry price' };
  }

  const atrStop = Number.isFinite(atrValue) && atrValue > 0 ? atrValue * 1.5 : 0;
  const stopDistance = Math.max(atrStop, entryPrice * 0.01); // 1% floor, not 0.3%
  const stopPct = stopDistance / entryPrice;

  const riskBudget = (equity * config.riskPctPerTrade) / 100;
  const byRisk = riskBudget / stopPct;
  const notional = Math.min(
    Number.isFinite(requestedNotional) && requestedNotional > 0 ? requestedNotional : byRisk,
    config.maxNotionalPerOrderCrypto,
  );

  if (notional < 1) {
    return { viable: false, reason: 'position would be under one dollar' };
  }

  const riskDollars = round2(notional * stopPct);

  return {
    viable: true,
    assetClass: 'crypto',
    entryPrice: round2(entryPrice),
    stopPrice: round2(entryPrice - stopDistance),
    takeProfitPrice: round2(entryPrice + stopDistance * config.targetRMultiple),
    notional: round2(notional),
    qty: Number((notional / entryPrice).toFixed(8)),
    riskDollars,
    riskPct: equity > 0 ? round2((riskDollars / equity) * 100) : 0,
    riskPerShare: round2(stopDistance),
    rMultiple: config.targetRMultiple,
    stopDistancePct: round2(stopPct * 100),
    restingStop: false, // the whole point: nothing protects this at the exchange
    custom: Number.isFinite(requestedNotional) && requestedNotional > 0,
    suggestedNotional: round2(Math.min(byRisk, config.maxNotionalPerOrderCrypto)),
    riskBudget: round2(riskBudget),
    overRiskBudget: riskDollars > riskBudget,
    maxRiskDollars: round2((equity * config.maxRiskPctPerTrade) / 100),
    equity: round2(equity),
    maxNotional: config.maxNotionalPerOrderCrypto,
  };
}

/**
 * Every reason this trade must not happen. Runs server-side at execution time
 * against freshly fetched account state - the browser's payload is never trusted
 * for anything except which symbol was clicked.
 */
export function evaluateTrade({ candidate, plan, account, positions, session, analysisAgeSeconds, window = null }) {
  const blockers = [];
  const warnings = [];

  if (!config.isPaper && !config.allowLive) {
    blockers.push('Live trading endpoint without ALLOW_LIVE - refusing.');
  }

  if (!candidate) {
    blockers.push('Symbol is not in the current analysis.');
    return { allowed: false, blockers, warnings };
  }

  const isCrypto = candidate.group === 'crypto';

  if (isCrypto) {
    if (!config.cryptoWatchlist.includes(candidate.symbol)) {
      blockers.push(`${candidate.symbol} is not on the configured crypto watchlist.`);
    }
    if (!config.cryptoTrading) {
      blockers.push(
        'Crypto trading is off. Alpaca will not hold a stop on a crypto order, so the exit loop enforces it ' +
          'by checking price every minute and closing the position itself. That is a polled stop, not a resting ' +
          'one - a fast move can gap through it. Set CRYPTO_TRADING=true to accept that trade-off.',
      );
    }
  } else if (!config.watchlist.includes(candidate.symbol)) {
    blockers.push(`${candidate.symbol} is not on the configured watchlist.`);
  }

  if (!Number.isFinite(analysisAgeSeconds)) {
    blockers.push('No analysis yet. Refresh before trading.');
  } else if (analysisAgeSeconds > config.maxAnalysisAgeSeconds) {
    blockers.push(
      `Analysis is ${Math.round(analysisAgeSeconds)}s old (limit ${config.maxAnalysisAgeSeconds}s). Refresh before trading.`,
    );
  }

  if (isCrypto) {
    // 24/7: no close to be flat by, and crypto does not count as a day trade.
  } else if (!session.isCurrent) {
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
  if (isCrypto) {
    // PDT applies to securities, not crypto.
  } else if (equity < 25000 && dayTrades >= 3) {
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
    const cap = isCrypto ? config.maxNotionalPerOrderCrypto : config.maxNotionalPerOrder;
    if (plan.notional > cap) {
      blockers.push(`Order notional ${plan.notional} exceeds the ${cap} cap.`);
    }

    // A hand-entered amount can imply far more risk than the default sizing.
    // Allowed up to a hard ceiling, refused beyond it.
    if (plan.riskDollars > plan.maxRiskDollars) {
      blockers.push(
        `That amount risks ${plan.riskDollars.toFixed(2)} to the stop, above the ${config.maxRiskPctPerTrade}% of equity ceiling (${plan.maxRiskDollars.toFixed(2)}).`,
      );
    } else if (plan.overRiskBudget) {
      warnings.push(
        `This risks ${plan.riskDollars.toFixed(2)} (${plan.riskPct}% of equity), above your ${config.riskPctPerTrade}% target of ${plan.riskBudget.toFixed(2)}.`,
      );
    }

    if (plan.cappedByNotional) {
      warnings.push(`Reduced to ${plan.qty} shares by the ${config.maxNotionalPerOrder} per-order cap.`);
    }
  }

  // Timing is advisory, never a blocker - the score and the guard already decide
  // whether the setup is valid; this says whether the clock is on your side.
  if (window && window.quality < 0.4 && window.quality > 0) {
    warnings.push(
      `${window.label}: ${window.note}${window.bestRemaining ? ` ${window.bestRemaining.label} begins in ${window.bestRemaining.inMinutes} min.` : ''}`,
    );
  }

  if (candidate.dataQuality?.partial) {
    warnings.push('Some indicators were computed from incomplete data.');
  }

  return { allowed: blockers.length === 0, blockers, warnings };
}

export function clientOrderId(symbol, sessionDate) {
  return `apace-${symbol}-${sessionDate}-${Date.now().toString(36)}`;
}
