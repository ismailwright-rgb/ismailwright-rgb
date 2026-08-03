#!/usr/bin/env node
// Build one email-ready page per vertical, from the same catalog everything
// else reads.
//
//   node scripts/emailpages.mjs [catalog.json] [outdir]
//
// These are written to survive an EMAIL CLIENT, which is a different medium
// from a web page: Gmail strips <style> blocks, Outlook renders through Word
// and ignores flexbox and grid entirely, and neither reliably loads a webfont.
// So this emits tables, inline styles, and web-safe fonts only. It looks plainer
// than the sell sheet on purpose - a page that arrives broken in Outlook is
// worth less than a plain one that arrives intact everywhere.
//
// One page per vertical, never a combined one. The database already takes this
// position: sanaku_addons' client_read policy filters by vertical because
// "showing a plumber the law-firm rate for the same product is a conversation
// you do not want to have."
//
// Only services that can actually be delivered appear as buyable. Anything
// still in build is listed separately as what is coming, or not at all.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const catalogPath = process.argv[2] || join(HERE, '..', 'docs', 'catalog.json');
const outDir = process.argv[3] || join(HERE, '..', 'docs', 'email');

// Read the reply-to out of the live site rather than repeating it here, so
// changing it in one place changes it everywhere.
const REPLY_TO = (/const EMAIL = "([^"]+)"/.exec(
  readFileSync(join(HERE, '..', 'site', 'index.html'), 'utf8')) || [, 'hello@sanaku.com'])[1];

const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
const services = catalog.services.filter((s) => s.active !== false);
const CAP = Number(catalog.trial_entry_cap) || Infinity;

const money = (n) => '$' + Number(n).toLocaleString('en-US');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const VERTICALS = [
  {
    key: 'home_services', file: 'home-services', label: 'home-service businesses',
    lead: 'Every missed call has a price tag.',
    story: 'A plumber missing six calls a week who recovers just two jobs has already '
         + 'paid for the service. The rest is upside.',
  },
  {
    key: 'law_firm', file: 'law-firms', label: 'law firms',
    lead: 'The intake you miss is the matter you never sign.',
    story: 'A missed call at 7pm is a case that calls the next firm on the list. '
         + 'One signed matter covers a year of this.',
  },
  {
    key: 'medical', file: 'medical', label: 'medical & dental practices',
    lead: 'The patient who reaches voicemail books somewhere else.',
    story: 'Booking calls hit voicemail at lunch and after close, and most of those '
         + 'patients do not call back — they book with the next practice.',
  },
];

// ---------------------------------------------------------------------------
// Email-safe building blocks. Inline styles only, tables for layout.
// ---------------------------------------------------------------------------
const INK = '#11161b', SUB = '#67736d', LINE = '#e3e2db';
const ACCENT = '#0d6b42', ACCENT_2 = '#0a5434', WASH = '#e8f3ed', PAPER = '#f6f5f0';
const SERIF = "Georgia, 'Times New Roman', serif";
const SANS = "-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";

const td = (content, style = '') => `<td style="${style}">${content}</td>`;

