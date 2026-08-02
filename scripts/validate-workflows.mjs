#!/usr/bin/env node
// Structural validator for the n8n workflow JSON files in n8n/workflows/.
// Zero dependencies. Usage: node scripts/validate-workflows.mjs
//
// Checks (per workflow):
//   1. Valid JSON
//   2. Top-level keys: name, nodes (array), connections (object), settings
//   3. Nodes: unique names + ids, type is n8n-nodes-base.*, numeric
//      typeVersion, position [x, y]
//   4. Connections: every source key and every target references an existing
//      node name
//   5. Reachability: BFS from trigger nodes reaches every non-sticky node
//   6. Every splitInBatches node has both outputs wired (done + loop)
//   7. No secret-looking literals in the JSON
//   8. Every "={{" expression has balanced "}}"

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowDirs = [
  join(repoRoot, 'n8n', 'workflows'),
  join(repoRoot, 'sanaku', 'n8n', 'workflows'),
];
const TRIGGER_TYPES = [
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.gmailTrigger',
];
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9_\-]{20,}/,
  /eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}/, // JWT-looking literal
  /sk-[A-Za-z0-9]{20,}/,
];

let failures = 0;
const fail = (file, msg) => {
  failures++;
  console.error(`  FAIL  ${file}: ${msg}`);
};

const files = workflowDirs.flatMap((dir) => {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => ({ dir, name: f }));
  } catch {
    return [];
  }
}).sort((a, b) => a.name.localeCompare(b.name));
if (files.length === 0) {
  console.error(`No workflow JSON files found in: ${workflowDirs.join(', ')}`);
  process.exit(1);
}

for (const { dir, name: file } of files) {
  const raw = readFileSync(join(dir, file), 'utf8');

  let wf;
  try {
    wf = JSON.parse(raw);
  } catch (e) {
    fail(file, `invalid JSON: ${e.message}`);
    continue;
  }

  if (typeof wf.name !== 'string' || !wf.name) fail(file, 'missing top-level "name"');
  if (!Array.isArray(wf.nodes)) { fail(file, '"nodes" is not an array'); continue; }
  if (typeof wf.connections !== 'object' || wf.connections === null) { fail(file, '"connections" is not an object'); continue; }
  if (typeof wf.settings !== 'object' || wf.settings === null) fail(file, 'missing "settings" object');

  // --- nodes ---
  const names = new Set();
  const ids = new Set();
  for (const node of wf.nodes) {
    if (!node.name) { fail(file, 'node with no name'); continue; }
    if (names.has(node.name)) fail(file, `duplicate node name "${node.name}"`);
    names.add(node.name);
    if (!node.id) fail(file, `node "${node.name}" has no id`);
    else if (ids.has(node.id)) fail(file, `duplicate node id "${node.id}"`);
    ids.add(node.id);
    if (!/^n8n-nodes-base\./.test(node.type ?? '')) fail(file, `node "${node.name}" has unexpected type "${node.type}"`);
    if (typeof node.typeVersion !== 'number') fail(file, `node "${node.name}" has non-numeric typeVersion`);
    if (!Array.isArray(node.position) || node.position.length !== 2 || node.position.some((p) => typeof p !== 'number')) {
      fail(file, `node "${node.name}" has invalid position`);
    }
  }

  // --- connections reference existing node names ---
  const adjacency = new Map(); // source name -> Set of target names
  for (const [source, byType] of Object.entries(wf.connections)) {
    if (!names.has(source)) fail(file, `connections key "${source}" is not a node name`);
    for (const outputs of Object.values(byType)) {
      for (const output of outputs) {
        if (output == null) continue;
        for (const target of output) {
          if (!names.has(target.node)) fail(file, `connection ${source} -> "${target.node}" targets a missing node`);
          if (!adjacency.has(source)) adjacency.set(source, new Set());
          adjacency.get(source).add(target.node);
        }
      }
    }
  }

  // --- reachability from triggers (loop-backs are fine with BFS) ---
  const triggers = wf.nodes.filter((n) => TRIGGER_TYPES.includes(n.type)).map((n) => n.name);
  if (triggers.length === 0) fail(file, 'no trigger node found');
  const reachable = new Set(triggers);
  const queue = [...triggers];
  while (queue.length) {
    for (const next of adjacency.get(queue.shift()) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
  }
  for (const node of wf.nodes) {
    if (node.type === 'n8n-nodes-base.stickyNote') continue;
    if (!reachable.has(node.name)) fail(file, `node "${node.name}" is unreachable from any trigger`);
  }

  // --- splitInBatches must have both outputs wired (0 = done, 1 = loop) ---
  for (const node of wf.nodes) {
    if (node.type !== 'n8n-nodes-base.splitInBatches') continue;
    const outputs = wf.connections[node.name]?.main ?? [];
    const wired = (i) => Array.isArray(outputs[i]) && outputs[i].length > 0;
    if (!wired(0) || !wired(1)) fail(file, `splitInBatches "${node.name}" must have both outputs wired (done + loop)`);
  }

  // --- secrets ---
  for (const pattern of SECRET_PATTERNS) {
    const match = raw.match(pattern);
    if (match) fail(file, `possible secret literal in JSON: "${match[0].slice(0, 24)}..."`);
  }

  // --- expression balance: every "={{" string has matching "}}" ---
  const walk = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('={{') || value.includes('{{')) {
        const open = (value.match(/\{\{/g) ?? []).length;
        const close = (value.match(/\}\}/g) ?? []).length;
        if (open !== close) fail(file, `unbalanced expression braces in: "${value.slice(0, 60)}..."`);
      }
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(wf);

  console.log(`  ok    ${file} (${wf.nodes.length} nodes)`);
}


