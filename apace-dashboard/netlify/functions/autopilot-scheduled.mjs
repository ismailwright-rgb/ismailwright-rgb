import { config as appConfig } from '../../server/config.js';
import { refreshAnalysis } from '../../server/app.js';
import * as store from '../../server/store.js';
import * as autopilot from '../../server/autopilot.js';

/**
 * Scheduled autopilot cycle.
 *
 * Netlify invokes this on the cron below; it is not reachable over HTTP, so it
 * needs no authentication of its own. It still does nothing unless AUTOPILOT is
 * explicitly true and order placement is enabled - which is off by default on a
 * public deployment.
 *
 * The schedule fires every 5 minutes around the clock; the autopilot's own
 * checks decide whether the market is open and whether the window is any good,
 * so there is no benefit to encoding market hours in cron.
 */
export const config = { schedule: '*/5 * * * *' };

export default async () => {
  if (!appConfig.autopilot.enabled || !appConfig.enableTrading) {
    return new Response('autopilot off', { status: 200 });
  }

  try {
    await store.init({ force: true });
    const result = await autopilot.tick({ refreshAnalysis });
    console.log('autopilot:', JSON.stringify(result).slice(0, 400));
    return new Response(JSON.stringify(result), { status: 200 });
  } catch (error) {
    console.error('autopilot tick failed:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
