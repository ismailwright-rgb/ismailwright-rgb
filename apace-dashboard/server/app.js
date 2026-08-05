import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as store from './store.js';
import { runAnalysis } from './analyze.js';
import { buildTradePlan, evaluateTrade, clientOrderId } from './guard.js';
import { resolveSession } from './session.js';
import { tradeWindow } from './windows.js';
import * as autopilot from './autopilot.js';
import { flags, setFlags, tradingEnabled } from './runtime.js';
import { runDiagnostics } from './diagnostics.js';

/**
 * Locate the static files under both module systems.
 *
 * Netlify's esbuild bundles these ES modules into CommonJS, where `import.meta`
 * is replaced with an empty object - so deriving a directory from
 * `import.meta.url` throws at import time and takes the whole function with it.
 * Try each layout in turn and pick the one that actually has the page in it.
 */
function resolvePublicDir() {
  // Bundling also moves the code: on Netlify everything collapses into
  // netlify/functions/api.js, so "../public" no longer means what it does in
  // source. Walk up from each plausible anchor instead of assuming a layout.
  const walkUp = (start, levels = 5) => {
    const dirs = [];
    let dir = start;
    for (let i = 0; i <= levels; i += 1) {
      dirs.push(path.join(dir, 'public'));
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return dirs;
  };

  const candidates = [];

  // Bundled to CommonJS: __dirname exists. `typeof` keeps this safe under ESM,
  // where the identifier is not declared at all.
  if (typeof __dirname !== 'undefined') candidates.push(...walkUp(__dirname));

  // Plain ESM: Docker, or `node server/index.js`.
  try {
    const here = import.meta?.url;
    if (here) candidates.push(...walkUp(path.dirname(fileURLToPath(here))));
  } catch {
    // import.meta is unavailable in a CommonJS bundle.
  }

  candidates.push(...walkUp(process.cwd()), path.resolve(process.cwd(), 'apace-dashboard', 'public'));

  const found = candidates.find((dir) => {
    try {
      return fs.existsSync(path.join(dir, 'index.html'));
    } catch {
      return false;
    }
  });

  if (!found) {
    console.error('static files not found; looked in:\n  ' + candidates.join('\n  '));
  }
  return found ?? null;
}

export const PUBLIC_DIR = resolvePublicDir();

/* --- helpers ---------------------------------------------------------------- */
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch((error) => {
    console.error(`[${req.method} ${req.path}]`, error);
    if (!res.headersSent) {
      res.status(error.status && error.status < 500 ? 400 : 500).json({ error: error.message });
    }
  });
};

let analysisInFlight = null;

/** Collapses concurrent refreshes onto a single upstream run. */
export function refreshAnalysis() {
  if (!analysisInFlight) {
    analysisInFlight = runAnalysis()
      .then((result) => store.setAnalysis(result))
      .finally(() => {
        analysisInFlight = null;
      });
  }
  return analysisInFlight;
}

