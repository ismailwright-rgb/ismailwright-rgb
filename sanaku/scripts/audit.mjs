/**
 * Whole-project audit. Run from the repo root:  node sanaku/scripts/audit.mjs
 *
 * Checks the things that fail silently in production rather than at build time:
 * a table the UI reads that no migration creates, a column that was renamed in
 * one place, a workflow posting to an endpoint that does not exist, an RPC the
 * app calls that was never defined. The build passes on every one of these.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolved from this file, not from the working directory. Run from anywhere
// but the repo root, a cwd-relative 'sanaku' resolved to nothing and the first
// sections reported "0 tables ... ok" - a clean pass over an empty file list,
// which is the worst possible failure for a checker.
const R = join(dirname(fileURLToPath(import.meta.url)), '..');
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
  // /rest/v1/rpc/<fn> is a function call, not a table. Checking it against the
  // table list reports every legitimate rpc as a missing table.
  for (const m of raw.matchAll(/\/rest\/v1\/(?!rpc\/)([a-z0-9_]+)/g)) {
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
// What a client pays for a catalog add-on (setup_fee, per_lead_fee on
// sanaku_addons) is quoted to them on purpose. What YOU make on them - the
// retainer, the rev share, the cap - never appears on their screen.
const MARGIN = ['monthly_retainer', 'rev_share_pct', 'per_lead_monthly_cap'];
for (const f of portal) {
  const t = readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\.from\(['"]([a-z0-9_]+)['"]\)([\s\S]{0,200})/g)) {
    if (m[1] !== 'sanaku_clients') continue;
    // Staff previewing a client's portal read the table directly - RLS lets
    // them, and the view is scoped to the signed-in client so it returns
    // nothing. That is only safe with an explicit column list: `select('*')`
    // on this table is how the retainer ends up on a projector.
    const sel = m[2].match(/\.select\(\s*([A-Za-z_$][\w$]*|['"][^'"]*['"])/);
    const arg = sel && sel[1];
    const isConst = arg && /^[A-Z_][A-Z0-9_]*$/.test(arg);        // a named column list
    const literal = arg && /^['"]/.test(arg) ? arg.slice(1, -1) : null;
    const explicit = isConst || (literal && literal !== '*' && !literal.includes('*'));
    if (!explicit) {
      bad(f, 'reads sanaku_clients without an explicit column list — that table carries your retainer and per-lead pricing; use sanaku_my_client');
    }
  }
  for (const c of MARGIN) {
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
// Reached via policies or security-definer functions only, never named by a
// screen or a workflow. sanaku_addon_bundle_members is read inside
// sanaku_has_addon(), which is the only thing that should ever read it.
const IGNORE = new Set(['sanaku_staff', 'sanaku_client_users', 'sanaku_addon_bundle_members']);
let dangling = 0;
for (const t of [...tables].sort()) {
  if (IGNORE.has(t) || !t.startsWith('sanaku_')) continue;
  const reads = allCode.includes(`'${t}'`) || allCode.includes(`/rest/v1/${t}`);
  if (!reads) { console.log(`  WARN  ${t}: no screen and no workflow touches this table`); dangling++; }
}
if (!dangling) ok('every table is read or written by something');

// ---------------------------------------------------------------------------
// 8. Every price a customer can read must exist in the catalog.
//
//    This is the one that stops the mess repeating. Four documents drifted
//    apart before anyone noticed: the website quoted per-lead at $50-$100 while
//    the catalog said $15-$35, docs/addon-pricing.md quoted overage at $0.60
//    against a real $0.45, and the signed pilot agreement quoted a flat setup
//    the catalog did not have. Every other fix corrects today's drift; this
//    makes tomorrow's fail here instead of reaching a prospect.
// ---------------------------------------------------------------------------
head('Prices → catalog');
const catalogPath = join(R, 'docs', 'catalog.json');
if (!existsSync(catalogPath)) {
  console.log('  WARN  docs/catalog.json missing - run: sh ~/sanaku.sh sellsheet');
} else {
  const cat = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const known = new Set();
  const add = (n) => { if (n != null && Number(n) > 0) known.add(Number(n)); };
  for (const s of cat.services) {
    add(s.setup_fee); add(s.monthly_fee); add(s.per_lead_fee);
    add(s.per_lead_booked_fee); add(s.trial_setup_fee); add(s.included_minutes);
  }
  // Bundle sums and savings are printed on the sheet and are legitimately derived.
  const mem = {};
  for (const m of cat.bundle_members || []) (mem[m.bundle_code] ||= []).push(m.member_code);
  const by = Object.fromEntries(cat.services.map((s) => [s.code, s]));
  for (const [b, ms] of Object.entries(mem)) {
    const parts = ms.map((c) => by[c]).filter(Boolean);
    const ss = parts.reduce((a, p) => a + Number(p.setup_fee), 0);
    const mm = parts.reduce((a, p) => a + Number(p.monthly_fee), 0);
    add(ss); add(mm); add(ss - Number(by[b].setup_fee)); add(mm - Number(by[b].monthly_fee));
  }

  // Figures that are deliberately NOT prices: what a lost job is worth to a
  // client, competitor rates quoted for comparison, calculator defaults, and
  // our own cost to serve. Each is listed on purpose so that a real price can
  // never hide among them.
  const NOT_PRICES = new Set([
    // what a client loses / earns - the leak calculator and vertical cards
    1, 3, 8, 10, 15, 20, 25, 30, 45, 60, 72, 80, 90, 120, 150, 180, 200, 300,
    600, 800, 1000, 2000, 2500, 3000, 5000, 6300, 6825, 12000, 15750, 20000,
    22500, 24500, 50000, 52500,
    // our cost to serve, quoted in the pricing docs
    52, 55, 65,
    // competitor rates quoted for comparison
    49, 168, 249, 284, 325, 468, 542,
  ]);

  // A UI mockup showing what the client portal looks like. Every figure in it
  // is fabricated sample data for a fictional company, not an offer.
  const MOCKUPS = new Set(['portal-preview.html']);

  // Scoped per file rather than globally, because the same number means
  // different things in different documents. "$75" on the landing page is what
  // one dental booking is worth to the practice; "$75" in the pilot agreement
  // would be a per-lead rate we no longer charge. A global exemption would have
  // hidden the second - the agreement really did still quote it.
  const PER_FILE_OK = {
    'index.html': new Set([75]),           // "one booking: $75-$300" - client value
  };

  const docs = [];
  for (const d of ['site', 'docs']) {
    const dir = join(R, d);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (/\.(html|md)$/.test(f) && !MOCKUPS.has(f)) docs.push(join(dir, f));
    }
  }
  let drift = 0;
  for (const f of docs) {
    const text = readFileSync(f, 'utf8');
    const local = PER_FILE_OK[f.split('/').pop()] || new Set();
    const seen = new Set();
    // $126k and $1.2m are magnitudes in a value argument, never a price on an
    // invoice, so the suffix forms are skipped rather than truncated to $126.
    for (const m of text.matchAll(/\$([\d,]+)(?![\d.]*[\dkKmM])/g)) {
      const n = Number(m[1].replace(/,/g, ''));
      if (!n || seen.has(n)) continue;
      seen.add(n);
      if (!known.has(n) && !NOT_PRICES.has(n) && !local.has(n)) {
        bad(f.replace(R + '/', ''), `quotes $${n.toLocaleString()}, which is not in the catalog`);
        drift++;
      }
    }
  }
  // The demo client is not a document, but its own seed comment says it is
  // "used for sales calls and the demo video" - so its rate is on screen in
  // front of prospects exactly like a price list. It was seeded at $45 while
  // every document said $50, and that $45 is legible in the demo video now on
  // the site. Nothing else would ever have caught it.
  const seed = /'retainer_plus_per_lead',\s*(\d+),\s*(\d+)/.exec(sh);
  if (seed) {
    const rate = Number(seed[2]);
    const rates = new Set(cat.services.map((s) => Number(s.per_lead_fee)).filter(Boolean));
    if (!rates.has(rate)) {
      bad('sanaku.sh', `seeds the demo client at $${rate}/lead, which is not a catalog rate ` +
                       `(${[...rates].sort((a, b) => a - b).map((r) => '$' + r).join(', ')}) ` +
                       `- it shows on sales calls and in the demo video`);
      drift++;
    }
  }

  if (!drift) ok(`${docs.length} documents and the demo seed quote only catalog prices`);
}

console.log(problems ? `\n${problems} problem(s) found.\n` : '\nNothing broken. Every reference resolves.\n');
process.exit(problems ? 1 : 0);