// ---------------------------------------------------------------------------
// Price parity: the sales sheet hardcodes prices in JS, the portal reads them
// from the database. They are quoted to the same prospect days apart, so a
// change in one and not the other is a credibility problem, not a typo.
// ---------------------------------------------------------------------------
function checkPrices() {
  const sqlPath = 'sanaku/supabase/ADDONS-RUN-THIS.sql';
  const htmlPath = 'sanaku/site/leak-audit.html';
  if (!existsSync(sqlPath) || !existsSync(htmlPath)) return;
  console.log('\nPrice parity (sales sheet vs catalog)');

  const sql = readFileSync(sqlPath, 'utf8');
  const rows = {};
  const starts = [...sql.matchAll(/^\('/gm)].map((m) => m.index);
  starts.forEach((st, i) => {
    const blk = sql.slice(st, starts[i + 1] ?? sql.length);
    const code = blk.match(/^\('([a-z0-9_]+)'/)[1];
    const m = blk.match(/array\[[^\]]*\],\s*(\d+),\s*(\d+),/);
    if (m) rows[code] = [+m[1], +m[2]];
  });

  const html = readFileSync(htmlPath, 'utf8');
  const blk = html.split('const PRICE = {')[1]?.split('\n  };')[0] ?? '';
  const grab = (ind, key) => {
    const seg = blk.split(ind + ':')[1] ?? '';
    const m = seg.match(new RegExp(key + ':\\[(\\d+),\\s*(\\d+)\\]'));
    return m ? [+m[1], +m[2]] : null;
  };
  const bundleOf = (ind) => {
    const seg = blk.split(ind + ':')[1] ?? '';
    const m = seg.match(/bundle: \[(\d+),\s*(\d+)\]/);
    return m ? [+m[1], +m[2]] : null;
  };

  const MAP = {
    home: [['missed', 'recover_missed_call_home'], ['afterhours', 'after_hours_intake_home'],
           ['nurture', 'nurture_home'], ['reminders', 'reminders_home'],
           ['agent', 'voice_reception_home'], ['callback', 'voice_callback_home']],
    dental: [['missed', 'recover_missed_call_medical'], ['afterhours', 'after_hours_intake_medical'],
             ['nurture', 'nurture_medical'], ['reminders', 'reminders_medical'],
             ['agent', 'voice_reception_medical']],
    law: [['missed', 'recover_missed_call_law'], ['afterhours', 'after_hours_intake_law'],
          ['nurture', 'nurture_law'], ['reminders', 'reminders_law'],
          ['agent', 'voice_reception_law'], ['callback', 'voice_callback_law']],
  };
  const BUNDLE = { home: 'bundle_recovery_home', dental: 'bundle_recovery_medical', law: 'bundle_recovery_law' };
  const same = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  let n = 0;
  for (const [ind, pairs] of Object.entries(MAP)) {
    for (const [key, code] of pairs) {
      const h = grab(ind, key), s = rows[code];
      if (!same(h, s)) { fail(htmlPath, `${ind}.${key} (${code}): sheet=${h} catalog=${s}`); n++; }
    }
    if (!same(bundleOf(ind), rows[BUNDLE[ind]])) {
      fail(htmlPath, `${ind}.bundle: sheet=${bundleOf(ind)} catalog=${rows[BUNDLE[ind]]}`); n++;
    }
  }
  // The one-pager carries its own copy of the bundle and voice prices.
  const opPath = 'sanaku/site/one-pager.html';
  if (existsSync(opPath)) {
    const op = readFileSync(opPath, 'utf8');
    const OP = { home: 'bundle_recovery_home', dental: 'bundle_recovery_medical', law: 'bundle_recovery_law' };
    const OPV = { home: 'voice_reception_home', dental: 'voice_reception_medical', law: 'voice_reception_law' };
    for (const ind of Object.keys(OP)) {
      const line = op.split('\n').find((l) => l.trim().startsWith(ind + ':'));
      if (!line) { fail(opPath, `no row for ${ind}`); n++; continue; }
      const b = line.match(/bundle:\[(\d+),(\d+)\]/);
      const v = line.match(/voice:\[(\d+),(\d+)\]/);
      if (!same(b && [+b[1], +b[2]], rows[OP[ind]])) {
        fail(opPath, `${ind} bundle: one-pager=${b && [+b[1], +b[2]]} catalog=${rows[OP[ind]]}`); n++;
      }
      if (!same(v && [+v[1], +v[2]], rows[OPV[ind]])) {
        fail(opPath, `${ind} voice: one-pager=${v && [+v[1], +v[2]]} catalog=${rows[OPV[ind]]}`); n++;
      }
    }
  }

  if (n === 0) console.log(`  ok    sheet + one-pager match all ${Object.keys(rows).length} catalog rows`);
}
checkPrices();

if (failures > 0) {
  console.error(`\n${failures} validation failure(s).`);
  process.exit(1);
}
console.log('\nAll workflows valid.');
