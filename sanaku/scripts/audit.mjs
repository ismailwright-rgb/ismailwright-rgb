/**
 * Whole-project audit. Run from the repo root:  node sanaku/scripts/audit.mjs
 *
 * Checks the things that fail silently in production rather than at build time:
 * a table the UI reads that no migration creates, a column that was renamed in
 * one place, a workflow posting to an endpoint that does not exist, an RPC the
 * app calls that was never defined. The build passes on every one of these.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const R = 'sanaku';
let problems = 0;
const bad = (where, msg) => { console.log(`  FAIL  ${where}: ${msg}`); problems++; };
const ok = (msg) => console.log(`  ok    ${msg}`);
const head = (t) => console.log(`\n${t}`);

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== 'node_modules' && f !== 'dist') walk(p, out); }
    else out.push(p);
  }
  return out;
};

// ---------------------------------------------------------------------------
// 1. What the database actually defines.
// ---------------------------------------------------------------------------
const sqlFiles = walk(join(R, 'supabase')).filter((f) => f.endsWith('.sql'));
const sql = sqlFiles.map((f) => readFileSync(f, 'utf8')).join('\n');

const tables = new Set();
for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?/gi)) tables.add(m[1]);
for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?([a-z0-9_]+)/gi)) tables.add(m[1]);
const funcs = new Set();
for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi)) funcs.add(m[1]);

// Columns added by ALTER, plus everything in each CREATE TABLE body.
const columns = {};
for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?(?:public\.)?([a-z0-9_]+)"?\s*\(([\s\S]*?)\n\);/gi)) {
  const t = m[1];
  columns[t] = columns[t] || new Set();
  for (const line of m[2].split('\n')) {
    const c = line.trim().match(/^"?([a-z][a-z0-9_]*)"?\s+[a-z]/i);
    if (c && !/^(constraint|primary|unique|check|foreign|references)$/i.test(c[1])) columns[t].add(c[1]);
  }
}
// One ALTER TABLE can add many columns in a single statement, so take the
// whole statement and pull every "add column" out of it. Matching only the
// first one made the audit report four columns as missing that were there -
// and an audit that cries wolf gets ignored, which is worse than no audit.
for (const m of sql.matchAll(/alter\s+table\s+(?:public\.)?([a-z0-9_]+)([\s\S]*?);/gi)) {
  const [, t, body] = m;
  columns[t] = columns[t] || new Set();
  for (const c of body.matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z0-9_]+)"?/gi)) {
    columns[t].add(c[1]);
  }
}

head(`Schema (${sqlFiles.length} .sql files)`);
ok(`${tables.size} tables/views, ${funcs.size} functions defined`);

// ---------------------------------------------------------------------------
// 2. Everything the dashboard reads or writes must exist.
// ---------------------------------------------------------------------------
head('Dashboard → database');
const src = walk(join(R, 'dashboard', 'src')).filter((f) => /\.jsx?$/.test(f));
const VIEW_ONLY = new Set(['sanaku_my_client', 'v_top_prospects', 'v_followups_due']);
for (const f of src) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\.from\(['"]([a-z0-9_]+)['"]\)/g)) {
    if (!tables.has(m[1])) bad(f, `reads table "${m[1]}" which no migration creates`);
  }
  for (const m of t.matchAll(/\.rpc\(['"]([a-z0-9_]+)['"]/g)) {
    if (!funcs.has(m[1])) bad(f, `calls rpc "${m[1]}" which is never defined`);
  }
  // Columns named in an insert/update object literal against a known table.
  for (const m of t.matchAll(/\.from\(['"]([a-z0-9_]+)['"]\)\s*\.\s*(insert|update)\(\{([\s\S]{0,900}?)\}\)/g)) {
    const [, tbl, , body] = m;
    if (!columns[tbl] || VIEW_ONLY.has(tbl)) continue;
    for (const c of body.matchAll(/^\s{2,}([a-z][a-z0-9_]*)\s*:/gm)) {
      if (!columns[tbl].has(c[1])) bad(f, `${tbl}.${c[1]} does not exist in any migration`);
    }
  }
}
if (!problems) ok('every table, view, rpc and written column resolves');

// ---------------------------------------------------------------------------
// 3. Workflows must post to tables that exist, and carry no live secrets.
// ---------------------------------------------------------------------------
head('Workflows → database');
const wfDir = join(R, 'n8n', 'workflows');
const wfs = existsSync(wfDir) ? readdirSync(wfDir).filter((f) => f.endsWith('.json')) : [];
const before = problems;
for (const f of wfs) {
  const raw = readFileSync(join(wfDir, f), 'utf8');
  for (const m of raw.matchAll(/\/rest\/v1\/([a-z0-9_]+)/g)) {
    if (!tables.has(m[1])) bad(f, `posts to /rest/v1/${m[1]} which no migration creates`);
  }
  for (const m of raw.matchAll(/rpc\/([a-z0-9_]+)/g)) {
    if (!funcs.has(m[1])) bad(f, `calls rpc/${m[1]} which is never defined`);
  }
  if (/eyJ[A-Za-z0-9_-]{40,}/.test(raw)) bad(f, 'contains what looks like a real JWT');
}
if (problems === before) ok(`${wfs.length} workflows reference only real tables, no embedded keys`);

// ---------------------------------------------------------------------------
// 4. Every workflow the control script offers must actually exist.
// ---------------------------------------------------------------------------
head('Control script → workflows');
const sh = readFileSync(join(R, 'scripts', 'sanaku.sh'), 'utf8');
const before4 = problems;
const listBlock = sh.split("Workflow names for 'import'")[1]?.split('Import through')[0] ?? '';
for (const m of listBlock.matchAll(/^\s{2}([a-z0-9-]+)\s{2,}/gm)) {
  if (!wfs.includes(m[1] + '.json')) bad('sanaku.sh', `offers "import ${m[1]}" but ${m[1]}.json does not exist`);
}
for (const m of sh.matchAll(/import ([a-z0-9-]+)"/g)) {
  if (m[1] !== 'NAME' && !wfs.includes(m[1] + '.json')) {
    bad('sanaku.sh', `suggests "import ${m[1]}" but that workflow does not exist`);
  }
}
// Every subcommand named in the usage text must be dispatched, and vice versa.
const offered = new Set([...sh.matchAll(/sh ~\/sanaku\.sh ([a-z-]+)/g)].map((m) => m[1]));
const dispatch = new Set();
for (const m of sh.matchAll(/^\s{2}([a-z|-]+)\)\s+(?:shift; )?cmd_/gm)) m[1].split('|').forEach((x) => dispatch.add(x));
for (const c of offered) if (!dispatch.has(c)) bad('sanaku.sh', `usage advertises "${c}" but nothing dispatches it`);
if (problems === before4) ok(`${dispatch.size} subcommands, all dispatched; workflow names all real`);

// ---------------------------------------------------------------------------
// 5. Migrations must be reachable from a paste-in-one-go file.
// ---------------------------------------------------------------------------
head('Migrations → runnable files');
const migs = sqlFiles.filter((f) => /migration-\d+/.test(f)).sort();
const bundles = sqlFiles.filter((f) => /RUN-THIS|ADDONS-RUN/.test(f))
  .map((f) => readFileSync(f, 'utf8')).join('\n');
const before5 = problems;
for (const m of migs) {
  const body = readFileSync(m, 'utf8');
  const marker = (body.match(/create table if not exists ([a-z0-9_]+)/) ||
                  body.match(/insert into ([a-z0-9_]+)/) ||
                  body.match(/create or replace function public\.([a-z0-9_]+)/) || [])[1];
  if (marker && !bundles.includes(marker)) {
    bad(m.split('/').pop(), 'is in no RUN-THIS bundle — it can only be applied by hand');
  }
}
if (problems === before5) ok(`all ${migs.length} migrations appear in a paste-in-one-go file`);

// ---------------------------------------------------------------------------
// 6. Anything a client's browser can reach must not expose margin.
// ---------------------------------------------------------------------------
head('Client-facing safety');
const before6 = problems;
const portal = ['Portal.jsx', 'AddOns.jsx'].map((f) => join(R, 'dashboard', 'src', f)).filter(existsSync);
for (const f of portal) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\.from\(['"]([a-z0-9_]+)['"]\)/g)) {
    if (m[1] === 'sanaku_clients') {
      bad(f, 'reads sanaku_clients directly — that table carries your retainer and per-lead pricing; use sanaku_my_client');
    }
  }
  for (const c of ['monthly_retainer', 'rev_share_pct', 'per_lead_monthly_cap']) {
    if (t.includes(c)) bad(f, `mentions ${c}, which a client must never see`);
  }
}
if (problems === before6) ok('portal reads the filtered view only; no margin fields referenced');

// ---------------------------------------------------------------------------
// 7. Built but not wired. This is the class of gap that ships silently: the
//    table exists, the migration ran, and nothing in the product ever reads
//    or writes it - so the feature looks done and does nothing.
// ---------------------------------------------------------------------------
head('Built but not wired');
const allCode = [...src.map((f) => readFileSync(f, 'utf8')),
                 ...wfs.map((f) => readFileSync(join(wfDir, f), 'utf8'))].join('\n');
const IGNORE = new Set(['sanaku_staff', 'sanaku_client_users']);  // reached via policies/functions only
let dangling = 0;
for (const t of [...tables].sort()) {
  if (IGNORE.has(t) || !t.startsWith('sanaku_')) continue;
  const reads = allCode.includes(`'${t}'`) || allCode.includes(`/rest/v1/${t}`);
  if (!reads) { console.log(`  WARN  ${t}: no screen and no workflow touches this table`); dangling++; }
}
if (!dangling) ok('every table is read or written by something');

console.log(problems ? `\n${problems} problem(s) found.\n` : '\nNothing broken. Every reference resolves.\n');
process.exit(problems ? 1 : 0);
