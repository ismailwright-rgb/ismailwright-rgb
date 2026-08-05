/**
 * Exercises the serverless entry point the way Netlify will call it, with the
 * synthetic market behind it. The properties under test are the ones that matter
 * on a public URL: authentication is enforced, and order placement is off.
 *
 *   node test/netlify.mjs
 */
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { installMock } from './mock-alpaca.mjs';

// Isolated, and cleared first: the blob backend falls back to the filesystem
// when Blobs is unavailable, so a leftover analysis from another suite would
// otherwise make this order-dependent.
process.env.DATA_DIR = '/tmp/apace-netlify-test';
await rm(process.env.DATA_DIR, { recursive: true, force: true });
await rm('/tmp/apace-data', { recursive: true, force: true });

process.env.NETLIFY = 'true';
process.env.ALPACA_KEY_ID ||= 'PKTEST';
process.env.ALPACA_SECRET_KEY ||= 'testsecret';
process.env.WATCHLIST ||= 'NVDA,MSFT,AAPL,GRAB,PLUG';
process.env.OPENROUTER_API_KEY ||= 'mock-key';
process.env.DASHBOARD_USER = 'demo';
process.env.DASHBOARD_PASSWORD = 'correct-horse';

installMock();

const { handler } = await import('../netlify/functions/api.mjs');

const AUTH = `Basic ${Buffer.from('demo:correct-horse').toString('base64')}`;

const call = (path, { method = 'GET', auth = true, body } = {}) =>
  handler(
    {
      httpMethod: method,
      path,
      headers: {
        ...(auth ? { authorization: AUTH } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      queryStringParameters: null,
      body: body ? JSON.stringify(body) : null,
      isBase64Encoded: false,
    },
    {},
  );

const check = async (name, fn) => {
  await fn();
  console.log(`  ✓ ${name}`);
};

await check('health is reachable without credentials', async () => {
  const res = await call('/api/health', { auth: false });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.mode, 'paper');
  assert.equal(body.trading, false, 'trading must default to off on a public host');
});

await check('state requires credentials', async () => {
  const res = await call('/api/state', { auth: false });
  assert.equal(res.statusCode, 401);
  assert.match(res.headers['www-authenticate'] || '', /Basic/);
});

await check('a wrong password is rejected', async () => {
  const wrong = `Basic ${Buffer.from('demo:hunter2').toString('base64')}`;
  const res = await handler(
    { httpMethod: 'GET', path: '/api/state', headers: { authorization: wrong }, body: null },
    {},
  );
  assert.equal(res.statusCode, 401);
});

await check('state is served with credentials', async () => {
  const res = await call('/api/state');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.tradingEnabled, false);
});

await check('a missing analysis is reported as absent, not infinitely old', async () => {
  // /api/state now self-heals, so check the paths that read the store as-is.
  const store = await import('../server/store.js');
  await store.setAnalysis(null);

  const body = JSON.parse((await call('/api/autopilot')).body);
  const ageBlocker = body.blockers.find((b) => /analysis/i.test(b));
  assert.ok(ageBlocker, 'the autopilot should say something about the missing analysis');
  assert.doesNotMatch(ageBlocker, /Infinity/, 'an infinite age must never reach the page');
  assert.match(ageBlocker, /No analysis yet/);
});

await check('state reports whether it is actually shared between functions', async () => {
  const body = JSON.parse((await call('/api/state')).body);
  assert.ok(body.store, 'the dashboard cannot warn about ephemeral state it is not told about');
  assert.equal(typeof body.store.shared, 'boolean');
  // Blobs is unavailable in this test, which is exactly the broken deployment.
  assert.equal(body.store.shared, false);
  assert.match(body.store.hint, /Blobs/);
});

await check('the function-prefixed path resolves the same route', async () => {
  const res = await call('/.netlify/functions/api/api/health', { auth: false });
  assert.equal(res.statusCode, 200);
});

await check('the dashboard page is served through the function', async () => {
  const res = await call('/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] || '', /html/);
  assert.match(res.body, /Apace/);
});

await check('the page is not served to anonymous callers', async () => {
  const res = await call('/', { auth: false });
  assert.equal(res.statusCode, 401, 'static assets must sit behind auth too');
});

await check('order placement is refused', async () => {
  const res = await call('/api/trade', { method: 'POST', body: { symbol: 'NVDA', confirm: true } });
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).blockers[0], /ENABLE_TRADING/);
});

await check('flatten is refused', async () => {
  const res = await call('/api/flatten', { method: 'POST' });
  assert.equal(res.statusCode, 403);
});

await check('preview still explains itself, with the block listed first', async () => {
  // Seed an analysis so preview has something to look at.
  const { runAnalysis } = await import('../server/analyze.js');
  const store = await import('../server/store.js');
  await store.setAnalysis(await runAnalysis());

  const res = await call('/api/preview', { method: 'POST', body: { symbol: 'NVDA' } });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.allowed, false);
  assert.match(body.blockers[0], /disabled on this deployment/);
  assert.ok(body.plan.qty >= 1, 'the plan is still shown so the reasoning stays visible');
});

await check('analyze runs inline and returns the result directly', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('-background')) seen.push(url);
    return realFetch(input, init);
  };

  const res = await call('/api/analyze', { method: 'POST' });
  globalThis.fetch = realFetch;

  // No handoff. Measured upstream time is about a second, and a background run
  // depends on shared state to read the result back - two failure modes for no
  // benefit.
  assert.equal(seen.length, 0, 'nothing should be handed to a background function');
  assert.equal(res.statusCode, 200);

  const body = JSON.parse(res.body);
  assert.ok(body.analysis, 'the analysis must come back in the response');
  assert.ok(body.analysis.candidates.length > 0);
});

await check('a first visit gets an analysis without being asked', async () => {
  const store = await import('../server/store.js');
  await store.setAnalysis(null);

  const body = JSON.parse((await call('/api/state')).body);
  assert.ok(body.analysis, '/api/state must produce an analysis when there is none');
  assert.ok(body.analysis.candidates.length > 0);
});

await rm(process.env.DATA_DIR, { recursive: true, force: true });
console.log('\nnetlify: OK');
