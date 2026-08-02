/**
 * Render the leak audit sheet to a PDF you can attach to an email.
 *
 *   node scripts/make-pdf.mjs [industry] [out.pdf]
 *   node scripts/make-pdf.mjs law Sanaku_Leak_Audit_Law.pdf
 *
 * The sheet is interactive; a PDF is not. So this drives the page first -
 * picks the industry, lets the calculator settle - and prints whatever state
 * it lands in. Send a prospect the one for THEIR vertical and the prices,
 * the agent name and the charts are all already theirs.
 *
 * Needs: npx playwright (Chromium is already on this box).
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

// ESM ignores NODE_PATH, so a globally installed playwright is not importable
// by name. Look where it actually is instead of demanding a local install.
async function loadPlaywright() {
  try {
    const m = await import('playwright');
    if (m.chromium || m.default?.chromium) return m.chromium ? m : m.default;
  } catch {}
  const roots = [];
  try { roots.push(execSync('npm root -g', { encoding: 'utf8' }).trim()); } catch {}
  roots.push('/usr/lib/node_modules', '/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules');
  for (const r of roots) {
    const p = join(r, 'playwright', 'index.js');
    if (!existsSync(p)) continue;
    // playwright is CommonJS: dynamic import wraps module.exports in .default
    // and does not always surface named exports from it.
    const m = await import(pathToFileURL(p).href);
    return m.chromium ? m : (m.default ?? m);
  }
  console.error('Playwright not found. Install it once with:  npm install -g playwright');
  process.exit(1);
}
const { chromium } = await loadPlaywright();

const here = dirname(fileURLToPath(import.meta.url));
// One-pager by default: it is the thing a lead will actually read. --full
// renders the long audit sheet instead.
const FULL = process.argv.includes('--full');
const file = FULL ? 'leak-audit.html' : 'one-pager.html';
const page$ = resolve(join(here, '..', 'site', file));
if (!existsSync(page$)) {
  console.error('Cannot find site/leak-audit.html');
  process.exit(1);
}

const INDUSTRY = { home: 'HVAC / Home Services', dental: 'Dental / Medical', law: 'Personal Injury Law' };
const which = (process.argv.filter((a) => !a.startsWith('--'))[2] || 'home').toLowerCase();
if (!INDUSTRY[which]) {
  console.error(`Unknown industry "${which}". Use one of: ${Object.keys(INDUSTRY).join(', ')}`);
  process.exit(1);
}
const args = process.argv.filter((a) => !a.startsWith('--'));
const out = resolve(args[3] || join(here, '..', 'site',
  FULL ? `Sanaku_Leak_Audit_${which}.pdf` : `Sanaku_${which}.pdf`));

const browser = await chromium.launch();
const page = await browser.newPage();
// The one-pager takes its vertical from the query string; the audit sheet has
// a dropdown that has to be driven.
await page.goto('file://' + page$ + (FULL ? '' : '?i=' + which), { waitUntil: 'networkidle' });
if (FULL) {
  await page.selectOption('#industry', which);
}
await page.waitForTimeout(250);

// Fail loudly rather than shipping a PDF with $0 everywhere: if the calculator
// did not run, every figure would print as its placeholder.
const loss = await page.textContent(FULL ? '#lossYear' : '#mLoss');
if (!loss || loss === '$0') {
  console.error('The calculator did not populate - refusing to write a blank PDF.');
  await browser.close();
  process.exit(1);
}

await page.emulateMedia({ media: 'print' });
await page.pdf({
  path: out,
  format: 'Letter',
  printBackground: true,
  // The one-pager sets its own margins in CSS so it can guarantee one page.
  margin: FULL ? { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' } : undefined,
});
await browser.close();

console.log(`${INDUSTRY[which]} — losing ${loss}/yr at the defaults`);
console.log(`wrote ${out}`);