function serviceBlock(s) {
  const entry = Math.min(Number(s.setup_fee), CAP);
  const balance = Number(s.setup_fee) - entry;
  const bits = [];
  if (s.included_minutes != null) {
    bits.push(`${s.included_minutes} ${s.unit_label || 'min'} included`
      + (s.overage_per_minute != null
        ? `, then $${s.overage_per_minute} per ${(s.unit_label || 'minute').replace(/s$/, '')}` : ''));
  }
  if (s.per_lead_fee != null) bits.push(`${money(s.per_lead_fee)} per qualified lead`);
  if (s.per_lead_booked_fee != null) bits.push(`or ${money(s.per_lead_booked_fee)} per job booked`);

  return `
        <tr>
          <td style="padding:18px 0;border-bottom:1px solid ${LINE};">
            <div style="font:600 17px ${SANS};color:${INK};">${esc(s.name)}</div>
            <div style="font:400 14px/1.55 ${SANS};color:${SUB};padding-top:5px;">${esc(s.blurb)}</div>
            <div style="background:${WASH};border-radius:6px;padding:9px 12px;margin-top:11px;
                        font:600 14px ${SANS};color:${ACCENT_2};">
              ${money(entry)} to start &middot; 30 days free &middot; then ${money(s.monthly_fee)}/month
              ${balance > 0 ? `<div style="font:400 12.5px ${SANS};color:${ACCENT_2};padding-top:3px;">
                 plus the ${money(balance)} balance of setup on day 31, only if you carry on</div>` : ''}
            </div>
            ${bits.length ? `<div style="font:400 12.5px ${SANS};color:${SUB};padding-top:8px;">${esc(bits.join(' · '))}</div>` : ''}
            ${s.requires_baa ? `<div style="font:400 12.5px ${SANS};color:#8f6409;padding-top:6px;">
               Requires a signed BAA covering every vendor in the call path before go-live.</div>` : ''}
          </td>
        </tr>`;
}

function page(v) {
  const mine = services.filter((s) => s.allowed_verticals.includes(v.key));
  const live = mine.filter((s) => s.build_status === 'live' && s.category !== 'bundle')
    .sort((a, b) => a.sort - b.sort);
  const soon = mine.filter((s) => s.build_status !== 'live' && s.category !== 'bundle')
    .sort((a, b) => a.sort - b.sort);
  const notes = [...new Set(live.map((s) => s.compliance_note).filter(Boolean))];

  return `<div style="margin:0;padding:0;background:${PAPER};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${PAPER};padding:24px 12px;">
  <tr>
    <td align="center">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"
             style="width:600px;max-width:100%;background:#ffffff;border:1px solid ${LINE};
                    border-radius:10px;padding:34px 32px;">

        <tr><td style="font:600 22px ${SERIF};color:${INK};letter-spacing:.02em;">
          Sanaku<span style="color:${ACCENT};">.</span></td></tr>

        <tr><td style="font:400 27px/1.15 ${SERIF};color:${INK};padding:18px 0 0;">
          ${esc(v.lead)}</td></tr>

        <tr><td style="font:400 15px/1.6 ${SANS};color:${SUB};padding:12px 0 0;">
          We answer the calls and enquiries you are currently losing — after hours, at lunch,
          while your team is with a customer — under <b style="color:${INK};">your</b> name and
          your number. ${esc(v.story)}</td></tr>

        <tr><td style="padding:24px 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:${WASH};border-radius:8px;">
            <tr><td style="padding:16px 18px;font:400 14px/1.6 ${SANS};color:${ACCENT_2};">
              <b style="font-size:15px;">Try it for 30 days before you pay a monthly fee.</b><br>
              You pay the setup fee to have it built — never more than ${money(CAP)} up front —
              then run it for a month and watch what it catches. If it does not pay for itself,
              walk away. You keep every lead it caught and owe nothing further.
            </td></tr>
          </table>
        </td></tr>

        <tr><td style="font:600 11.5px ${SANS};color:${SUB};letter-spacing:.09em;
                       text-transform:uppercase;padding:30px 0 4px;
                       border-bottom:2px solid ${INK};">
          Available now for ${esc(v.label)}</td></tr>

        <tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          ${live.map(serviceBlock).join('')}
        </table></td></tr>

        ${notes.length ? `
        <tr><td style="padding:20px 0 0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                 style="background:${PAPER};border-radius:8px;">
            <tr><td style="padding:14px 16px;font:400 12.5px/1.65 ${SANS};color:${SUB};">
              <b style="color:${INK};">What we will and will not do.</b><br>
              ${notes.map((n) => esc(n)).join('<br><br>')}
            </td></tr>
          </table>
        </td></tr>` : ''}

        ${soon.length ? `
        <tr><td style="font:400 12.5px/1.6 ${SANS};color:${SUB};padding:22px 0 0;
                       border-top:1px solid ${LINE};margin-top:20px;">
          <b style="color:${INK};">In development, not yet available:</b>
          ${esc([...new Set(soon.map((s) => s.name))].join(', '))}.
          Listed so you can plan, not so it can be sold to you today.
        </td></tr>` : ''}

        <tr><td style="padding:26px 0 0;">
          <a href="mailto:${REPLY_TO}?subject=${encodeURIComponent('Sanaku — set up my number')}"
             style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;
                    font:600 15px ${SANS};padding:13px 26px;border-radius:999px;">
            Reply and we'll set up your number &rarr;</a>
        </td></tr>

        <tr><td style="font:400 12px/1.6 ${SANS};color:${SUB};padding:22px 0 0;">
          Prices are per service and current as of ${new Date().toISOString().slice(0, 10)}.
          Every lead we bill for is logged with a timestamp you can audit — we bill from our
          own meter, never from anything you report to us.
        </td></tr>

      </table>
    </td>
  </tr>
</table>
</div>
`;
}

