import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

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
// Somewhere writable on every host, including a read-only serverless filesystem.
const FALLBACK_DIR = path.join(tmpdir(), 'apace-data');

let activeDir = DATA_DIR;
const filePath = (dir, key) => path.join(dir, `${key}.json`);

const fileBackend = {
  async read(key, fallback) {
    for (const dir of new Set([activeDir, DATA_DIR, FALLBACK_DIR])) {
      try {
        return JSON.parse(await readFile(filePath(dir, key), 'utf8'));
      } catch {
        // try the next location
      }
    }
    return fallback;
  },
  async write(key, value) {
    const body = JSON.stringify(value, null, 2);
    try {
      await mkdir(activeDir, { recursive: true });
      await writeFile(filePath(activeDir, key), body);
    } catch (error) {
      if (activeDir === FALLBACK_DIR) throw error;
      // A read-only or missing data directory must not take a toggle down with
      // it. Move to the temp directory and stay there.
      console.warn(`store: ${activeDir} is not writable (${error.code}); falling back to ${FALLBACK_DIR}`);
      activeDir = FALLBACK_DIR;
      await mkdir(activeDir, { recursive: true });
      await writeFile(filePath(activeDir, key), body);
    }
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
      const found = await store.get(key, { type: 'json' });
      if (found != null) return found;
    } catch {
      // Blobs may not be enabled on the site; fall through to the filesystem.
    }
    return fileBackend.read(key, fallback);
  },
  async write(key, value) {
    try {
      const store = await getBlobStore();
      await store.setJSON(key, value);
      return;
    } catch (error) {
      // Without Blobs enabled the temp directory still gives per-instance
      // persistence, which is worse than shared state but far better than a
      // dashboard whose switches throw.
      console.warn(`store: Netlify Blobs unavailable (${error.message}); writing to the filesystem instead`);
      await fileBackend.write(key, value);
    }
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
