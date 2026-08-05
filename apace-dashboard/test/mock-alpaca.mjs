/**
 * Synthetic Alpaca + OpenRouter surface, shared by the smoke test and the local
 * UI preview. Nothing here touches the network or an account.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

const PROFILES = {
  NVDA: { base: 132, drift: 0.00055, noise: 0.0032, volume: 2.4, spreadPct: 0.0004 },
  MSFT: { base: 418, drift: 0.00018, noise: 0.0022, volume: 1.3, spreadPct: 0.0004 },
  AAPL: { base: 221, drift: 0.00002, noise: 0.0021, volume: 0.95, spreadPct: 0.0005 },
  GRAB: { base: 4.85, drift: 0.00026, noise: 0.0045, volume: 1.7, spreadPct: 0.0011 },
  PLUG: { base: 2.35, drift: -0.00048, noise: 0.006, volume: 0.6, spreadPct: 0.0032 },
  SPY: { base: 566, drift: 0.00008, noise: 0.0012, volume: 1, spreadPct: 0.0002 },
  'BTC/USD': { base: 94000, drift: 0.00035, noise: 0.006, volume: 1.4, spreadPct: 0.0006 },
  'ETH/USD': { base: 3200, drift: 0.00015, noise: 0.008, volume: 1.1, spreadPct: 0.0009 },
};
const DEFAULT_PROFILE = { base: 60, drift: 0, noise: 0.0025, volume: 1, spreadPct: 0.0006 };

const profileFor = (symbol) => PROFILES[symbol] ?? DEFAULT_PROFILE;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const seedOf = (symbol) => [...symbol].reduce((acc, ch) => acc * 31 + ch.charCodeAt(0), 7);

const BAR_MS = 5 * 60 * 1000;
// 13:30 UTC is the regular-session open for most of the year.
const OPEN_BAR_OF_DAY = (13 * 60 + 30) / 5;

export function fiveMinuteBars(symbol) {
  const { base, drift, noise, volume } = profileFor(symbol);
  const rng = makeRng(seedOf(symbol));
  const bars = [];

  const start = Date.now() - 10 * DAY_MS;
  for (let t = start; t <= Date.now(); t += BAR_MS) {
    // Anchor the trend to each day's open rather than compounding across the
    // whole window, so prices stay near their real-world level.
    const barOfDay = (t % DAY_MS) / BAR_MS;
    const barsIntoSession = Math.max(0, barOfDay - OPEN_BAR_OF_DAY);

    // A sine wobble on top of the drift keeps RSI in a realistic band instead of
    // pinning at 100 the way a pure ramp would.
    const wobble = Math.sin(t / (41 * 60 * 1000)) * noise * 1.6;
    const price = Math.max(0.5, base * (1 + drift * barsIntoSession + wobble + (rng() - 0.5) * noise));

    const high = price * (1 + rng() * noise * 0.4);
    const low = price * (1 - rng() * noise * 0.4);
    bars.push({
      t: new Date(t).toISOString(),
      o: Number((price * (1 - noise * 0.1)).toFixed(2)),
      h: Number(high.toFixed(2)),
      l: Number(low.toFixed(2)),
      c: Number(price.toFixed(2)),
      v: Math.round((18000 + rng() * 26000) * volume),
      vw: Number(price.toFixed(2)),
      n: 120,
    });
  }
  return bars;
}

export function cryptoBars(symbol, hoursBack = 48) {
  const { base, drift, noise, volume } = profileFor(symbol);
  const rng = makeRng(seedOf(symbol) + 11);
  const bars = [];

  const start = Date.now() - hoursBack * 60 * 60 * 1000;
  const steps = (hoursBack * 60) / 5;
  let i = 0;

  for (let t = start; t <= Date.now(); t += BAR_MS, i += 1) {
    // Continuous drift - unlike equities there is no daily open to anchor to.
    const wobble = Math.sin(t / (53 * 60 * 1000)) * noise * 1.4;
    const price = Math.max(1, base * (1 + drift * i * 0.4 + wobble + (rng() - 0.5) * noise));
    bars.push({
      t: new Date(t).toISOString(),
      o: Number((price * (1 - noise * 0.1)).toFixed(2)),
      h: Number((price * (1 + rng() * noise * 0.4)).toFixed(2)),
      l: Number((price * (1 - rng() * noise * 0.4)).toFixed(2)),
      c: Number(price.toFixed(2)),
      v: Number(((12 + rng() * 20) * volume).toFixed(4)),
      vw: Number(price.toFixed(2)),
      n: 400,
    });
  }
  void steps;
  return bars;
}

export function dailyBars(symbol) {
  const { base } = profileFor(symbol);
  const rng = makeRng(seedOf(symbol) + 5);
  const bars = [];
  let price = base * 0.94;

  for (let i = 45; i >= 0; i -= 1) {
    price *= 1 + (rng() - 0.47) * 0.018;
    bars.push({
      t: new Date(Date.now() - i * DAY_MS).toISOString(),
      o: Number(price.toFixed(2)),
      h: Number((price * 1.012).toFixed(2)),
      l: Number((price * 0.988).toFixed(2)),
      c: Number(price.toFixed(2)),
      v: 4_200_000,
    });
  }
  return bars;
}

export function calendar() {
  const days = [];
  for (let i = 12; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * DAY_MS);
    const weekday = date.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    days.push({ date: date.toISOString().slice(0, 10), open: '09:30', close: '16:00' });
  }
  return days;
}

const NEWS = [
  { symbols: ['NVDA'], headline: 'Datacentre orders lift chip supplier guidance for the quarter', source: 'benzinga' },
  { symbols: ['NVDA'], headline: 'Analysts raise targets after supply commentary', source: 'reuters' },
  { symbols: ['PLUG'], headline: 'Hydrogen developer files to sell additional shares', source: 'globenewswire' },
  { symbols: ['AAPL'], headline: 'Supply chain checks point to steady build rates', source: 'bloomberg' },
  { symbols: ['GRAB'], headline: 'Ride-hailing volumes climb in southeast Asian markets', source: 'reuters' },
];

const MODEL_REPLY = {
  symbols: [
    {
      symbol: 'NVDA',
      sentiment: 0.6,
      catalyst: 'Raised datacentre guidance',
      reasons_for: [
        'Trading above VWAP with EMA9 over EMA20 all session.',
        'Broke and held above the opening range high on heavy volume.',
        'Guidance headline is same-day and directionally positive.',
      ],
      reasons_against: [
        'Already extended from the opening range, so the entry is late.',
        'A gap-fill back toward VWAP would take out a tight stop.',
      ],
      veto: false,
      veto_reason: null,
    },
    {
      symbol: 'GRAB',
      sentiment: 0.2,
      catalyst: null,
      reasons_for: ['Outperforming SPY on the session.', 'Volume is running above its own average.'],
      reasons_against: [
        'Spread is wide for the price, so slippage eats a large share of the move.',
        'Headline is regional colour, not a same-day catalyst.',
      ],
      veto: false,
      veto_reason: null,
    },
    {
      symbol: 'PLUG',
      sentiment: -0.7,
      catalyst: 'Share offering filed',
      reasons_for: ['None that survive the offering.'],
      reasons_against: [
        'An at-market offering caps upside for the session.',
        'Price is below VWAP and below the opening range low.',
        'Thin volume means the tape can move against the position quickly.',
      ],
      veto: true,
      veto_reason: 'Dilutive share offering filed before the open',
    },
  ],
};

/** Replaces globalThis.fetch. Returns the array of captured order payloads. */
export function installMock({ positions = [], account = {} } = {}) {
  const orders = [];

  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const { pathname, searchParams } = url;
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

    if (url.hostname === 'openrouter.ai') {
      return json({ choices: [{ message: { content: JSON.stringify(MODEL_REPLY) } }] });
    }

    switch (pathname) {
      case '/v2/account':
        return json({
          equity: '31450.22',
          buying_power: '62900.44',
          cash: '18220.10',
          daytrade_count: '1',
          pattern_day_trader: false,
          ...account,
        });

      case '/v2/positions':
        return json(positions);

      case '/v2/calendar':
        return json(calendar());

      case '/v2/clock':
        return json({ timestamp: new Date().toISOString(), is_open: true });

      case '/v2/stocks/quotes/latest': {
        const quotes = {};
        for (const symbol of searchParams.get('symbols').split(',')) {
          const { base, spreadPct } = profileFor(symbol);
          const bars = fiveMinuteBars(symbol);
          const mid = bars[bars.length - 1]?.c ?? base;
          quotes[symbol] = {
            bp: Number((mid * (1 - spreadPct / 2)).toFixed(2)),
            ap: Number((mid * (1 + spreadPct / 2)).toFixed(2)),
            bs: 4,
            as: 4,
          };
        }
        return json({ quotes });
      }

      case '/v2/stocks/bars': {
        const daily = searchParams.get('timeframe') === '1Day';
        const bars = {};
        for (const symbol of searchParams.get('symbols').split(',')) {
          bars[symbol] = daily ? dailyBars(symbol) : fiveMinuteBars(symbol);
        }
        return json({ bars, next_page_token: null });
      }

      case '/v1beta3/crypto/us/latest/quotes': {
        const quotes = {};
        for (const symbol of searchParams.get('symbols').split(',')) {
          const { spreadPct } = profileFor(symbol);
          const series = cryptoBars(symbol);
          const mid = series[series.length - 1]?.c ?? 1;
          quotes[symbol] = {
            bp: Number((mid * (1 - spreadPct / 2)).toFixed(2)),
            ap: Number((mid * (1 + spreadPct / 2)).toFixed(2)),
            bs: 1,
            as: 1,
          };
        }
        return json({ quotes });
      }

      case '/v1beta3/crypto/us/bars': {
        const bars = {};
        for (const symbol of searchParams.get('symbols').split(',')) {
          bars[symbol] = cryptoBars(symbol);
        }
        return json({ bars, next_page_token: null });
      }

      case '/v1beta1/news': {
        const wanted = new Set(searchParams.get('symbols').split(','));
        const news = NEWS.filter((n) => n.symbols.some((s) => wanted.has(s))).map((n, i) => ({
          ...n,
          summary: 'Synthetic article body for local preview.',
          url: `https://example.com/story-${i}`,
          created_at: new Date(Date.now() - (i + 1) * 40 * 60 * 1000).toISOString(),
        }));
        return json({ news });
      }

      default:
        if (pathname === '/v2/orders' && options.method === 'POST') {
          const body = JSON.parse(options.body);
          orders.push(body);
          return json({ id: `mock-${orders.length}`, client_order_id: body.client_order_id, status: 'accepted' });
        }
        if (pathname.startsWith('/v2/positions/') && options.method === 'DELETE') {
          return json({ id: 'mock-close' });
        }
        throw new Error(`unmocked request: ${pathname}`);
    }
  };

  return orders;
}
