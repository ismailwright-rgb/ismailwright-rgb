/**
 * Runs the real server against the synthetic Alpaca, so you can open the
 * dashboard and click through it without keys, an account, or an open market.
 *
 *   node test/serve-mock.mjs   →   http://localhost:8099
 *
 * The Execute button works end to end here; orders are captured in memory and
 * thrown away.
 */
import { installMock } from './mock-alpaca.mjs';

process.env.ALPACA_KEY_ID ||= 'PKTEST';
process.env.ALPACA_SECRET_KEY ||= 'testsecret';
process.env.WATCHLIST ||= 'NVDA,MSFT,AAPL,GRAB,PLUG';
process.env.OPENROUTER_API_KEY ||= 'mock-key';
process.env.PORT ||= '8099';
process.env.DATA_DIR ||= '/tmp/apace-mock-data';

const orders = installMock({
  positions: [
    {
      symbol: 'MSFT',
      qty: '3',
      avg_entry_price: '415.20',
      current_price: '418.44',
      unrealized_pl: '9.72',
      unrealized_plpc: '0.0078',
    },
  ],
});

await import('../server/index.js');

console.log('\n  MOCK MODE — no real account is reachable from this process.');
process.on('exit', () => {
  if (orders.length) console.log(`  captured ${orders.length} order(s):`, JSON.stringify(orders, null, 2));
});
