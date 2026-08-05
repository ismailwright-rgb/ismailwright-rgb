import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), 'data');
const ANALYSIS_FILE = path.join(DATA_DIR, 'analysis.json');
const TRADE_LOG_FILE = path.join(DATA_DIR, 'trades.json');

// The current analysis is held in memory and mirrored to disk, so a container
// restart mid-session does not lose the run you were about to trade on.
let analysis = null;
let tradeLog = [];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

export async function init() {
  analysis = await readJson(ANALYSIS_FILE, null);
  tradeLog = await readJson(TRADE_LOG_FILE, []);
}

export function getAnalysis() {
  return analysis;
}

export async function setAnalysis(next) {
  analysis = next;
  await writeJson(ANALYSIS_FILE, next).catch(() => {});
  return analysis;
}

export function analysisAgeSeconds() {
  if (!analysis?.generatedAt) return Infinity;
  return (Date.now() - new Date(analysis.generatedAt).getTime()) / 1000;
}

export function getTradeLog() {
  return tradeLog;
}

export async function appendTrade(entry) {
  tradeLog = [{ ...entry, loggedAt: new Date().toISOString() }, ...tradeLog].slice(0, 200);
  await writeJson(TRADE_LOG_FILE, tradeLog).catch(() => {});
  return tradeLog;
}