/* --- app -------------------------------------------------------------------- */
export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));

  // Behind Netlify's redirect the path can arrive with the function prefix still
  // attached. Strip it so the routes below are written once, for both runtimes.
  app.use((req, res, next) => {
    const prefix = '/.netlify/functions/api';
    if (req.url.startsWith(prefix)) req.url = req.url.slice(prefix.length) || '/';
    next();
  });

  if (config.dashboardUser) {
    app.use((req, res, next) => {
      if (req.path === '/api/health') return next();

      const [scheme, encoded] = (req.headers.authorization || '').split(' ');
      if (scheme === 'Basic' && encoded) {
        const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
        if (safeEqual(user, config.dashboardUser) && safeEqual(rest.join(':'), config.dashboardPassword)) {
          return next();
        }
      }
      res.set('WWW-Authenticate', 'Basic realm="Apace"').status(401).send('Authentication required');
    });
  }

  // Every request re-hydrates from the blob store on serverless, where the
  // in-process copy belongs to one invocation.
  app.use(asyncRoute(async (req, res, next) => {
    await store.init();
    await store.refresh();
    next();
  }));

  app.get(
    '/api/health',
    asyncRoute(async (req, res) =>
      res.json({ ok: true, mode: config.isPaper ? 'paper' : 'live', trading: await tradingEnabled() })),
  );

  app.get(
    '/api/state',
    asyncRoute(async (req, res) => {
      let analysis = store.getAnalysis();
      if (!analysis) analysis = await refreshAnalysis();

      const age = store.analysisAgeSeconds();
      res.json({
        analysis,
        // Infinity is not JSON; a missing analysis has no age, it simply is not there.
        ageSeconds: Number.isFinite(age) ? Math.round(age) : null,
        stale: Number.isFinite(age) && age > config.maxAnalysisAgeSeconds,
        trades: store.getTradeLog().slice(0, 20),
        tradingEnabled: await tradingEnabled(),
        store: await store.storeInfo(),
      });
    }),
  );

  app.post(
    '/api/analyze',
    asyncRoute(async (req, res) => {
      // Deliberately synchronous, even on serverless. Measured upstream time for
      // the whole watchlist is around a second, so a handoff to a background
      // function bought nothing - and cost two outages: a catch-all redirect that
      // swallowed the call, and a hard dependency on shared state to read the
      // result back. Run it here and return it.
      const storeState = await store.storeInfo();

      const analysis = await refreshAnalysis();
      res.json({
        analysis,
        ageSeconds: 0,
        stale: false,
        trades: store.getTradeLog().slice(0, 20),
        tradingEnabled: await tradingEnabled(),
        store: storeState,
      });
    }),
  );

  // Light enough to poll: account and clock only, no bars, quotes or model call.
  app.get(
    '/api/account',
    asyncRoute(async (req, res) => {
      const [account, positions, session] = await Promise.all([
        alpaca.getAccount(),
        alpaca.getPositions(),
        resolveSession(),
      ]);

      const equity = Number(account.equity) || 0;
      res.json({
        at: new Date().toISOString(),
        equity,
        buyingPower: Number(account.buying_power) || 0,
        cash: Number(account.cash) || 0,
        dayTradeCount: Number(account.daytrade_count ?? 0),
        patternDayTrader: Boolean(account.pattern_day_trader),
        pdtRestricted: equity < 25000,
        openPositions: positions.length,
        unrealizedPl: positions.reduce((sum, p) => sum + (Number(p.unrealized_pl) || 0), 0),
        positions: positions.map((p) => ({
          symbol: p.symbol,
          qty: Number(p.qty),
          avgEntry: Number(p.avg_entry_price),
          current: Number(p.current_price),
          unrealizedPl: Number(p.unrealized_pl),
          unrealizedPlPct: Number(p.unrealized_plpc) * 100,
        })),
        session: {
          date: session.date,
          open: session.open.toISOString(),
          close: session.close.toISOString(),
          isCurrent: session.isCurrent,
          minutesToClose: Math.round(session.minutesToClose),
        },
        window: tradeWindow(Date.now(), { open: session.open, close: session.close }),
      });
    }),
  );

  app.post(
    '/api/preview',
    asyncRoute(async (req, res) => {
      const symbol = String(req.body?.symbol || '').toUpperCase().trim();
      const analysis = store.getAnalysis();
      const candidate = analysis?.candidates.find((c) => c.symbol === symbol);
      if (!candidate) return res.status(404).json({ error: 'unknown symbol' });

      const [account, positions, session] = await Promise.all([
        alpaca.getAccount(),
        alpaca.getPositions(),
        resolveSession(),
      ]);

      const plan = buildTradePlan({
        symbol,
        entryPrice: candidate.ask || candidate.last,
        atrValue: candidate.atr,
        equity: Number(account.equity) || 0,
        requestedNotional: Number(req.body?.notional) || null,
      });
      const verdict = evaluateTrade({
        candidate,
        plan,
        account,
        positions,
        session,
        analysisAgeSeconds: store.analysisAgeSeconds(),
        window: tradeWindow(Date.now(), { open: session.open, close: session.close }),
      });

      if (!(await tradingEnabled())) {
        verdict.allowed = false;
        verdict.blockers = [
          'Order placement is disabled on this deployment (ENABLE_TRADING is not true).',
          ...verdict.blockers,
        ];
      }

      res.json({ symbol, plan, ...verdict });
    }),
  );

  app.post(
    '/api/trade',
    asyncRoute(async (req, res) => {
      if (!(await tradingEnabled())) {
        return res.status(403).json({
          error: 'Order placement is off',
          blockers: ['Turn trading on from the dashboard, or set ENABLE_TRADING=true, before placing orders.'],
          warnings: [],
        });
      }

      const symbol = String(req.body?.symbol || '').toUpperCase().trim();
      if (!symbol) return res.status(400).json({ error: 'symbol is required' });
      if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm must be true' });

      const analysis = store.getAnalysis();
      if (!analysis) return res.status(409).json({ error: 'No analysis yet. Refresh first.' });

      // Re-fetch everything that gates the decision. The only thing taken from
      // the request body is which symbol was clicked.
      const [account, positions, session] = await Promise.all([
        alpaca.getAccount(),
        alpaca.getPositions(),
        resolveSession(),
      ]);

      const candidate = analysis.candidates.find((c) => c.symbol === symbol);
      const equity = Number(account.equity) || 0;
      const plan = candidate
        ? buildTradePlan({
            symbol,
            entryPrice: candidate.ask || candidate.last,
            atrValue: candidate.atr,
            equity,
            requestedNotional: Number(req.body?.notional) || null,
          })
        : { viable: false, reason: 'unknown symbol' };

      const verdict = evaluateTrade({
        candidate,
        plan,
        account,
        positions,
        session,
        analysisAgeSeconds: store.analysisAgeSeconds(),
        window: tradeWindow(Date.now(), { open: session.open, close: session.close }),
      });

      if (!verdict.allowed) {
        await store.appendTrade({
          symbol,
          status: 'blocked',
          blockers: verdict.blockers,
          score: candidate?.score ?? null,
        });
        return res.status(422).json({ error: 'Trade blocked by risk guard', ...verdict, plan });
      }

      const order = await alpaca.placeBracketOrder({
        symbol,
        qty: plan.qty,
        entryType: 'market',
        stopPrice: plan.stopPrice,
        takeProfitPrice: plan.takeProfitPrice,
        clientOrderId: clientOrderId(symbol, analysis.session.date),
      });

      const entry = {
        symbol,
        status: 'submitted',
        orderId: order.id,
        clientOrderId: order.client_order_id,
        qty: plan.qty,
        stopPrice: plan.stopPrice,
        takeProfitPrice: plan.takeProfitPrice,
        notional: plan.notional,
        riskDollars: plan.riskDollars,
        score: candidate.score,
        warnings: verdict.warnings,
      };
      await store.appendTrade(entry);

      res.json({ ok: true, order, plan, warnings: verdict.warnings, trade: entry });
    }),
  );

  app.get(
    '/api/autopilot',
    asyncRoute(async (req, res) => {
      const [status, journal] = await Promise.all([autopilot.status(), autopilot.readJournal()]);
      res.json({ ...status, journal: journal.slice(0, 40) });
    }),
  );

  // Switching it on or off from the dashboard. Persisted, so it takes effect
  // without a redeploy and survives a restart.
  app.post(
    '/api/autopilot/enabled',
    asyncRoute(async (req, res) => {
      const enabled = await autopilot.setEnabled(req.body?.enabled === true);
      res.json({ ok: true, enabled, ...(await autopilot.status()) });
    }),
  );

  app.post(
    '/api/trading/enabled',
    asyncRoute(async (req, res) => {
      const next = await setFlags({ trading: req.body?.enabled === true });
      res.json({ ok: true, ...next });
    }),
  );

  app.get('/api/flags', asyncRoute(async (req, res) => res.json(await flags())));

  // Read-only. Tests every dependency one at a time, with timings, so a failure
  // names itself instead of surfacing as an empty page.
  app.get(
    '/api/diagnostics',
    asyncRoute(async (req, res) => res.json(await runDiagnostics({ publicDir: PUBLIC_DIR }))),
  );

  // The kill switch. Halting takes effect for the rest of the session and
  // survives a restart; it clears itself at the next open.
  app.post(
    '/api/autopilot/halt',
    asyncRoute(async (req, res) => {
      const day = await autopilot.halt(String(req.body?.reason || '').slice(0, 200) || 'stopped from the dashboard');
      res.json({ ok: true, day });
    }),
  );

  app.post(
    '/api/autopilot/resume',
    asyncRoute(async (req, res) => {
      const day = await autopilot.resume();
      res.json({ ok: true, day });
    }),
  );

  // Run one cycle now. Also the entry point for a scheduled invocation.
  app.post(
    '/api/autopilot/tick',
    asyncRoute(async (req, res) => {
      const result = await autopilot.tick({ refreshAnalysis, dryRun: req.body?.dryRun === true });
      res.json({ ok: true, ...result });
    }),
  );

  const requireTrading = asyncRoute(async (req, res, next) =>
    (await tradingEnabled()) ? next() : res.status(403).json({ error: 'Order placement is off' }));

  app.post(
    '/api/positions/:symbol/close',
    requireTrading,
    asyncRoute(async (req, res) => {
      const symbol = String(req.params.symbol).toUpperCase();
      const result = await alpaca.closePosition(symbol);
      await store.appendTrade({ symbol, status: 'closed', orderId: result?.id ?? null });
      res.json({ ok: true, result });
    }),
  );

  app.post(
    '/api/flatten',
    requireTrading,
    asyncRoute(async (req, res) => {
      const result = await alpaca.closeAllPositions();
      await store.appendTrade({ symbol: '*', status: 'flattened', count: Array.isArray(result) ? result.length : 0 });
      res.json({ ok: true, result });
    }),
  );

  if (PUBLIC_DIR) {
    app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
  } else {
    // Better a clear message than a blank 404 nobody can diagnose.
    app.use((req, res) =>
      res
        .status(500)
        .type('text/plain')
        .send(
          'The dashboard files were not found on the server.\n' +
            'On Netlify this means included_files in netlify.toml did not bundle public/**.\n' +
            'The API itself is unaffected — try /api/health.',
        ),
    );
  }

  return app;
}
