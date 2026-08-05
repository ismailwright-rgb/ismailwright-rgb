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
export async function rememberEntry(symbol, { entryPrice, stopPrice, riskPerShare, placedAt }) {
  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  context[symbol] = {
    entryPrice,
    stopPrice,
    riskPerShare,
    placedAt: placedAt || new Date().toISOString(),
    breakevenMoved: false,
    trailing: false,
  };
  await store.writeKey(CONTEXT_KEY, context);
  return context[symbol];
}

export const readContext = () => store.readKey(CONTEXT_KEY, {});

async function forget(symbols) {
  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  let changed = false;
  for (const symbol of Object.keys(context)) {
    if (!symbols.has(symbol)) {
      delete context[symbol];
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

  await forget(new Set(positions.map((p) => p.symbol)));
  if (!positions.length || !trading) return [];

  const context = (await store.readKey(CONTEXT_KEY, {})) || {};
  const actions = [];

  for (const position of positions) {
    const symbol = position.symbol;
    const ctx = context[symbol];
    if (!ctx) continue; // opened elsewhere; not ours to manage

    const stopOrder = openOrders.find(
      (order) => order.symbol === symbol && String(order.type || '').includes('stop'),
    );
    const currentStop = stopOrder ? Number(stopOrder.stop_price) : ctx.stopPrice;

    const decision = decideExit({
      entryPrice: Number(position.avg_entry_price),
      currentPrice: Number(position.current_price),
      riskPerShare: ctx.riskPerShare,
      currentStop,
      minutesHeld: (now - new Date(ctx.placedAt).getTime()) / 60000,
      ctx,
    });

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
