#!/usr/bin/env node
// One sell sheet per vertical, from the same catalog everything else reads.
//
//   node scripts/emailpages.mjs [catalog.json] [outdir]
//
// Laid out like site/leak-audit.html and the Sanaku_*.pdf it produces: full
// width, the leak table first, the stat row, then how it works, then what it
// costs. That sheet reads better than a boxed-card layout because it uses the
// whole page and leads with the prospect's problem rather than our price.
//
// Emitted three ways, because "send it to them" means different things:
//   .pdf   attach it - opens on whatever the recipient happens to use
//   .html  open, select all, copy, paste into the body of an email
//   .txt   for anyone reading mail as plain text
//
// The HTML is tables and inline styles only. Gmail strips <style> blocks,
// Outlook renders through Word and ignores flexbox and grid entirely, and
// neither reliably loads a webfont.
//
// One sheet per vertical, never a combined one. The database already takes this
// position: sanaku_addons' client_read policy filters by vertical because
// "showing a plumber the law-firm rate for the same product is a conversation
// you do not want to have."
//
// Only what can actually be delivered is offered for sale. Anything still in
// build is named in one line as coming, not sold.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { LEAK, NO_RESPONSE_RATE } from './leak-figures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalogPath = process.argv[2] || join(HERE, '..', 'docs', 'catalog.json');
const outDir = process.argv[3] || join(HERE, '..', 'docs', 'email');

// Read the contact details out of the live site rather than repeating them, so
// changing one in a single place changes it everywhere.
const site = readFileSync(join(HERE, '..', 'site', 'index.html'), 'utf8');
const REPLY_TO = (/const EMAIL = "([^"]+)"/.exec(site) || [, 'hello@sanaku.com'])[1];
const PHONE = (/const PHONE = "([^"]*)"/.exec(site) || [, ''])[1];

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const services = catalog.services.filter((s) => s.active !== false);
const CAP = Number(catalog.trial_entry_cap) || Infinity;

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const k = (n) => '$' + Math.round(n / 1000) + 'k';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const VERTICALS = [
  { key: 'home_services', file: 'home-services', label: 'HVAC / Home Services',
    lead: 'Every missed call has a price tag.' },
  { key: 'law_firm', file: 'law-firms', label: 'Personal Injury Law',
    lead: 'The intake you miss is the matter you never sign.' },
  { key: 'medical', file: 'medical', label: 'Dental / Medical',
    lead: 'The patient who reaches voicemail books somewhere else.' },
];

// House palette, matching site/leak-audit.html exactly.
const INK = '#172a23', SUB = '#51625b', LINE = '#e2ddd1', PAPER = '#faf8f3';
const GREEN = '#0d6b42', DEEP = '#0a5434', GOLD = '#b98a2f', LOSS = '#c0453a';
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = "-apple-system,'Segoe UI',Helvetica,Arial,sans-serif";

const label = (t) => `<div style="font:700 9.5px ${SANS};letter-spacing:.14em;`
  + `text-transform:uppercase;color:${GOLD};padding:0 0 7px;">${t}</div>`;

const th = (t, align = 'left') => `<th align="${align}" style="font:700 8.5px ${SANS};`
  + `letter-spacing:.09em;text-transform:uppercase;color:${SUB};padding:0 6px 5px;`
  + `border-bottom:1.5px solid ${INK};">${t}</th>`;

