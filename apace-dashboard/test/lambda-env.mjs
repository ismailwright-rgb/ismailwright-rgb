/**
 * Regression test for a crash on Netlify: "ENOENT: no such file or directory,
 * mkdir '/var/task/data'".
 *
 * NETLIFY=true is set during the BUILD, not in the function runtime, so the
 * deployed function believed it was on a normal server and tried to persist
 * state to a read-only Lambda filesystem. Every switch in the dashboard threw.
 *
 * Recreates that environment exactly: Lambda markers present, NETLIFY absent,
 * DATA_DIR unwritable.
 *
 *   node test/lambda-env.mjs
 */
import assert from 'node:assert/strict';

process.env.AWS_LAMBDA_FUNCTION_NAME = 'api';   // set by Lambda, NETLIFY is not
process.env.LAMBDA_TASK_ROOT = '/var/task';
delete process.env.NETLIFY;
process.env.DATA_DIR = '/var/task/data';        // read-only, as on Lambda
process.env.ALPACA_KEY_ID = 'PKTEST';
process.env.ALPACA_SECRET_KEY = 'secret';
process.env.DASHBOARD_USER = 'demo';
process.env.DASHBOARD_PASSWORD = 'pw';
process.env.WATCHLIST = 'NVDA,MSFT';

const { installMock } = await import('./mock-alpaca.mjs');
installMock();

const { config } = await import('../server/config.js');
const autopilot = await import('../server/autopilot.js');
const { flags } = await import('../server/runtime.js');

const check = async (name, fn) => {
  await fn();
  console.log(`  \u2713 ${name}`);
};

await check('a Lambda runtime is detected without NETLIFY being set', () => {
  assert.equal(config.isServerless, true, 'runtime markers were ignored');
  assert.equal(config.enableTrading, false, 'a public host must default to read-only');
});

await check('turning the autopilot on does not throw on a read-only filesystem', async () => {
  await autopilot.setEnabled(true);
  assert.equal(await autopilot.isEnabled(), true);
});

await check('turning it on enables order placement with it', async () => {
  const current = await flags();
  assert.equal(current.trading, true);
  assert.equal(current.source.autopilot, 'dashboard');
});

await check('turning it off leaves the flag readable, not corrupted', async () => {
  await autopilot.setEnabled(false);
  assert.equal(await autopilot.isEnabled(), false);
});

console.log('\nlambda-env: OK');
