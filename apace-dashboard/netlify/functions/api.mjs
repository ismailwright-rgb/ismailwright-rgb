/**
 * The dashboard and its API, behind one function.
 *
 * Everything is built lazily on the first request rather than at import time.
 * The catch-all redirect sends the whole site through here, so a module that
 * throws while loading takes down the page as well as the API - and a blank
 * site tells you nothing. Startup failures are caught and returned as a
 * readable page instead.
 *
 * Lazy also means no top-level await, which the CommonJS bundle Netlify
 * produces cannot express.
 */

let app = null;
let startupError = null;

async function ensureApp() {
  if (app || startupError) return;
  try {
    const [{ default: serverless }, { createApp }] = await Promise.all([
      import('serverless-http'),
      import('../../server/app.js'),
    ]);
    app = serverless(createApp());
  } catch (error) {
    startupError = error;
    console.error('Apace failed to start:', error);
  }
}

const CONFIG_HINTS = [
  ['ALPACA_KEY_ID', 'Your paper key, starting with PK.'],
  ['ALPACA_SECRET_KEY', 'The matching secret.'],
  ['DASHBOARD_USER', 'Any username. Required on a public deployment.'],
  ['DASHBOARD_PASSWORD', 'A long random string. Required on a public deployment.'],
];

function startupPage(error) {
  const missing = CONFIG_HINTS.filter(([name]) => !process.env[name]);
  const lines = [
    'Apace could not start.',
    '',
    error.message,
    '',
  ];

  if (missing.length) {
    lines.push('These environment variables are not set on this deployment:', '');
    for (const [name, hint] of missing) lines.push(`  ${name}  —  ${hint}`);
    lines.push('', 'Set them in Netlify under Site configuration → Environment variables, then redeploy.');
  } else {
    lines.push('All the required environment variables are present, so this is not a missing key.');
    lines.push('Check the function log in Netlify under Functions → api for the full stack trace.');
  }

  return lines.join('\n');
}

export const handler = async (event, context) => {
  await ensureApp();

  if (startupError) {
    return {
      statusCode: 500,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: startupPage(startupError),
    };
  }

  return app(event, context);
};
