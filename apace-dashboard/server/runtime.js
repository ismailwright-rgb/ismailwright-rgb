import { config } from './config.js';
import * as store from './store.js';

/**
 * Flags that can be changed while the server is running.
 *
 * Environment variables set the defaults; anything toggled from the dashboard
 * overrides them and persists. Requiring a redeploy to start or stop trading
 * makes for a useless switch, so the switch is authoritative.
 *
 * What is NOT toggleable, deliberately:
 *  - the paper/live endpoint (ALLOW_LIVE, checked at boot)
 *  - unattended trading against real money (AUTOPILOT_ALLOW_LIVE)
 *  - basic auth on a public deployment
 * Those decide whether real money is reachable at all. A button should not.
 */

const KEY = 'runtime-flags';

export async function flags() {
  const stored = (await store.readKey(KEY, {})) || {};
  return {
    trading: typeof stored.trading === 'boolean' ? stored.trading : config.enableTrading,
    autopilot: typeof stored.autopilot === 'boolean' ? stored.autopilot : config.autopilot.enabled,
    source: {
      trading: typeof stored.trading === 'boolean' ? 'dashboard' : 'environment',
      autopilot: typeof stored.autopilot === 'boolean' ? 'dashboard' : 'environment',
    },
  };
}

export async function setFlags(patch) {
  const stored = (await store.readKey(KEY, {})) || {};
  const next = { ...stored };
  if (typeof patch.trading === 'boolean') next.trading = patch.trading;
  if (typeof patch.autopilot === 'boolean') next.autopilot = patch.autopilot;
  await store.writeKey(KEY, next);
  return flags();
}

export const tradingEnabled = async () => (await flags()).trading;
