import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as store from './store.js';

/**
 * Managing a position after it is open.
 *
 * The bracket placed at entry is a floor, not a plan: a fixed stop and a fixed
 * target give back every open profit on a trade that runs and then reverses.
 * These rules ratchet the stop upward as the trade works, so a winner cannot
 * turn into a loser, and cut a position that is going nowhere before it has the
 * chance to become one.
 *
 * Everything is measured in R - one R is the dollar risk per share the position
 * was sized against, so the same rules apply to a $2 stock and a $600 one.
 *
 *   +1.0R   stop moves to breakeven      the trade can no longer cost anything
 *   +1.5R   stop trails 0.75R behind      further gains are locked in as they come
 *   45 min  under +0.3R, close it         capital stops sitting in a dead trade
 *
 * The stop only ever moves up. A ratchet that could loosen would not be a stop.
 */

const CONTEXT_KEY = 'trade-context';

/** Remember what a position was sized against, so R means something later. */
export async function rememberEntry(
  symbol,
  { entryPrice, stopPrice, takeProfitPrice, riskPerShare, placedAt, assetClass = 'equity', score = null, factors = null, window = null },
) {
  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  // Keyed on the normalised symbol: Alpaca reports "BTCUSD" where we said "BTC/USD".
  context[alpaca.normaliseSymbol(symbol)] = {
    symbol,
    assetClass,
    entryPrice,
    stopPrice,
    takeProfitPrice,
    riskPerShare,
    placedAt: placedAt || new Date().toISOString(),
    breakevenMoved: false,
    trailing: false,
    // What the entry believed at the time. Kept so the closed trade can be
    // graded against the reasons it was taken, rather than just its P&L.
    score,
    window,
    factors: factors ? factors.map((f) => ({ key: f.key, strength: f.strength })) : null,
  };
  await store.writeKey(CONTEXT_KEY, context);
  return context[alpaca.normaliseSymbol(symbol)];
}

export const readContext = () => store.readKey(CONTEXT_KEY, {});

const OUTCOMES_KEY = 'outcomes';

export const readOutcomes = () => store.readKey(OUTCOMES_KEY, []);

/**
 * A position we were tracking is gone, so it closed - by stop, target, time
 * stop, flatten, or by hand. Record the result against what the entry believed.
 *
 * This is the only place the system learns anything. A journal of decisions
 * tells you what it did; this tells you whether it worked, and which factors
 * were pointing the right way when it did.
 */
async function recordOutcome(ctx, exitPrice) {
  if (!ctx || !(ctx.riskPerShare > 0)) return;

  const outcomes = (await store.readKey(OUTCOMES_KEY, [])) || [];
  const r = (exitPrice - ctx.entryPrice) / ctx.riskPerShare;

  outcomes.unshift({
    symbol: ctx.symbol,
    assetClass: ctx.assetClass,
    openedAt: ctx.placedAt,
    closedAt: new Date().toISOString(),
    entryPrice: ctx.entryPrice,
    exitPrice,
    r: Number(r.toFixed(3)),
    win: r > 0,
    minutesHeld: Math.round((Date.now() - new Date(ctx.placedAt).getTime()) / 60000),
    score: ctx.score,
    window: ctx.window,
    factors: ctx.factors,
    trailed: Boolean(ctx.trailing),
    movedToBreakeven: Boolean(ctx.breakevenMoved),
  });

  await store.writeKey(OUTCOMES_KEY, outcomes.slice(0, 1000));
}

async function forget(symbols, lastPrices = {}) {
  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  let changed = false;
  for (const [key, ctx] of Object.entries(context)) {
    if (!symbols.has(key)) {
      // Best available exit price: the last one we saw for it.
      await recordOutcome(ctx, lastPrices[key] ?? ctx.stopPrice ?? ctx.entryPrice);
      delete context[key];
      changed = true;
    }
  }
  if (changed) await store.writeKey(CONTEXT_KEY, context);
}

const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Decide what should happen to one position. Pure, so the backtest can apply the
 * identical policy to historical bars without touching the network.
 */
export function decideExit({ entryPrice, currentPrice, riskPerShare, currentStop, minutesHeld, ctx = {} }) {
  if (!(riskPerShare > 0) || !(entryPrice > 0)) return { action: 'hold', reason: 'no risk basis recorded' };

  const r = (currentPrice - entryPrice) / riskPerShare;
  const { breakevenAtR, trailAtR, trailDistanceR, timeStopMinutes, timeStopMinR } = config.exits;

  if (minutesHeld >= timeStopMinutes && r < timeStopMinR) {
    return {
      action: 'close',
      reason: `held ${Math.round(minutesHeld)} min and still only ${r.toFixed(2)}R — cutting a trade that is not working`,
      r,
    };
  }

  let desiredStop = null;
  let label = null;

  if (r >= trailAtR) {
    desiredStop = currentPrice - trailDistanceR * riskPerShare;
    label = `trailing ${trailDistanceR}R behind at ${r.toFixed(2)}R`;
  } else if (r >= breakevenAtR) {
    desiredStop = entryPrice + 0.01;
    label = `stop to breakeven at ${r.toFixed(2)}R`;
  }

  if (desiredStop == null) return { action: 'hold', reason: `${r.toFixed(2)}R — nothing to do yet`, r };

  const next = round2(desiredStop);
  // Ratchet only. A stop that can move down is not a stop.
  if (!(next > (currentStop ?? -Infinity) + 0.005)) {
    return { action: 'hold', reason: `${r.toFixed(2)}R — stop already at or above ${next.toFixed(2)}`, r };
  }

  return { action: 'move-stop', stopPrice: next, reason: label, r };
}