// The whole point of leading with this: their own industry is highlighted, and
// the other two are there so the number reads as an industry fact rather than
// something we made up about them.
function leakTable(v) {
  const rows = VERTICALS.map((x) => {
    const l = LEAK[x.key];
    const on = x.key === v.key;
    const cell = (content, align, extra = '') =>
      `<td align="${align}" style="padding:7px 6px;border-bottom:1px solid ${LINE};`
      + `${on ? `background:${PAPER};` : ''}${extra}">${content}</td>`;
    return `<tr>
      ${cell(`<span style="font:${on ? '700' : '400'} 11px ${SANS};color:${INK};">${esc(l.industry)}</span>`,
             'left', on ? `border-left:3px solid ${GREEN};padding-left:8px;` : '')}
      ${cell(`<span style="font:400 11px ${SANS};color:${SUB};">${l.leads[0]}–${l.leads[1]}</span>`, 'right')}
      ${cell(`<span style="font:400 11px ${SANS};color:${SUB};">${money(l.value[0])}–${money(l.value[1])}</span>`, 'right')}
      ${cell(`<span style="font:700 11px ${SANS};color:${DEEP};">${money(l.losing[0])}–${money(l.losing[1])}</span>`, 'right')}
    </tr>`;
  }).join('');

  return `${label('The leak &middot; what one lost lead actually costs')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
      <tr>${th('Industry')}${th('Leads / mo', 'right')}${th('Value / closed customer', 'right')}${th('Walking away / mo', 'right')}</tr>
      ${rows}
    </table>
    <div style="font:400 9px/1.45 ${SANS};color:${SUB};padding:7px 0 0;">
      Assumes 25% of leads never get a real response and that you close 35% of the ones you do
      reach — both deliberately cautious. Service businesses miss 25–40% of calls during business
      hours and 60%+ after hours, and small businesses answer only 37.8% of calls overall.
    </div>`;
}

function statRow(v) {
  const l = LEAK[v.key];
  const midLose = Math.round((l.losing[0] + l.losing[1]) / 2);
  const midLeads = Math.round((l.leads[0] + l.leads[1]) / 2);
  const missed = Math.round(midLeads * NO_RESPONSE_RATE);
  const keep = Math.round(midLose * 0.4);
  const reach = midLeads - missed;
  const pct = Math.round((reach / midLeads) * 100);

  const card = (kicker, big, sub, o = {}) => `
    <td width="33%" style="padding:0 5px;" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${o.dark ? INK : '#fff'};border:1px solid ${o.dark ? INK : LINE};border-radius:8px;">
        <tr><td style="padding:11px 13px;">
          <div style="font:700 8.5px ${SANS};letter-spacing:.1em;text-transform:uppercase;
                      color:${o.dark ? '#86caa4' : SUB};">${kicker}</div>
          <div style="font:400 27px/1.1 ${SERIF};color:${o.color || INK};padding:3px 0 2px;">${big}</div>
          <div style="font:400 9.5px/1.4 ${SANS};color:${o.dark ? '#a9bcb1' : SUB};">${sub}</div>
        </td></tr>
      </table>
    </td>`;

  return `${label(`What that means for you &middot; ${esc(v.label)}`)}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      ${card('Walking out the door', k(midLose * 12), `a year &middot; ${missed} leads a month never properly answered`, { color: LOSS })}
      ${card("You'd keep", k(keep * 12), 'a year, catching 40% of them', { dark: true, color: '#45d195' })}
      ${card('Pays for itself in', '6 months', 'then every $1 returns <b>2.0&times;</b>')}
    </tr></table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="padding:11px 0 0;">
      <tr>
        <td width="${pct}%" style="height:9px;background:${GREEN};border-radius:5px 0 0 5px;font-size:0;line-height:0;">&nbsp;</td>
        <td width="${100 - pct}%" style="height:9px;background:${LOSS};border-radius:0 5px 5px 0;font-size:0;line-height:0;">&nbsp;</td>
      </tr>
      <tr>
        <td style="font:400 9px ${SANS};color:${SUB};padding-top:4px;">${reach} of ${midLeads} leads reach you</td>
        <td align="right" style="font:400 9px ${SANS};color:${LOSS};padding-top:4px;">${missed} don't</td>
      </tr>
    </table>`;
}

function howItWorks(live) {
  const cells = live.map((s, i) => `
    <td width="50%" valign="top" style="padding:0 10px 11px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td valign="top" style="font:700 9px ${SANS};color:${GOLD};padding:3px 7px 0 0;">
          ${String(i + 1).padStart(2, '0')}</td>
        <td>
          <div style="font:400 13.5px ${SERIF};color:${INK};">${esc(s.name)}</div>
          <div style="font:400 10px/1.45 ${SANS};color:${SUB};padding-top:3px;">${esc(s.detail || s.blurb)}</div>
        </td>
      </tr></table>
    </td>`);
  const rows = [];
  for (let i = 0; i < cells.length; i += 2) {
    rows.push(`<tr>${cells[i]}${cells[i + 1] || '<td width="50%"></td>'}</tr>`);
  }
  return `${label('How the catch works')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join('')}</table>`;
}

