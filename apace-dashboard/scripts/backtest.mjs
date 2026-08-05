#!/usr/bin/env node
/**
 * Replay the strategy over recent history.
 *
 *   npm run backtest -- --days 60
 *   npm run backtest -- --days 30 --min-score 70
 *
 * Needs real Alpaca keys in the environment; it reads market data only and never
 * places an order.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(args[i + 1]);
};

const { runBacktest } = await import('../server/backtest.js');
const { config } = await import('../server/config.js');

const options = {
  days: flag('days', 30),
  minScore: flag('min-score', config.autopilot.minScore),
  slippageBps: flag('slippage-bps', 5),
  onProgress: (message) => process.stdout.write(`  ${message}\n`),
};

console.log(`\nReplaying ${config.watchlist.length} symbols over ${options.days} days`);
console.log(`  minimum score ${options.minScore} · slippage ${options.slippageBps} bps each way\n`);

const result = await runBacktest(options);

const pad = (v, n) => String(v).padStart(n);
const row = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);

console.log('\n─── result ───────────────────────────────────────────────');
row('Sessions', result.sessions);
row('Trades', result.trades);
row('Win rate', `${result.winRate}%  (${result.wins}W / ${result.losses}L)`);
row('Total R', result.totalR);
row('Average R per trade', result.avgR);
row('Average win', `${result.avgWinR}R`);
row('Average loss', `${result.avgLossR}R`);
row('Max drawdown', `${result.maxDrawdownR}R`);

if (result.trades) {
  console.log('\n  By exit reason');
  for (const r of result.byReason) {
    console.log(`    ${r.reason.padEnd(12)} ${pad(r.trades, 4)} trades  ${pad(r.winRate.toFixed(0), 3)}% win  ${pad(r.totalR, 8)}R`);
  }

  console.log('\n  By window');
  for (const r of result.byWindow) {
    console.log(`    ${r.window.padEnd(18)} ${pad(r.trades, 4)} trades  ${pad(r.winRate.toFixed(0), 3)}% win  ${pad(r.totalR, 8)}R`);
  }

  console.log('\n  Top symbols');
  for (const r of result.bySymbol.slice(0, 8)) {
    console.log(`    ${r.symbol.padEnd(8)} ${pad(r.trades, 4)} trades  ${pad(r.winRate.toFixed(0), 3)}% win  ${pad(r.totalR, 8)}R`);
  }
}

const dir = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
await mkdir(dir, { recursive: true });
const file = path.join(dir, 'backtest.json');
await writeFile(file, JSON.stringify(result, null, 2));

console.log(`\n  Full detail written to ${file}`);
console.log(`
─── read this before acting on it ────────────────────────────
  No news. Live scores include a model's read of headlines worth
  up to 12 points either way, plus vetoes. This is technicals only.
  Spreads are assumed, not measured. Fills are next-bar-open plus
  ${options.slippageBps} bps. When a bar spans both stop and target, the stop
  is assumed to hit first.

  A losing result here is decisive. A winning one is permission to
  paper trade, not evidence of an edge - ${result.trades} trades is a small
  sample, and these weights were never fitted, so there is no
  overfitting to discount, but no validation either.
`);
