/**
 * Exercises the serverless entry point the way Netlify will call it, with the
 * synthetic market behind it. The properties under test are the ones that matter
 * on a public URL: authentication is enforced, and order placement is off.
 *
 *   node test/netlify.mjs
 */
import assert from 'node:assert/strict';
import { installMock } from './mock-alpaca.mjs';

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

await check('analyze hands off to the background function', async () => {
  process.env.URL = 'https://example.netlify.app';
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(typeof input === 'string' ? input : input.url);
    if (url.includes('analyze-background')) {
      seen.push({ url, auth: init?.headers?.Authorization });
      return new Response('', { status: 202 });
    }
    return realFetch(input, init);
  };

  const res = await call('/api/analyze', { method: 'POST' });
  globalThis.fetch = realFetch;

  assert.equal(res.statusCode, 202);
  assert.equal(JSON.parse(res.body).started, true);
  assert.equal(seen.length, 1, 'background function was not invoked');
  assert.equal(seen[0].auth, AUTH, 'credentials must be forwarded to the background function');
});

console.log('\nnetlify: OK');
