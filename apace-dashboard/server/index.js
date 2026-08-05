import { config } from './config.js';
import { createApp, refreshAnalysis } from './app.js';
import * as store from './store.js';
import * as autopilot from './autopilot.js';

await store.init();

createApp().listen(config.port, '0.0.0.0', () => {
  console.log(`Apace dashboard on :${config.port}`);
  console.log(`  mode        ${config.isPaper ? 'PAPER' : 'LIVE — real money'}`);
  console.log(`  trading     ${config.enableTrading ? 'enabled' : 'DISABLED (read-only)'}`);
  console.log(`  autopilot   ${config.autopilot.enabled ? `ON — every ${config.autopilot.intervalMinutes} min` : 'off'}`);
  console.log(`  data feed   ${config.feed}`);
  console.log(`  watchlist   ${config.watchlist.length} symbols`);
  console.log(`  auth        ${config.dashboardUser ? 'basic auth on' : 'OFF — bind to localhost only'}`);
});

{
  if (config.autopilot.enabled) {
    console.log(
      '\n  Autopilot is trading without supervision.\n' +
        '  The scoring has never been validated against history. Read the journal.\n',
    );
  }

  const runTick = async () => {
    try {
      const result = await autopilot.tick({ refreshAnalysis });
      if (result.action === 'trade') console.log(`autopilot: bought ${result.symbol}`);
      else if (result.action === 'flatten') console.log(`autopilot: flattened ${result.closed} positions`);
    } catch (error) {
      // A failed tick must never take the server down - the next one may succeed.
      console.error('autopilot tick failed:', error.message);
    }
  };

  setInterval(runTick, config.autopilot.intervalMinutes * 60_000);
  setTimeout(runTick, 15_000); // one shortly after boot, once the app has settled
}
