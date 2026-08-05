import { config } from './config.js';
import { createApp } from './app.js';
import * as store from './store.js';

await store.init();

createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`Apace dashboard on :${config.port}`);
  console.log(`  mode        ${config.isPaper ? 'PAPER' : 'LIVE — real money'}`);
  console.log(`  trading     ${config.enableTrading ? 'enabled' : 'DISABLED (read-only)'}`);
  console.log(`  data feed   ${config.feed}`);
  console.log(`  watchlist   ${config.watchlist.length} symbols`);
  console.log(`  auth        ${config.dashboardUser ? 'basic auth on' : 'OFF — bind to localhost only'}`);
});
