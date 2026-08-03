#!/usr/bin/env node
// Generate the services sell sheet from the catalog.
//
//   node scripts/sellsheet.mjs [catalog.json] [outdir]
//
// The prices live in sanaku_addons. A sell sheet typed by hand starts drifting
// from that table the first time a price changes, and the drifted copy is the
// one that gets handed to a prospect. So this reads the catalog and prints what
// is actually in it.
//
// It also refuses to print a sheet whose arithmetic does not hold: every bundle
// claims in its own detail text what the parts cost separately, and that claim
// is checked against the sum of the parts before anything is written.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalogPath = process.argv[2] || join(HERE, '..', 'docs', 'catalog.json');
const outDir = process.argv[3] || join(HERE, '..', 'docs');

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const services = catalog.services.filter((s) => s.active !== false);
const byCode = Object.fromEntries(services.map((s) => [s.code, s]));
const members = {};
for (const { bundle_code, member_code } of catalog.bundle_members || []) {
  (members[bundle_code] ||= []).push(member_code);
}

const VERTICALS = [
  { key: 'home_services', label: 'Home services', note: 'Plumbers, electricians, HVAC, roofing, restoration.' },
  { key: 'law_firm', label: 'Law firms', note: 'Personal injury, family, criminal, immigration.' },
  { key: 'medical', label: 'Medical & dental practices', note: 'Every service here requires a signed BAA before go-live.' },
];

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// Bundle arithmetic, and the check that it is not lying.
// ---------------------------------------------------------------------------
function bundleMath(b) {
  // Catalog order, not alphabetical-by-code. The membership table is keyed on
  // codes, so left alone a package lists "After-Hours Intake" before
  // "Missed-Call Text-Back" - which is neither the order they happen in nor the
  // order they are sold in.
  const parts = (members[b.code] || []).map((c) => byCode[c]).filter(Boolean)
    .sort((x, y) => x.sort - y.sort || x.name.localeCompare(y.name));
  if (!parts.length) return null;
  const setup = parts.reduce((a, p) => a + Number(p.setup_fee), 0);
  const monthly = parts.reduce((a, p) => a + Number(p.monthly_fee), 0);
  return {
    parts, setup, monthly,
    savesSetup: setup - Number(b.setup_fee),
    savesMonthly: monthly - Number(b.monthly_fee),
    pctSetup: Math.round((1 - Number(b.setup_fee) / setup) * 100),
    pctMonthly: Math.round((1 - Number(b.monthly_fee) / monthly) * 100),
  };
}

