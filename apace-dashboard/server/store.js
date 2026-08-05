import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { config } from './config.js';

/**
 * Two backends behind one interface.
 *
 * Locally the analysis and trade log live on disk. On Netlify there is no disk
 * that survives an invocation, so they live in Netlify Blobs instead - which
 * also means a cold start does not throw away the analysis you were about to
 * trade on.
 */

const ANALYSIS_KEY = 'analysis';
const TRADES_KEY = 'trades';

let analysis = null;
let tradeLog = [];
let initialised = false;

/* --- file backend ---------------------------------------------------------- */
const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const filePath = (key) => path.join(DATA_DIR, `${key}.json`);

const fileBackend = {
  async read(key, fallback) {
    try {
      return JSON.parse(await readFile(filePath(key), 'utf8'));
    } catch {
      return fallback;
    }
  },
  async write(key, value) {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(filePath(key), JSON.stringify(value, null, 2));
  },
};

/* --- netlify blobs backend ------------------------------------------------- */
let blobStore = null;

async function getBlobStore() {
  if (!blobStore) {
    const { getStore } = await import('@netlify/blobs');
    blobStore = getStore('apace');
  }
  return blobStore;
}

const blobBackend = {
  async read(key, fallback) {
    try {
      const store = await getBlobStore();
      return (await store.get(key, { type: 'json' })) ?? fallback;
    } catch {
      return fallback;
    }
  },
  async write(key, value) {
    const store = await getBlobStore();
    await store.setJSON(key, value);
  },
};

const backend = config.isServerless ? blobBackend : fileBackend;

/* --- interface ------------------------------------------------------------- */

/**
 * Safe to call repeatedly; a serverless cold start re-hydrates from the store.
 *
 * A failed or empty read leaves the in-process copy alone rather than replacing
 * it with a blank. Otherwise one transient blob error would wipe the analysis
 * someone is about to act on, and the dashboard would quietly show nothing.
 */
export async function init({ force = false } = {}) {
  if (initialised && !force) return;

  const [nextAnalysis, nextTrades] = await Promise.all([
    backend.read(ANALYSIS_KEY, undefined),
    backend.read(TRADES_KEY, undefined),
  ]);

  if (nextAnalysis !== undefined) analysis = nextAnalysis;
  if (nextTrades !== undefined) tradeLog = nextTrades;
  initialised = true;
}

/**
 * In a serverless runtime the in-process copy belongs to one invocation and may
 * be minutes stale, so always re-read before anything that gates a trade.
 */
export async function refresh() {
  if (config.isServerless) await init({ force: true });
}

export function getAnalysis() {
  return analysis;
}

export async function setAnalysis(next) {
  analysis = next;
  await backend.write(ANALYSIS_KEY, next).catch((error) => {
    console.error('could not persist analysis:', error.message);
  });
  return analysis;
}

export function analysisAgeSeconds() {
  if (!analysis?.generatedAt) return Infinity;
  return (Date.now() - new Date(analysis.generatedAt).getTime()) / 1000;
}

export function getTradeLog() {
  return tradeLog;
}

/** Generic key access, for state that does not need an in-memory mirror. */
export const readKey = (key, fallback) => backend.read(key, fallback);
export const writeKey = (key, value) => backend.write(key, value);

export async function appendTrade(entry) {
  // Re-read first: another invocation may have logged since this one started.
  if (config.isServerless) {
    tradeLog = await backend.read(TRADES_KEY, []);
  }
  tradeLog = [{ ...entry, loggedAt: new Date().toISOString() }, ...tradeLog].slice(0, 200);
  await backend.write(TRADES_KEY, tradeLog).catch((error) => {
    console.error('could not persist trade log:', error.message);
  });
  return tradeLog;
}