function costs(live) {
  const cells = live.map((s, i) => {
    const entry = Math.min(Number(s.setup_fee), CAP);
    const balance = Number(s.setup_fee) - entry;
    const lead = i === 0;
    return `
    <td width="${Math.floor(100 / live.length)}%" valign="top" style="padding:0 5px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="background:${lead ? PAPER : '#fff'};border:1px solid ${lead ? GREEN : LINE};border-radius:8px;">
        <tr><td style="padding:11px 13px;">
          <div style="font:600 12.5px ${SERIF};color:${INK};">${esc(s.name)}</div>
          <div style="padding:5px 0 2px;">
            <span style="font:400 21px ${SERIF};color:${GREEN};">${money(s.monthly_fee)}</span><span
                  style="font:400 10px ${SANS};color:${SUB};">/month</span>
            <span style="font:400 10px ${SANS};color:${SUB};"> &middot; ${money(entry)} to start</span>
          </div>
          <div style="font:400 9.5px/1.4 ${SANS};color:${SUB};">
            30 days free before the first monthly invoice.${
              balance > 0 ? ` ${money(balance)} balance of setup on day 31, only if you carry on.` : ''}
            ${s.per_lead_fee != null ? `<br>${money(s.per_lead_fee)} per qualified lead${
              s.per_lead_booked_fee != null ? `, or ${money(s.per_lead_booked_fee)} per job booked` : ''}.` : ''}
            ${s.requires_baa ? '<br>Requires a signed BAA before go-live.' : ''}
          </div>
        </td></tr>
      </table>
    </td>`;
  });
  return `${label('What it costs')}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${cells.join('')}</tr></table>`;
}