const problems = [];
for (const b of services.filter((s) => s.category === 'bundle')) {
  const m = bundleMath(b);
  if (!m) { problems.push(`${b.code}: bundle with no members`); continue; }

  // Every bundle's detail text states what the parts cost separately. If a
  // member price changes and nobody updates the prose, the sheet would print a
  // saving that does not exist. Catch it here rather than in front of a client.
  const claim = /separately these are \$([\d,]+) setup and \$([\d,]+)\/month/.exec(b.detail || '');
  if (!claim) {
    problems.push(`${b.code}: detail text makes no "bought separately" claim to check`);
  } else {
    const cs = Number(claim[1].replace(/,/g, '')), cm = Number(claim[2].replace(/,/g, ''));
    if (cs !== m.setup) problems.push(`${b.code}: detail says $${cs} setup, parts sum to $${m.setup}`);
    if (cm !== m.monthly) problems.push(`${b.code}: detail says $${cm}/mo, parts sum to $${m.monthly}`);
  }
  if (m.savesSetup <= 0 || m.savesMonthly <= 0) {
    problems.push(`${b.code}: costs more than its parts`);
  }
  // Selling the phone agent and the after-hours-only phone agent together
  // charges twice for one product.
  const codes = m.parts.map((p) => p.code);
  if (codes.includes('voice_afterhours') && codes.some((c) => c.startsWith('voice_reception'))) {
    problems.push(`${b.code}: contains both after-hours answering and the full phone agent`);
  }
}
if (problems.length) {
  console.error('Refusing to generate - the catalog does not add up:\n');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
const STATUS = {
  live: ['Available now', 'ok'],
  in_build: ['In development', 'wip'],
  planned: ['Planned', 'wip'],
};

function priceLine(s) {
  const bits = [];
  if (s.included_minutes != null) {
    bits.push(`${s.included_minutes} ${s.unit_label || 'min'} included`);
    if (s.overage_per_minute != null) {
      bits.push(`then $${s.overage_per_minute} per ${(s.unit_label || 'minute').replace(/s$/, '')}`);
    }
  }
  if (s.per_lead_fee != null) bits.push(`${money(s.per_lead_fee)} per qualified lead`);
  return bits.join(' · ');
}

function serviceRow(s) {
  const [label, cls] = STATUS[s.build_status] || STATUS.planned;
  const extra = priceLine(s);
  // The ongoing figure sits in the same cell as the entry figure, on purpose.
  // Split across columns the first number can be read alone and skimmed past.
  // The entry price IS the setup fee - there is no trial discount, the free
  // month is the offer. Stated next to the ongoing price so nobody reads the
  // first number alone.
  const trial = Number(s.monthly_fee)
    ? `<div class="trial"><b>${money(s.setup_fee)}</b> to start &middot; 30 days free &middot; then
         <b>${money(s.monthly_fee)}/month</b> from day 31</div>`
    : '';
  return `
        <tr>
          <td>
            <div class="svc">${esc(s.name)}</div>
            <div class="blurb">${esc(s.blurb)}</div>
            ${trial}
            ${extra ? `<div class="meta">${esc(extra)}</div>` : ''}
          </td>
          <td class="num">${money(s.setup_fee)}</td>
          <td class="num">${money(s.monthly_fee)}</td>
          <td><span class="chip ${cls}">${label}</span></td>
        </tr>`;
}

function bundleCard(b) {
  const m = bundleMath(b);
  const [label, cls] = STATUS[b.build_status] || STATUS.planned;
  return `
      <article class="bundle">
        <header>
          <div>
            <h3>${esc(b.name)}</h3>
            <p class="blurb">${esc(b.blurb)}</p>
          </div>
          <span class="chip ${cls}">${label}</span>
        </header>
        <div class="figures">
          <div><dt>Setup</dt><dd>${money(b.setup_fee)}</dd><dd class="was">was ${money(m.setup)}</dd></div>
          <div><dt>Monthly</dt><dd>${money(b.monthly_fee)}</dd><dd class="was">was ${money(m.monthly)}</dd></div>
          <div class="save"><dt>You save</dt><dd>${money(m.savesSetup)} <span class="pct">${m.pctSetup}%</span></dd>
            <dd class="was">${money(m.savesMonthly)}/mo · ${m.pctMonthly}%</dd></div>
        </div>
        <ul class="parts">
          ${m.parts.map((p) => `<li><span>${esc(p.name)}</span><span class="ala">${money(p.setup_fee)} + ${money(p.monthly_fee)}/mo</span></li>`).join('\n          ')}
        </ul>
        ${priceLine(b) ? `<p class="meta">${esc(priceLine(b))}</p>` : ''}
      </article>`;
}

function verticalSection(v) {
  const mine = services.filter((s) => (s.allowed_verticals || []).includes(v.key));
  const bundles = mine.filter((s) => s.category === 'bundle').sort((a, b) => a.sort - b.sort);
  const single = mine.filter((s) => s.category !== 'bundle').sort((a, b) => a.sort - b.sort || a.code.localeCompare(b.code));
  const notes = [...new Set(single.map((s) => s.compliance_note).filter(Boolean))];

  return `
    <section class="vert" id="${v.key}">
      <div class="vhead">
        <h2>${esc(v.label)}</h2>
        <p>${esc(v.note)}</p>
      </div>

      <h4 class="rule">Packages</h4>
      <div class="bundles">${bundles.map(bundleCard).join('\n')}</div>

      <h4 class="rule">Individually</h4>
      <div class="tablewrap">
        <table>
          <thead><tr><th>Service</th><th class="num">Setup</th><th class="num">Monthly</th><th>Status</th></tr></thead>
          <tbody>${single.map(serviceRow).join('')}
          </tbody>
        </table>
      </div>

      <details class="compliance">
        <summary>What we will and will not do — ${esc(v.label.toLowerCase())}</summary>
        <ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('\n            ')}</ul>
      </details>
    </section>`;
}

const liveCount = services.filter((s) => s.build_status === 'live').length;
const today = new Date().toISOString().slice(0, 10);

const html = `<title>Sanaku — Services & Pricing</title>
<style>
  /* Tokens lifted from dashboard/src/styles.css so the sheet and the product
     are the same object. Fraunces carries the numbers that matter; Instrument
     Sans does the working. Both fall back to Georgia / system sans when the
     font CDN is unreachable, which is a chosen stack, not an accident. */
  :root {
    --ink:#11161b; --ink-2:#2a3239; --sub:#67736d; --line:#e3e2db; --line-soft:#eeede7;
    --bg:#f6f5f0; --card:#ffffff;
    --accent:#0d6b42; --accent-2:#0a5434; --accent-wash:#e8f3ed;
    --signal:#8f6409; --signal-wash:#fdf6e3; --calm:#4a6572; --calm-wash:#eef2f4;
    --raise:0 1px 2px rgba(17,22,27,.04), 0 8px 24px rgba(17,22,27,.05);
    --r:10px; --r-s:7px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      color-scheme:dark;
      --ink:#eef1ee; --ink-2:#c3ccc6; --sub:#8b978f; --line:#262d31; --line-soft:#1d2327;
      --bg:#0d1114; --card:#141a1e;
      --accent:#45d195; --accent-2:#6fdcae; --accent-wash:#12271f;
      --signal:#e0ab3c; --signal-wash:#2a2110; --calm:#9db3bd; --calm-wash:#17222a;
      --raise:0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.28);
    }
  }
  :root[data-theme="dark"] {
    color-scheme:dark;
    --ink:#eef1ee; --ink-2:#c3ccc6; --sub:#8b978f; --line:#262d31; --line-soft:#1d2327;
    --bg:#0d1114; --card:#141a1e;
    --accent:#45d195; --accent-2:#6fdcae; --accent-wash:#12271f;
    --signal:#e0ab3c; --signal-wash:#2a2110; --calm:#9db3bd; --calm-wash:#17222a;
    --raise:0 1px 2px rgba(0,0,0,.3), 0 10px 30px rgba(0,0,0,.28);
  }
  :root[data-theme="light"] {
    color-scheme:light;
    --ink:#11161b; --ink-2:#2a3239; --sub:#67736d; --line:#e3e2db; --line-soft:#eeede7;
    --bg:#f6f5f0; --card:#ffffff;
    --accent:#0d6b42; --accent-2:#0a5434; --accent-wash:#e8f3ed;
    --signal:#8f6409; --signal-wash:#fdf6e3; --calm:#4a6572; --calm-wash:#eef2f4;
    --raise:0 1px 2px rgba(17,22,27,.04), 0 8px 24px rgba(17,22,27,.05);
  }

  * { box-sizing:border-box; }
  body {
    margin:0; padding:0 20px 72px;
    background:var(--bg); color:var(--ink);
    font-family:"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size:15px; line-height:1.5;
    -webkit-font-smoothing:antialiased;
  }
  .shell { max-width:980px; margin:0 auto; }
  h1,h2,h3 { font-family:"Fraunces", Georgia, serif; font-weight:600; margin:0; text-wrap:balance; }
  .num, dd, td.num, th.num { font-variant-numeric:tabular-nums; }

  /* ---- masthead ---- */
  header.top { display:flex; flex-wrap:wrap; gap:20px; align-items:flex-end;
    justify-content:space-between; padding:52px 0 24px; border-bottom:2px solid var(--ink); }
  .word { font-family:"Fraunces", Georgia, serif; font-size:34px; font-weight:600; letter-spacing:-.01em; }
  .word span { color:var(--accent); }
  .tag { color:var(--sub); max-width:46ch; margin:6px 0 0; }
  .stamp { text-align:right; color:var(--sub); font-size:12.5px; line-height:1.7; }
  .stamp b { color:var(--ink-2); font-weight:600; }

  /* ---- how pricing works ---- */
  .how { display:grid; gap:14px; grid-template-columns:repeat(auto-fit,minmax(210px,1fr));
    margin:26px 0 8px; }
  .how div { background:var(--card); border:1px solid var(--line); border-radius:var(--r);
    padding:14px 16px; box-shadow:var(--raise); }
  .how dt { font-size:11.5px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--sub); font-weight:600; }
  .how dd { margin:5px 0 0; font-size:13.5px; color:var(--ink-2); }

  /* ---- the trial offer ---- */
  .tryit { margin:26px 0 0; padding:20px 22px; border-radius:var(--r);
    background:var(--accent-wash); border:1px solid var(--accent-wash); }
  .tryit h2 { font-size:20px; color:var(--accent-2); }
  .tryit p { margin:8px 0 0; color:var(--ink-2); max-width:68ch; font-size:14px; }
  .tryit .small { font-size:12.5px; color:var(--calm); }

  /* ---- vertical sections ---- */
  .vert { margin-top:46px; }
  .vhead h2 { font-size:26px; }
  .vhead p { margin:4px 0 0; color:var(--sub); font-size:14px; }
  h4.rule { font-size:11.5px; text-transform:uppercase; letter-spacing:.09em; color:var(--sub);
    font-weight:600; font-family:inherit; margin:28px 0 12px;
    padding-bottom:7px; border-bottom:1px solid var(--line); }

  /* ---- bundles ---- */
  .bundles { display:grid; gap:16px; grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
  .bundle { background:var(--card); border:1px solid var(--line); border-radius:var(--r);
    padding:20px; box-shadow:var(--raise); break-inside:avoid; }
  .bundle header { display:flex; gap:12px; justify-content:space-between; align-items:flex-start;
    border:0; padding:0; }
  .bundle h3 { font-size:19px; }
  .blurb { margin:4px 0 0; color:var(--sub); font-size:13.5px; }
  .figures { display:flex; gap:22px; flex-wrap:wrap; margin:16px 0 14px;
    padding:14px 0; border-top:1px solid var(--line-soft); border-bottom:1px solid var(--line-soft); }
  .figures dt { font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--sub); font-weight:600; }
  .figures dd { margin:3px 0 0; font-family:"Fraunces", Georgia, serif; font-size:22px; font-weight:600; }
  .figures .was { font-family:inherit; font-size:12px; font-weight:400; color:var(--sub);
    text-decoration:line-through; text-decoration-color:var(--line); }
  .figures .save dd:first-of-type { color:var(--accent); }
  .figures .save .was { text-decoration:none; color:var(--accent-2); }
  .pct { font-family:inherit; font-size:12.5px; font-weight:600; background:var(--accent-wash);
    color:var(--accent-2); padding:2px 7px; border-radius:99px; vertical-align:middle; }
  .parts { list-style:none; margin:0; padding:0; display:grid; gap:6px; }
  .parts li { display:flex; justify-content:space-between; gap:12px; font-size:13px;
    color:var(--ink-2); padding-bottom:6px; border-bottom:1px dashed var(--line-soft); }
  .parts li:last-child { border-bottom:0; }
  .ala { color:var(--sub); font-variant-numeric:tabular-nums; white-space:nowrap; }

  /* ---- table ---- */
  .tablewrap { overflow-x:auto; background:var(--card); border:1px solid var(--line);
    border-radius:var(--r); box-shadow:var(--raise); }
  table { width:100%; border-collapse:collapse; min-width:560px; }
  th { text-align:left; font-size:11px; text-transform:uppercase; letter-spacing:.07em;
    color:var(--sub); font-weight:600; padding:12px 16px; border-bottom:1px solid var(--line); }
  td { padding:14px 16px; border-bottom:1px solid var(--line-soft); vertical-align:top; }
  tr:last-child td { border-bottom:0; }
  td.num, th.num { text-align:right; white-space:nowrap; }
  td.num { font-family:"Fraunces", Georgia, serif; font-size:16px; font-weight:600; }
  .svc { font-weight:600; }
  .meta { margin:5px 0 0; font-size:12.5px; color:var(--calm); }
  .trial { margin:7px 0 0; font-size:12.5px; color:var(--accent-2);
    background:var(--accent-wash); border-radius:var(--r-s); padding:6px 10px;
    display:inline-block; font-variant-numeric:tabular-nums; }

  /* ---- status ---- */
  .chip { display:inline-block; font-size:11.5px; font-weight:600; white-space:nowrap;
    padding:3px 9px; border-radius:99px; border:1px solid transparent; }
  .chip.ok  { background:var(--accent-wash); color:var(--accent-2); border-color:var(--accent-wash); }
  .chip.wip { background:var(--signal-wash); color:var(--signal); border-color:var(--signal-wash); }

  /* ---- compliance ---- */
  .compliance { margin-top:16px; background:var(--calm-wash); border-radius:var(--r-s); padding:12px 16px; }
  .compliance summary { cursor:pointer; font-size:13px; font-weight:600; color:var(--calm); }
  .compliance summary:focus-visible { outline:2px solid var(--accent); outline-offset:3px; border-radius:3px; }
  .compliance ul { margin:10px 0 2px; padding-left:18px; display:grid; gap:7px; }
  .compliance li { font-size:12.5px; color:var(--ink-2); }

  footer { margin-top:52px; padding-top:20px; border-top:1px solid var(--line);
    color:var(--sub); font-size:12.5px; display:grid; gap:8px; }
  footer b { color:var(--ink-2); }

  @media print {
    body { background:#fff; padding:0; font-size:11pt; }
    .bundle, .tablewrap, .how div { box-shadow:none; }
    .vert { break-before:page; }
    .vert:first-of-type { break-before:auto; }
    .compliance[open] summary { list-style:none; }
    .compliance { break-inside:avoid; }
  }
  @media (prefers-reduced-motion: reduce) { * { animation:none !important; transition:none !important; } }
</style>

<div class="shell">
  <header class="top">
    <div>
      <div class="word">Sanaku<span>.</span></div>
      <p class="tag">Answering, texting back, and following up on the enquiries a
        local business would otherwise lose — automatically, in their name.</p>
    </div>
    <div class="stamp">
      <b>Services &amp; pricing</b><br>
      ${services.length} services · ${liveCount} available today<br>
      Generated ${today}
    </div>
  </header>

  <dl class="how">
    <div><dt>Setup</dt><dd>One-off. Covers number provisioning, script writing, and testing against your real calls before anything goes live.</dd></div>
    <div><dt>Monthly</dt><dd>Flat. Includes the allowance shown against each service; anything beyond it is billed at the stated rate.</dd></div>
    <div><dt>Per qualified lead</dt><dd>Only where shown, and only for a lead that met the definition you set. Never charged for spam or wrong numbers.</dd></div>
    <div><dt>Healthcare</dt><dd>Flat fee only, by design. Per-patient compensation can implicate anti-kickback rules, so it is not offered.</dd></div>
  </dl>

  <section class="tryit">
    <h2>Try one service first</h2>
    <p>Pick a single service, pay its starting fee, and run it for 30 days before
      any monthly charge begins. The starting fee is shown against each service
      below, next to what it costs from day 31 — so there is no surprise in
      month two.</p>
    <p class="small">The 30 days begins the day your service actually starts
      working, not the day you sign. Text-based services need your number
      registered with the mobile carriers first, which we handle and which takes
      a few days; the phone agent starts the same day. Packages are not offered
      on trial — try a service, then bundle.</p>
  </section>

  ${VERTICALS.map(verticalSection).join('\n')}

  <footer>
    <div><b>Status.</b> “Available now” means the software exists and can be switched on for you.
      “In development” means it is being built and is not yet deliverable — it is listed so you can
      plan, not so it can be sold to you today.</div>
    <div><b>Packages</b> are priced off the individual prices shown, never off another package, so a
      discount is never applied twice.</div>
    <div><b>Every price on this page is read from the live catalog</b> when the sheet is generated.
      If a figure here disagrees with what is billed, this sheet is stale — regenerate it.</div>
  </footer>
</div>
`;

mkdirSync(outDir, { recursive: true });
const out = join(outDir, 'sell-sheet.html');
writeFileSync(out, html);
console.log(`wrote ${out}`);
console.log(`  ${services.length} services (${liveCount} live), ${services.filter((s) => s.category === 'bundle').length} packages, arithmetic checks passed`);
