/**
 * What each symbol on the watchlist actually is.
 *
 * Used to badge rows in the dashboard and to give the model the right context -
 * "the euro is strengthening against the dollar" is the correct reading of FXE,
 * and it is not the sort of thing to infer from a ticker.
 *
 * On currencies: Alpaca does not offer FX pairs. It trades US equities, ETFs,
 * options and crypto. A currency view therefore has to be expressed through an
 * ETF that holds the currency, which is what these are. They trade only during
 * US equity hours, so a move made during the London session shows up as a gap at
 * 09:30 ET rather than something you could have traded into.
 */

const CURRENCY = 'currency';
const COMMODITY = 'commodity';
const INDEX = 'index';
const EQUITY = 'equity';

export const UNIVERSE = {
  // Crypto. Trades continuously, so session-based measures do not apply.
  'BTC/USD': { group: 'crypto', note: 'Bitcoin. Trades 24/7, so there is no opening range and no close to be flat by.' },
  'ETH/USD': { group: 'crypto', note: 'Ethereum. Trades 24/7 and moves largely with Bitcoin - treat the pair as one exposure.' },

  // Currency ETFs - the closest tradeable proxies for the major pairs.
  UUP: { group: CURRENCY, note: 'US dollar index. Rises when the dollar strengthens against a basket - roughly the inverse of EUR/USD.' },
  FXE: { group: CURRENCY, note: 'Holds euros. A proxy for EUR/USD: up means the euro is strengthening against the dollar.' },
  FXB: { group: CURRENCY, note: 'Holds British pounds. A proxy for GBP/USD: up means sterling is strengthening against the dollar.' },

  // Commodities.
  GLD: { group: COMMODITY, note: 'Gold. Often moves inversely to the dollar and to real yields.' },
  SLV: { group: COMMODITY, note: 'Silver. More volatile than gold and more sensitive to industrial demand.' },
  CPER: { group: COMMODITY, note: 'Copper. A cyclical read on industrial demand.' },

  // Broad market.
  SPY: { group: INDEX, note: 'S&P 500. The benchmark every other score is measured against.' },
  QQQ: { group: INDEX, note: 'Nasdaq 100. Tech-weighted; leads the market on risk-on days.' },
};

const DEFAULT = { group: EQUITY, note: null };

export const describe = (symbol) => UNIVERSE[symbol] ?? DEFAULT;

/**
 * Currency ETFs move on the same drivers, so treating them as independent
 * candidates would be double counting. Surfaced to the UI as a caution.
 */
export const CORRELATED_GROUPS = [
  ['UUP', 'FXE', 'FXB'],
  ['GLD', 'SLV'],
  ['SPY', 'QQQ'],
  ['BTC/USD', 'ETH/USD'],
];

export function correlatedWith(symbol) {
  const group = CORRELATED_GROUPS.find((g) => g.includes(symbol));
  return group ? group.filter((s) => s !== symbol) : [];
}
