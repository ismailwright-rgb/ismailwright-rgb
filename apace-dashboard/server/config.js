const PAPER_HOST = 'https://paper-api.alpaca.markets';

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return parsed;
}

const tradingUrl = (process.env.ALPACA_TRADING_URL || PAPER_HOST).replace(/\/+$/, '');
const isPaper = tradingUrl === PAPER_HOST;
const allowLive = process.env.ALLOW_LIVE === 'true';

// Refuse to boot pointed at real money unless it was asked for twice: a non-paper
// host AND an explicit opt-in. A typo in one place should never move real capital.
if (!isPaper && !allowLive) {
  throw new Error(
    `ALPACA_TRADING_URL is "${tradingUrl}", which is not the paper endpoint. ` +
      'Set ALLOW_LIVE=true if you genuinely intend to trade real money, or set ' +
      `ALPACA_TRADING_URL=${PAPER_HOST}.`,
  );
}

export const config = {
  paperHost: PAPER_HOST,
  tradingUrl,
  dataUrl: 'https://data.alpaca.markets',
  isPaper,
  allowLive,
  keyId: process.env.ALPACA_KEY_ID || '',
  secretKey: process.env.ALPACA_SECRET_KEY || '',
  feed: process.env.ALPACA_DATA_FEED || 'iex',

  openRouterKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-sonnet-4.5',

  watchlist: (process.env.WATCHLIST || 'SPY,QQQ,AAPL,MSFT,NVDA')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),

  riskPctPerTrade: num('RISK_PCT_PER_TRADE', 0.5),
  maxNotionalPerOrder: num('MAX_NOTIONAL_PER_ORDER', 500),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 4),
  minScoreToTrade: num('MIN_SCORE_TO_TRADE', 70),
  maxSpreadBps: num('MAX_SPREAD_BPS', 25),
  minMinutesToClose: num('MIN_MINUTES_TO_CLOSE', 30),
  maxAnalysisAgeSeconds: num('MAX_ANALYSIS_AGE_SECONDS', 600),
  targetRMultiple: num('TARGET_R_MULTIPLE', 2),

  port: num('PORT', 8080),
  dashboardUser: process.env.DASHBOARD_USER || '',
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // Netlify sets NETLIFY=true in both builds and function runtimes.
  isServerless: process.env.NETLIFY === 'true' || Boolean(process.env.NETLIFY_DEV),

  // Order placement is opt-in. On a public host it stays off unless explicitly
  // enabled, so a deploy cannot quietly expose a trade button to the internet.
  enableTrading: process.env.ENABLE_TRADING
    ? process.env.ENABLE_TRADING === 'true'
    : !(process.env.NETLIFY === 'true' || Boolean(process.env.NETLIFY_DEV)),
};

// A public URL with no gate in front of it is not acceptable, whatever it serves:
// the dashboard exposes account equity and positions even with trading disabled.
if (config.isServerless && !config.dashboardUser) {
  throw new Error(
    'DASHBOARD_USER and DASHBOARD_PASSWORD are required when deploying to a public host. ' +
      'Set them in your Netlify site environment variables.',
  );
}

if (config.dashboardUser && !config.dashboardPassword) {
  throw new Error('DASHBOARD_USER is set but DASHBOARD_PASSWORD is empty.');
}

if (!config.keyId || !config.secretKey) {
  throw new Error('ALPACA_KEY_ID and ALPACA_SECRET_KEY are required. Copy .env.example to .env.');
}
