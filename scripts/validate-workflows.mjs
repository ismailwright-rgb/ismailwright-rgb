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

import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const workflowsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'n8n', 'workflows');
const TRIGGER_TYPES = [
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.manualTrigger',
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

const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.json')).sort();
if (files.length === 0) {
  console.error(`No workflow JSON files found in ${workflowsDir}`);
  process.exit(1);
}

for (const file of files) {
  const raw = readFileSync(join(workflowsDir, file), 'utf8');

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

if (failures > 0) {
  console.error(`\n${failures} validation failure(s).`);
  process.exit(1);
}
console.log('\nAll workflows valid.');