function page(v) {
  const mine = services.filter((s) => s.allowed_verticals.includes(v.key) && s.category !== 'bundle');
  const live = mine.filter((s) => s.build_status === 'live').sort((a, b) => a.sort - b.sort);
  const soon = [...new Set(mine.filter((s) => s.build_status !== 'live').map((s) => s.name))];
  const notes = [...new Set(live.map((s) => s.compliance_note).filter(Boolean))];

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sanaku — ${esc(v.label)}</title>
<style>@page { size:Letter; margin:11mm 10mm; }</style>
</head>
<body style="margin:0;padding:0;background:#fff;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#fff;">
<tr><td align="center" style="padding:6px;">
<table role="presentation" width="760" cellpadding="0" cellspacing="0" border="0"
       style="width:760px;max-width:100%;">

  <tr><td style="padding:0 0 8px;border-bottom:2px solid ${INK};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="bottom">
        <div style="font:700 20px ${SANS};letter-spacing:.22em;color:${INK};">SANAKU</div>
        <div style="font:400 10px ${SANS};color:${SUB};padding-top:3px;">
          Lead-capture automation for local service businesses</div>
      </td>
      <td align="right" valign="bottom" style="font:400 10px/1.5 ${SANS};color:${SUB};">
        ${PHONE ? `<div style="font:700 14px ${SANS};color:${GREEN};">${esc(PHONE)}</div>` : ''}
        <div>${esc(REPLY_TO)}</div>
      </td>
    </tr></table>
  </td></tr>

  <tr><td style="font:400 30px/1.1 ${SERIF};color:${INK};padding:16px 0 0;">${esc(v.lead)}</td></tr>
  <tr><td style="font:400 12.5px/1.5 ${SANS};color:${SUB};padding:7px 0 16px;">
    You already pay for the phone to ring. Sanaku catches the leads that currently walk away —
    under your brand, not ours.</td></tr>

  <tr><td style="padding:0 0 15px;">${leakTable(v)}</td></tr>
  <tr><td style="padding:0 0 15px;">${statRow(v)}</td></tr>
  <tr><td style="padding:0 0 13px;">${howItWorks(live)}</td></tr>
  <tr><td style="padding:0 0 13px;">${costs(live)}</td></tr>

  ${notes.length ? `<tr><td style="font:400 8.5px/1.45 ${SANS};color:${SUB};padding:0 0 10px;">
    <b style="color:${INK};">What we will and will not do.</b>
    ${notes.map((n) => esc(n)).join(' ')}
  </td></tr>` : ''}

  ${soon.length ? `<tr><td style="font:400 8.5px/1.45 ${SANS};color:${SUB};padding:0 0 12px;">
    <b style="color:${INK};">Also in development:</b> ${esc(soon.slice(0, 3).join(', '))}${
      soon.length > 3 ? ` and ${soon.length - 3} more` : ''}. Not yet available — mentioned so you
    can plan, not sold to you today.
  </td></tr>` : ''}

  <tr><td style="border-top:2px solid ${INK};padding:11px 0 0;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top">
        <div style="font:400 17px ${SERIF};color:${INK};">See your real number.</div>
        <div style="font:400 10px/1.45 ${SANS};color:${SUB};padding-top:3px;">
          15-minute free leak audit. No pressure — just clarity on what you are currently losing.</div>
      </td>
      <td align="right" valign="top" style="font:400 10px/1.5 ${SANS};color:${SUB};">
        ${PHONE ? `<div style="font:700 15px ${SANS};color:${GREEN};">${esc(PHONE)}</div>` : ''}
        <div><a href="mailto:${esc(REPLY_TO)}" style="color:${GREEN};text-decoration:none;">${esc(REPLY_TO)}</a></div>
      </td>
    </tr></table>
    <div style="font:400 8.5px/1.45 ${SANS};color:${SUB};padding:9px 0 0;">
      Under your brand, not ours. We never cold-call: automated calls only ever go to people who
      just contacted you. Every text honours STOP immediately, and you can pause everything from
      your portal in one click. Every lead we bill for is logged with a timestamp you can audit —
      we bill from our own meter, never from anything you report to us.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>
`;
}

// A plain-text twin, because some people read mail as text and a wall of
// stripped markup is worse than no email at all.
function plain(v) {
  const l = LEAK[v.key];
  const mine = services.filter((s) => s.allowed_verticals.includes(v.key) && s.category !== 'bundle');
  const live = mine.filter((s) => s.build_status === 'live').sort((a, b) => a.sort - b.sort);
  const midLose = Math.round((l.losing[0] + l.losing[1]) / 2);
  const midLeads = Math.round((l.leads[0] + l.leads[1]) / 2);
  const missed = Math.round(midLeads * NO_RESPONSE_RATE);

  const L = ['SANAKU', 'Lead-capture automation for local service businesses', '',
    v.lead, '',
    'You already pay for the phone to ring. Sanaku catches the leads that',
    'currently walk away - under your brand, not ours.', '',
    'THE LEAK - WHAT ONE LOST LEAD ACTUALLY COSTS', ''];
  for (const x of VERTICALS) {
    const e = LEAK[x.key];
    L.push(`  ${x.key === v.key ? '>' : ' '} ${e.industry.padEnd(22)}`
      + `${(e.leads[0] + '-' + e.leads[1]).padEnd(9)} leads/mo   `
      + `${money(e.value[0])}-${money(e.value[1])} each   `
      + `losing ${money(e.losing[0])}-${money(e.losing[1])}/mo`);
  }
  L.push('',
    'Assumes 25% of leads never get a real response and that you close 35% of',
    'the ones you do reach - both deliberately cautious.', '',
    `FOR YOU: about ${missed} of ${midLeads} leads a month never properly answered,`,
    `roughly ${k(midLose * 12)} a year walking out the door.`, '',
    'AVAILABLE NOW', '');
  for (const s of live) {
    const entry = Math.min(Number(s.setup_fee), CAP);
    const balance = Number(s.setup_fee) - entry;
    L.push(`  ${s.name}`);
    L.push(`  ${s.blurb}`);
    L.push(`  ${money(s.monthly_fee)}/month | ${money(entry)} to start | 30 days free`);
    if (balance > 0) L.push(`  ${money(balance)} balance of setup on day 31, only if you carry on`);
    if (s.per_lead_fee != null) L.push(`  ${money(s.per_lead_fee)} per qualified lead`);
    if (s.requires_baa) L.push('  Requires a signed BAA before go-live.');
    L.push('');
  }
  L.push('SEE YOUR REAL NUMBER', '15-minute free leak audit. No pressure.');
  if (PHONE) L.push(PHONE);
  L.push(REPLY_TO, '',
    'We never cold-call: automated calls only go to people who just contacted',
    'you. Every text honours STOP immediately. Every lead we bill for is logged',
    'with a timestamp you can audit - we bill from our own meter, never from',
    'anything you report to us.');
  return L.join('\n') + '\n';
}

// ESM ignores NODE_PATH, so a globally installed playwright is not importable
// by name. Same approach make-pdf.mjs already takes.
function pwPath() {
  for (const base of [execSync('npm root -g').toString().trim(), join(process.cwd(), 'node_modules')]) {
    const p = join(base, 'playwright', 'index.mjs');
    if (existsSync(p)) return pathToFileURL(p).href;
  }
  return 'playwright';
}
const pdfPageCount = (f) => Number((/\/Count\s+(\d+)/.exec(readFileSync(f, 'latin1')) || [, 0])[1]);

mkdirSync(outDir, { recursive: true });
const written = [];
let failed = false;

for (const v of VERTICALS) {
  const live = services.filter((s) => s.allowed_verticals.includes(v.key)
    && s.build_status === 'live' && s.category !== 'bundle');
  if (!live.length) {
    console.error(`  skipped ${v.file}: nothing is deliverable for this vertical yet`);
    continue;
  }
  writeFileSync(join(outDir, `sanaku-${v.file}.html`), page(v));
  writeFileSync(join(outDir, `sanaku-${v.file}.txt`), plain(v));
  written.push(v.file);
  console.log(`  sanaku-${v.file}.html + .txt  (${live.length} service${live.length > 1 ? 's' : ''} offered)`);
}

try {
  const { chromium } = await import(pwPath());
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  for (const f of written) {
    const p = await b.newPage();
    await p.goto(pathToFileURL(join(outDir, `sanaku-${f}.html`)).href, { waitUntil: 'load' });
    const out = join(outDir, `sanaku-${f}.pdf`);

    // A one-pager has to actually be one page. Verticals carry different
    // numbers of services, so a layout tuned until one of them fits leaves the
    // others wrong. Shrink to fit, and check rather than assume.
    //
    // The floor matters: below it the type stops being comfortably readable,
    // and a second page beats an unreadable first one. Failing there means a
    // service was added and the copy needs editing, not squeezing.
    let scale = 1, pages = 0;
    for (; scale >= 0.78; scale -= 0.04) {
      await p.pdf({ path: out, format: 'Letter', printBackground: true, scale,
                    margin: { top: '11mm', bottom: '11mm', left: '10mm', right: '10mm' } });
      pages = pdfPageCount(out);
      if (pages === 1) break;
    }
    await p.close();
    if (pages === 1) {
      console.log(`  sanaku-${f}.pdf  (1 page${scale < 1 ? ` at ${Math.round(scale * 100)}%` : ''})`);
    } else {
      console.error(`  sanaku-${f}.pdf  STILL ${pages} PAGES even at 78% - trim the copy `
                  + `or drop a section rather than shrinking it further.`);
      failed = true;
    }
  }
  await b.close();
} catch (e) {
  console.error('  (PDFs skipped: ' + e.message.split('\n')[0] + ')');
  console.error('  The .html and .txt are still written and usable.');
}

console.log('');
console.log('Attach the .pdf, or open the .html and copy-paste it into the email body.');
if (failed) process.exit(1);