/**
 * Apply the policy to every open position. Runs on every autopilot cycle,
 * including cycles where no new entry is allowed - an open position still needs
 * managing when the window is poor or the daily trade cap is used up.
 */
export async function manageExits({ now = Date.now(), trading = true } = {}) {
  const [positions, openOrders] = await Promise.all([
    alpaca.getPositions(),
    alpaca.getOpenOrders().catch(() => []),
  ]);

  const lastPrices = Object.fromEntries(
    positions.map((p) => [alpaca.normaliseSymbol(p.symbol), Number(p.current_price)]),
  );
  await forget(new Set(positions.map((p) => alpaca.normaliseSymbol(p.symbol))), lastPrices);
  if (!positions.length || !trading) return [];

  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  const actions = [];

  for (const position of positions) {
    const key = alpaca.normaliseSymbol(position.symbol);
    const ctx = context[key];
    if (!ctx) continue; // opened elsewhere; not ours to manage

    const symbol = position.symbol;
    const currentPrice = Number(position.current_price);

    const stopOrder = openOrders.find(
      (order) => alpaca.normaliseSymbol(order.symbol) === key && String(order.type || '').includes('stop'),
    );
    const currentStop = stopOrder ? Number(stopOrder.stop_price) : ctx.stopPrice;

    const decision = decideExit({
      entryPrice: Number(position.avg_entry_price),
      currentPrice,
      riskPerShare: ctx.riskPerShare,
      currentStop,
      minutesHeld: (now - new Date(ctx.placedAt).getTime()) / 60000,
      ctx,
    });

    /* --- crypto: no order rests at the exchange, so this loop IS the stop ----
     * Every cycle checks the price against the recorded stop and target, and
     * closes the position outright when either is breached. The ratchet still
     * applies; it just moves a number in the store instead of an order.
     */
    if (ctx.assetClass === 'crypto') {
      if (currentPrice <= ctx.stopPrice) {
        await alpaca.closePosition(symbol);
        await store.appendTrade({ symbol, status: 'stopped-out', price: currentPrice, stop: ctx.stopPrice });
        actions.push({
          symbol,
          action: 'close',
          reason: `price ${currentPrice} broke the ${ctx.stopPrice} stop`,
          r: decision.r,
        });
        continue;
      }

      if (ctx.takeProfitPrice && currentPrice >= ctx.takeProfitPrice) {
        await alpaca.closePosition(symbol);
        await store.appendTrade({ symbol, status: 'target-hit', price: currentPrice, target: ctx.takeProfitPrice });
        actions.push({
          symbol,
          action: 'close',
          reason: `price ${currentPrice} reached the ${ctx.takeProfitPrice} target`,
          r: decision.r,
        });
        continue;
      }

      if (decision.action === 'close') {
        await alpaca.closePosition(symbol);
        await store.appendTrade({ symbol, status: 'time-stopped', reason: decision.reason });
        actions.push({ symbol, ...decision });
        continue;
      }

      if (decision.action === 'move-stop') {
        ctx.stopPrice = decision.stopPrice;
        ctx.breakevenMoved = true;
        ctx.trailing = decision.r >= config.exits.trailAtR;
        actions.push({ symbol, ...decision });
      }
      continue;
    }

    /* --- equities: a real stop rests at the exchange ---------------------- */
    if (decision.action === 'close') {
      await alpaca.closePosition(symbol);
      await store.appendTrade({ symbol, status: 'time-stopped', reason: decision.reason });
      actions.push({ symbol, ...decision });
      continue;
    }

    if (decision.action === 'move-stop') {
      if (!stopOrder) {
        actions.push({ symbol, action: 'skip', reason: 'no resting stop order found to move' });
        continue;
      }
      try {
        await alpaca.replaceOrder(stopOrder.id, { stop_price: decision.stopPrice.toFixed(2) });
        ctx.stopPrice = decision.stopPrice;
        ctx.breakevenMoved = true;
        ctx.trailing = decision.r >= config.exits.trailAtR;
        actions.push({ symbol, ...decision });
      } catch (error) {
        // A stop being replaced mid-fill is normal; the next cycle retries.
        actions.push({ symbol, action: 'skip', reason: `could not move stop: ${error.message}` });
      }
    }
  }

  await store.writeKey(CONTEXT_KEY, context);
  return actions;
}
