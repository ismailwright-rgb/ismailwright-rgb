/**
 * Reproduces Netlify's build: bundles the function into CommonJS with esbuild,
 * lays it out the way Netlify does (base directory preserved, static files
 * alongside), and invokes it from a foreign working directory.
 *
 * This is not hypothetical. `import.meta.url` is replaced with an empty object
 * in a CommonJS bundle, so anything deriving a path from it throws at import
 * time and takes the whole function down before a single request is served.
 *
 *   node test/bundle.mjs
 */
import assert from 'node:assert/strict';
import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, '..');

// Mirror the deployed shape: /tmp/.../apace-dashboard/{netlify/functions,public}
const root = '/tmp/apace-bundle-test';
const base = path.join(root, 'apace-dashboard');

await rm(root, { recursive: true, force: true });
await mkdir(path.join(base, 'netlify', 'functions'), { recursive: true });

await build({
  entryPoints: [path.join(projectRoot, 'netlify', 'functions', 'api.mjs')],
  outfile: path.join(base, 'netlify', 'functions', 'api.js'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs', // the format that broke it
  logLevel: 'silent',
  external: ['@netlify/blobs'],
});

// included_files = ["public/**"], relative to the base directory.
await cp(path.join(projectRoot, 'public'), path.join(base, 'public'), { recursive: true });

const check = async (name, fn) => {
  await fn();
  console.log(`  ✓ ${name}`);
};

// Netlify runs functions from the task root, not from the function's folder.
const originalCwd = process.cwd();
process.chdir(root);

process.env.NETLIFY = 'true';
process.env.ALPACA_KEY_ID = 'PKTEST';
process.env.ALPACA_SECRET_KEY = 'testsecret';
process.env.DASHBOARD_USER = 'demo';
process.env.DASHBOARD_PASSWORD = 'correct-horse';

let handler;
await check('the CommonJS bundle imports without throwing', () => {
  // The original crash was here: TypeError from fileURLToPath(undefined).
  ({ handler } = require(path.join(base, 'netlify', 'functions', 'api.js')));
  assert.equal(typeof handler, 'function');
});

const AUTH = `Basic ${Buffer.from('demo:correct-horse').toString('base64')}`;
const call = (p, auth = true) =>
  handler(
    { httpMethod: 'GET', path: p, headers: auth ? { authorization: AUTH } : {}, body: null },
    {},
  );

await check('health responds from the bundle', async () => {
  const res = await call('/api/health', false);
  assert.equal(res.statusCode, 200);
});

await check('the dashboard page is found and served', async () => {
  const res = await call('/');
  assert.equal(res.statusCode, 200, `expected the page, got ${res.statusCode}: ${String(res.body).slice(0, 200)}`);
  assert.match(res.headers['content-type'] || '', /html/);
  assert.match(res.body, /Apace/);
});

await check('the stylesheet and script resolve too', async () => {
  for (const asset of ['/styles.css', '/app.js']) {
    const res = await call(asset);
    assert.equal(res.statusCode, 200, `${asset} returned ${res.statusCode}`);
  }
});

await check('auth still applies to bundled static files', async () => {
  const res = await call('/', false);
  assert.equal(res.statusCode, 401);
});

process.chdir(originalCwd);
await rm(root, { recursive: true, force: true });

console.log('\nbundle: OK');
