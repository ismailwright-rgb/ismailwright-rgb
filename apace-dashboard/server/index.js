import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

import { config } from './config.js';
import * as alpaca from './alpaca.js';
import * as store from './store.js';
import { runAnalysis } from './analyze.js';
import { buildTradePlan, evaluateTrade, clientOrderId } from './guard.js';
import { resolveSession } from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

// --- auth -------------------------------------------------------------------
function safeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

if (config.dashboardUser) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next();

    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
      const password = rest.join(':');
      if (safeEqual(user, config.dashboardUser) && safeEqual(password, config.dashboardPassword)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Apace"').status(401).send('Authentication required');
  });
}

// --- helpers ----------------------------------------------------------------
const asyncRoute = (handler) => (req, res) => {
  Promise.resolve(handler(req, res)).catch((error) => {
    console.error(`[${req.method} ${req.path}]`, error);
    if (!res.headersSent) {
      res.status(error.status && error.status < 500 ? 400 : 500).json({ error: error.message });
    }
  });
};

let analysisInFlight = null;

/** Collapses concurrent refreshes onto one upstream run. */
function refreshAnalysis() {
  if (!analysisInFlight) {
    analysisInFlight = runAnalysis()
      .then(async (result) => {
        await store.setAnalysis(result);
        return result;
      })
      .finally(() => {
        analysisInFlight = null;
      });
  }
  return analysisInFlight;
}

// --- routes -----------------------------------------------------------------
app.get('/api/health', (req, res) => res.json({ ok: true, mode: config.mode || (config.isPaper ? 'paper' : 'live') }));

app.get(
  '/api/state',
  asyncRoute(async (req, res) => {
    let analysis = store.getAnalysis();
    if (!analysis) analysis = await refreshAnalysis();

    res.json({
      analysis,
      ageSeconds: Math.round(store.analysisAgeSeconds()),
      stale: store.analysisAgeSeconds() > config.maxAnalysisAgeSeconds,
      trades: store.getTradeLog().slice(0, 20),
    });
  }),
);

app.post(
  '/api/analyze',
  asyncRoute(async (req, res) => {
    const analysis = await refreshAnalysis();
    res.json({ analysis, ageSeconds: 0, stale: false, trades: store.getTradeLog().slice(0, 20) });
  }),
);

app.post(
  '/api/trade',
  asyncRoute(async (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase().trim();
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'confirm must be true' });

    const analysis = store.getAnalysis();
    if (!analysis) return res.status(409).json({ error: 'No analysis yet. Refresh first.' });

    // Re-fetch everything that gates the decision. The only thing taken from the
    // request body is which symbol was clicked.
    const [account, positions, session] = await Promise.all([
      alpaca.getAccount(),
      alpaca.getPositions(),
      resolveSession(),
    ]);

    const candidate = analysis.candidates.find((c) => c.symbol === symbol);
    const equity = Number(account.equity) || 0;
    const plan = candidate
      ? buildTradePlan({ symbol, entryPrice: candidate.ask || candidate.last, atrValue: candidate.atr, equity })
      : { viable: false, reason: 'unknown symbol' };

    const verdict = evaluateTrade({
      candidate,
      plan,
      account,
      positions,
      session,
      analysisAgeSeconds: store.analysisAgeSeconds(),
    });

    if (!verdict.allowed) {
      await store.appendTrade({ symbol, status: 'blocked', blockers: verdict.blockers, score: candidate?.score ?? null });
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
    });
    const verdict = evaluateTrade({
      candidate,
      plan,
      account,
      positions,
      session,
      analysisAgeSeconds: store.analysisAgeSeconds(),
    });

    res.json({ symbol, plan, ...verdict });
  }),
);

app.post(
  '/api/positions/:symbol/close',
  asyncRoute(async (req, res) => {
    const symbol = String(req.params.symbol).toUpperCase();
    const result = await alpaca.closePosition(symbol);
    await store.appendTrade({ symbol, status: 'closed', orderId: result?.id ?? null });
    res.json({ ok: true, result });
  }),
);

app.post(
  '/api/flatten',
  asyncRoute(async (req, res) => {
    const result = await alpaca.closeAllPositions();
    await store.appendTrade({ symbol: '*', status: 'flattened', count: Array.isArray(result) ? result.length : 0 });
    res.json({ ok: true, result });
  }),
);

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

await store.init();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Apace dashboard on :${config.port}`);
  console.log(`  mode        ${config.isPaper ? 'PAPER' : 'LIVE — real money'}`);
  console.log(`  data feed   ${config.feed}`);
  console.log(`  watchlist   ${config.watchlist.length} symbols`);
  console.log(`  auth        ${config.dashboardUser ? 'basic auth on' : 'OFF — bind to localhost only'}`);
});