// A plain-text twin, because some people read mail as text and a wall of
// stripped markup is worse than no email at all.
function plain(v) {
  const mine = services.filter((s) => s.allowed_verticals.includes(v.key));
  const live = mine.filter((s) => s.build_status === 'live' && s.category !== 'bundle')
    .sort((a, b) => a.sort - b.sort);
  const L = [];
  L.push('SANAKU');
  L.push('');
  L.push(v.lead);
  L.push('');
  L.push('We answer the calls and enquiries you are currently losing - after hours,');
  L.push('at lunch, while your team is with a customer - under YOUR name and number.');
  L.push(v.story);
  L.push('');
  L.push('TRY IT FOR 30 DAYS BEFORE YOU PAY A MONTHLY FEE');
  L.push(`You pay the setup fee to have it built - never more than ${money(CAP)} up front -`);
  L.push('then run it for a month and watch what it catches. If it does not pay for');
  L.push('itself, walk away. You keep every lead it caught and owe nothing further.');
  L.push('');
  L.push('AVAILABLE NOW FOR ' + v.label.toUpperCase());
  L.push('');
  for (const s of live) {
    const entry = Math.min(Number(s.setup_fee), CAP);
    const balance = Number(s.setup_fee) - entry;
    L.push(`  ${s.name}`);
    L.push(`  ${s.blurb}`);
    L.push(`  ${money(entry)} to start | 30 days free | then ${money(s.monthly_fee)}/month`);
    if (balance > 0) L.push(`  plus ${money(balance)} balance of setup on day 31, only if you carry on`);
    if (s.per_lead_fee != null) L.push(`  ${money(s.per_lead_fee)} per qualified lead`);
    if (s.requires_baa) L.push('  Requires a signed BAA before go-live.');
    L.push('');
  }
  L.push('Every lead we bill for is logged with a timestamp you can audit - we bill');
  L.push('from our own meter, never from anything you report to us.');
  L.push('');
  L.push('Reply to this email and we will set up your number.');
  return L.join('\n') + '\n';
}

mkdirSync(outDir, { recursive: true });
let n = 0;
for (const v of VERTICALS) {
  const live = services.filter((s) => s.allowed_verticals.includes(v.key)
    && s.build_status === 'live' && s.category !== 'bundle');
  if (!live.length) {
    console.error(`  skipped ${v.file}: nothing is deliverable for this vertical yet`);
    continue;
  }
  writeFileSync(join(outDir, `sanaku-${v.file}.html`), page(v));
  writeFileSync(join(outDir, `sanaku-${v.file}.txt`), plain(v));
  console.log(`  sanaku-${v.file}.html + .txt  (${live.length} service${live.length > 1 ? 's' : ''} offered)`);
  n++;
}
console.log(`wrote ${n} email pages to ${outDir}`);
console.log('Open the .html in a browser, select all, copy, paste into your email.');
