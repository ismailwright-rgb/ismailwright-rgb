import { refreshAnalysis } from '../../server/app.js';
import * as store from '../../server/store.js';
import * as autopilot from '../../server/autopilot.js';
import { manageExits } from '../../server/exits.js';
import { flags } from '../../server/runtime.js';

/**
 * The loop that makes this an autopilot rather than a dashboard.
 *
 * Runs every minute, and does two different jobs at two different rates:
 *
 *  EVERY MINUTE - manage what is already open. For equities the stop rests at
 *  the exchange and this only ratchets it; for crypto, where Alpaca refuses to
 *  hold a stop, THIS LOOP IS THE STOP. It compares price against the recorded
 *  stop and target and closes the position itself.
 *
 *  EVERY FIVE MINUTES - decide whether to open something new. Entries are the
 *  expensive part (a full analysis), and one minute of extra delay on an entry
 *  costs far less than one minute of delay on an exit.
 *
 * The honest limitation: a polled stop is not a resting stop. Between checks
 * price can move through it, and you exit at whatever the next check sees. On
 * crypto that gap can be a percent or more. It is bounded by the poll interval,
 * which is why exits run at a minute rather than at five.
 */
export const config = { schedule: '* * * * *' };

export default async () => {
  try {
    await store.init({ force: true });

    const { autopilot: enabled, trading } = await flags();
    if (!enabled) return new Response('autopilot off', { status: 200 });

    // Always, every minute.
    const exitActions = await manageExits({ trading });
    for (const action of exitActions.filter((a) => a.action === 'close')) {
      console.log(`exit: ${action.symbol} — ${action.reason}`);
    }

    // Entries on the slower cadence.
    const minute = new Date().getUTCMinutes();
    if (minute % 5 !== 0) {
      return new Response(JSON.stringify({ exits: exitActions.length }), { status: 200 });
    }

    const result = await autopilot.tick({ refreshAnalysis });
    console.log('autopilot:', JSON.stringify(result).slice(0, 400));
    return new Response(JSON.stringify({ exits: exitActions.length, ...result }), { status: 200 });
  } catch (error) {
    console.error('autopilot cycle failed:', error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
