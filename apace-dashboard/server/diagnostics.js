import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as store from './store.js';
import { resolveSession } from './session.js';
import { flags } from './runtime.js';

/**
 * Tests every dependency the dashboard has, one at a time, with timings.
 *
 * The point is to turn "it isn't working" into a specific failing line. Each
 * check runs independently, so one broken dependency does not hide the state of
 * the others, and the timings show which call is the one blowing the request
 * budget on a serverless host.
 *
 * Read-only throughout. Nothing here places, cancels or modifies an order.
 */

async function timed(name, what, fn, summarise = () => null) {
  const started = Date.now();
  try {
    const result = await fn();
    return { name, what, ok: true, ms: Date.now() - started, detail: summarise(result) };
  } catch (error) {
    return { name, what, ok: false, ms: Date.now() - started, error: error.message?.slice(0, 300) };
  }
}

export async function runDiagnostics({ publicDir = null } = {}) {
  const started = Date.now();
  const symbols = config.watchlist;

  const runtime = await flags().catch(() => ({ trading: null, autopilot: null }));

  const environment = {
    name: 'environment',
    what: 'How this instance sees itself',
    ok: true,
    ms: 0,
    detail:
      `serverless=${config.isServerless} · mode=${config.isPaper ? 'paper' : 'LIVE'} · feed=${config.feed} · ` +
      `watchlist=${symbols.length} · trading=${runtime.trading} · autopilot=${runtime.autopilot} · ` +
      `auth=${config.dashboardUser ? 'on' : 'OFF'}`,
  };

  const staticFiles = {
    name: 'static files',
    what: 'The dashboard page, CSS and JS inside the bundle',
    ok: Boolean(publicDir),
    ms: 0,
    detail: publicDir || null,
    error: publicDir ? undefined : 'public/ was not found — included_files may not be bundling it',
  };

  // Sequential on purpose: parallel timings would hide which call is slow.
  const checks = [
    environment,
    staticFiles,
    await timed('store', 'Whether state survives between requests', () => store.storeInfo(), (info) =>
      `${info.backend}${info.shared ? '' : ' — NOT shared, autopilot and one-click trading will not work'}`),
    await timed('alpaca: account', 'Credentials and account access', () => alpaca.getAccount(), (a) =>
      `equity ${Number(a.equity).toFixed(2)} · buying power ${Number(a.buying_power).toFixed(2)} · day trades ${a.daytrade_count}`),
    await timed('alpaca: clock', 'Market open or closed', () => alpaca.getClock(), (c) =>
      c.is_open ? 'market open' : `closed, next open ${c.next_open}`),
    await timed('alpaca: session', 'Calendar and session resolution', () => resolveSession(), (s) =>
      `${s.date} ${s.isCurrent ? 'in progress' : 'completed'} · ${Math.round(s.minutesToClose)} min to close`),
    await timed('alpaca: positions', 'Open positions', () => alpaca.getPositions(), (p) => `${p.length} open`),
    await timed('alpaca: quotes', `Latest quotes for ${symbols.length} symbols`, () => alpaca.getLatestQuotes(symbols), (q) =>
      `${Object.keys(q).length} of ${symbols.length} returned`),
    await timed(
      'alpaca: intraday bars',
      'Session bars — usually the slowest call',
      async () => {
        const session = await resolveSession();
        return alpaca.getIntradayBars(symbols, { timeframe: '5Min', start: session.open.toISOString() });
      },
      (bars) => {
        const total = Object.values(bars).reduce((sum, list) => sum + list.length, 0);
        return `${Object.keys(bars).length} symbols · ${total} bars`;
      },
    ),
    await timed('alpaca: daily bars', 'Volume baseline', () => alpaca.getDailyBars(symbols, { days: 45 }), (b) =>
      `${Object.keys(b).length} symbols`),
    await timed('alpaca: news', 'Headlines for the reasoning', () => alpaca.getNews(symbols), (n) =>
      `${Object.keys(n).length} symbols with headlines`),
  ];

  // The model is checked last and separately: it is optional, and a failure here
  // costs the written reasoning, not the scores.
  if (config.openRouterKey) {
    checks.push(
      await timed(
        'openrouter',
        'The model that writes the reasoning',
        async () => {
          const response = await fetch('https://openrouter.ai/api/v1/models', {
            headers: { Authorization: `Bearer ${config.openRouterKey}` },
            signal: AbortSignal.timeout(6000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response;
        },
        () => `key accepted · model ${config.openRouterModel}`,
      ),
    );
  } else {
    checks.push({
      name: 'openrouter',
      what: 'The model that writes the reasoning',
      ok: true,
      ms: 0,
      detail: 'no key set — scores still work, there is just no written reasoning',
    });
  }

  const totalMs = Date.now() - started;
  const failures = checks.filter((c) => !c.ok);

  // Everything except the model has to work for an analysis to complete.
  const upstreamMs = checks
    .filter((c) => c.name.startsWith('alpaca'))
    .reduce((sum, c) => sum + c.ms, 0);

  const verdict = [];
  if (failures.length) {
    verdict.push(`${failures.length} check(s) failing: ${failures.map((f) => f.name).join(', ')}.`);
  } else {
    verdict.push('Every dependency responded.');
  }

  if (config.isServerless && upstreamMs > 8000) {
    verdict.push(
      `Upstream calls took ${(upstreamMs / 1000).toFixed(1)}s. A serverless request usually has about 10s, ` +
        'so a full analysis may be timing out. Trim WATCHLIST to shorten it.',
    );
  }

  return {
    at: new Date().toISOString(),
    ok: failures.length === 0,
    totalMs,
    upstreamMs,
    verdict,
    checks,
  };
}
