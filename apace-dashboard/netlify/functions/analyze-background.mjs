import { timingSafeEqual } from 'node:crypto';

import { config } from '../../server/config.js';
import { runAnalysis } from '../../server/analyze.js';
import * as store from '../../server/store.js';

/**
 * A full analysis makes several Alpaca calls and one model call, which together
 * outlast a normal function invocation. Netlify gives any function whose name
 * ends in `-background` up to 15 minutes, so the run happens here and the result
 * lands in the blob store. The page polls /api/state for it.
 */

function authorised(headers) {
  if (!config.dashboardUser) return true;

  const [scheme, encoded] = String(headers.authorization || '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;

  const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
  const equal = (a, b) => {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
  };
  return equal(user, config.dashboardUser) && equal(rest.join(':'), config.dashboardPassword);
}

export const handler = async (event) => {
  if (!authorised(event.headers || {})) {
    return { statusCode: 401, body: 'Authentication required' };
  }

  try {
    await store.init({ force: true });
    const analysis = await runAnalysis();
    await store.setAnalysis(analysis);

    const tradeable = analysis.candidates.filter((c) => c.action === 'TRADEABLE').length;
    console.log(`analysis complete in ${analysis.tookMs}ms — ${tradeable} tradeable of ${analysis.candidates.length}`);

    return { statusCode: 200, body: JSON.stringify({ ok: true, generatedAt: analysis.generatedAt }) };
  } catch (error) {
    console.error('background analysis failed:', error);

    // Record the failure so the dashboard can say what went wrong instead of
    // silently showing a stale run.
    await store
      .setAnalysis({
        ...(store.getAnalysis() || {}),
        lastError: { message: error.message, at: new Date().toISOString() },
      })
      .catch(() => {});

    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }
};
