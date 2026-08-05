import { config } from './config.js';

const authHeaders = {
  'APCA-API-KEY-ID': config.keyId,
  'APCA-API-SECRET-KEY': config.secretKey,
};

class AlpacaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'AlpacaError';
    this.status = status;
    this.body = body;
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { ...authHeaders, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });

  const text = await response.text();
  let payload = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // Alpaca returns plain text on some gateway errors; keep the raw string.
  }

  if (!response.ok) {
    const detail = typeof payload === 'object' && payload?.message ? payload.message : String(payload).slice(0, 300);
    throw new AlpacaError(`Alpaca ${response.status} on ${new URL(url).pathname}: ${detail}`, response.status, payload);
  }
  return payload;
}

const trading = (path, options) => request(`${config.tradingUrl}${path}`, options);
const data = (path) => request(`${config.dataUrl}${path}`);

export const getAccount = () => trading('/v2/account');
export const getClock = () => trading('/v2/clock');
export const getPositions = () => trading('/v2/positions');

export const getCalendar = ({ start, end }) =>
  trading(`/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);

export async function getLatestQuotes(symbols) {
  const params = new URLSearchParams({ symbols: symbols.join(','), feed: config.feed });
  const result = await data(`/v2/stocks/quotes/latest?${params}`);
  return result?.quotes || {};
}

/**
 * Intraday bars for the current session. Alpaca paginates with next_page_token,
 * and a full day of 5-minute bars across a large watchlist exceeds one page.
 */
export async function getIntradayBars(symbols, { timeframe = '5Min', start }) {
  const bars = {};
  let pageToken = null;

  do {
    const params = new URLSearchParams({
      symbols: symbols.join(','),
      timeframe,
      start,
      limit: '10000',
      adjustment: 'raw',
      feed: config.feed,
    });
    if (pageToken) params.set('page_token', pageToken);

    const page = await data(`/v2/stocks/bars?${params}`);
    for (const [symbol, list] of Object.entries(page?.bars || {})) {
      bars[symbol] = (bars[symbol] || []).concat(list);
    }
    pageToken = page?.next_page_token || null;
  } while (pageToken);

  return bars;
}

export async function getDailyBars(symbols, { days = 30 } = {}) {
  const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    timeframe: '1Day',
    start,
    limit: '10000',
    adjustment: 'split',
    feed: config.feed,
  });
  const result = await data(`/v2/stocks/bars?${params}`);
  return result?.bars || {};
}

/**
 * Crypto lives on a different API version and, unlike equities, trades 24/7 -
 * so there is no session to bound a request by.
 */
export async function getCryptoQuotes(symbols) {
  if (!symbols.length) return {};
  const params = new URLSearchParams({ symbols: symbols.join(',') });
  const result = await data(`/v1beta3/crypto/us/latest/quotes?${params}`);
  return result?.quotes || {};
}

export async function getCryptoBars(symbols, { timeframe = '5Min', hoursBack = 48 } = {}) {
  if (!symbols.length) return {};

  const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const bars = {};
  let pageToken = null;

  do {
    const params = new URLSearchParams({ symbols: symbols.join(','), timeframe, start, limit: '10000' });
    if (pageToken) params.set('page_token', pageToken);

    const page = await data(`/v1beta3/crypto/us/bars?${params}`);
    for (const [symbol, list] of Object.entries(page?.bars || {})) {
      bars[symbol] = (bars[symbol] || []).concat(list);
    }
    pageToken = page?.next_page_token || null;
  } while (pageToken);

  return bars;
}

export async function getNews(symbols, { limit = 50, hoursBack = 36 } = {}) {
  const start = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    start,
    limit: String(limit),
    sort: 'desc',
  });
  const result = await data(`/v1beta1/news?${params}`);

  const bySymbol = {};
  for (const article of result?.news || []) {
    for (const symbol of article.symbols || []) {
      if (!symbols.includes(symbol)) continue;
      (bySymbol[symbol] ||= []).push({
        headline: article.headline,
        summary: (article.summary || '').slice(0, 400),
        source: article.source,
        url: article.url,
        createdAt: article.created_at,
      });
    }
  }
  return bySymbol;
}

export function placeBracketOrder({ symbol, qty, entryType, limitPrice, stopPrice, takeProfitPrice, clientOrderId }) {
  const body = {
    symbol,
    qty: String(qty),
    side: 'buy',
    type: entryType,
    time_in_force: 'day',
    order_class: 'bracket',
    client_order_id: clientOrderId,
    take_profit: { limit_price: takeProfitPrice.toFixed(2) },
    stop_loss: { stop_price: stopPrice.toFixed(2) },
  };
  if (entryType === 'limit') body.limit_price = limitPrice.toFixed(2);

  return trading('/v2/orders', { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Crypto entry. Alpaca does not accept bracket or OCO orders on crypto, so the
 * stop cannot rest at the exchange - there is only a plain buy here, and the
 * stop exists solely as a rule the exit loop enforces. That is a materially
 * weaker guarantee than an equity bracket, and the caller has to know it.
 */
export function placeCryptoOrder({ symbol, notional, clientOrderId }) {
  return trading('/v2/orders', {
    method: 'POST',
    body: JSON.stringify({
      symbol,
      notional: String(notional),
      side: 'buy',
      type: 'market',
      time_in_force: 'gtc', // "day" is rejected for crypto
      client_order_id: clientOrderId,
    }),
  });
}

/** Alpaca reports crypto positions without the slash; "BTC/USD" and "BTCUSD" are one position. */
export const normaliseSymbol = (value) =>
  String(value ?? '').toUpperCase().replace(/\s+/g, '').replace(/\//g, '');

export const closePosition = (symbol) =>
  trading(`/v2/positions/${encodeURIComponent(symbol)}?cancel_orders=true`, { method: 'DELETE' });

export const closeAllPositions = () => trading('/v2/positions?cancel_orders=true', { method: 'DELETE' });

export const getOpenOrders = () => trading('/v2/orders?status=open&limit=200&nested=false');

/** Move a resting stop without cancelling and re-placing it. */
export const replaceOrder = (orderId, patch) =>
  trading(`/v2/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', body: JSON.stringify(patch) });

export const getOrders = (status = 'all', limit = 50) =>
  trading(`/v2/orders?status=${status}&limit=${limit}&direction=desc&nested=true`);

export { AlpacaError };
