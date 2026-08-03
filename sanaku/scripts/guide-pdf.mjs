#!/usr/bin/env node
// Render a markdown doc to a printable PDF in the house style.
//
//   node scripts/guide-pdf.mjs docs/call-guide.md docs/call-guide.pdf
//
// A .md is fine in a repo and useless beside a phone. This is for the version
// you actually keep open on a call, or print.
//
// Deliberately a small converter rather than a markdown library: this handles
// exactly the subset the guides use, and a dependency that renders 95% of
// CommonMark would still need checking against these files.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] || join(HERE, '..', 'docs', 'call-guide.md');
const out = process.argv[3] || src.replace(/\.md$/, '.pdf');

function pwPath() {
  for (const base of [execSync('npm root -g').toString().trim(), join(process.cwd(), 'node_modules')]) {
    const p = join(base, 'playwright', 'index.mjs');
    if (existsSync(p)) return pathToFileURL(p).href;
  }
  return 'playwright';
}

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const inline = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/(^|[\s(])\*([^*]+)\*/g, '$1<i>$2</i>');

function render(md) {
  const out = [];
  const lines = md.split('\n');
  let i = 0, inList = false, inQuote = false;
  const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const closeQuote = () => { if (inQuote) { out.push('</blockquote>'); inQuote = false; } };

  while (i < lines.length) {
    const l = lines[i];

    if (/^\|/.test(l) && /^\|[\s:|-]+\|$/.test(lines[i + 1] || '')) {
      closeList(); closeQuote();
      const cells = (r) => r.split('|').slice(1, -1).map((c) => c.trim());
      const head = cells(l);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push('<table><thead><tr>'
        + head.map((h) => `<th>${inline(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>');
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { closeList(); closeQuote(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

    if (/^---+$/.test(l)) { closeList(); closeQuote(); out.push('<hr>'); i++; continue; }

    if (/^>\s?/.test(l)) {
      closeList();
      if (!inQuote) { out.push('<blockquote>'); inQuote = true; }
      const t = l.replace(/^>\s?/, '');
      out.push(t.trim() ? `<p>${inline(t)}</p>` : '');
      i++; continue;
    }
    closeQuote();

    if (/^[-*]\s+/.test(l)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(l.replace(/^[-*]\s+/, ''))}</li>`);
      i++; continue;
    }
    closeList();

    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^([#>|-]|\s*[-*]\s)/.test(lines[i])) para.push(lines[i++]);
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    else i++;
  }
  closeList(); closeQuote();
  return out.join('\n');
}

const md = readFileSync(src, 'utf8');
const title = (/^#\s+(.*)$/m.exec(md) || [, basename(src)])[1];

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sanaku — ${esc(title)}</title>
<style>
  :root { --ink:#172a23; --sub:#51625b; --line:#e2ddd1; --paper:#faf8f3;
          --green:#0d6b42; --green-deep:#0a5434; --gold:#b98a2f; }
  * { box-sizing:border-box; }
  body { margin:0; padding:0; background:#fff; color:var(--ink);
         font:400 10.5pt/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif; }
  .wrap { max-width:170mm; margin:0 auto; padding:0 2mm; }
  h1 { font:500 26pt/1.1 Georgia,serif; margin:0 0 4pt; letter-spacing:-.01em; }
  /* No border here: the source already separates sections with ---, and both
     drawing produced a doubled rule. */
  h2 { font:500 15pt/1.2 Georgia,serif; margin:16pt 0 6pt; break-after:avoid; }
  h3 { font:600 10pt ; margin:13pt 0 4pt; color:var(--green-deep);
       text-transform:uppercase; letter-spacing:.08em; break-after:avoid; }
  h4 { font:600 11pt; margin:11pt 0 3pt; break-after:avoid; }
  p { margin:0 0 7pt; }
  hr { border:0; border-top:1px solid var(--line); margin:14pt 0 0; }
  ul { margin:0 0 8pt; padding-left:16pt; }
  li { margin-bottom:3pt; }
  code { font:400 9.5pt ui-monospace,'SF Mono',Menlo,monospace;
         background:var(--paper); padding:1pt 3pt; border-radius:3px; }
  blockquote { margin:8pt 0 10pt; padding:8pt 12pt; background:var(--paper);
               border-left:3px solid var(--green); break-inside:avoid; }
  blockquote p { margin:0 0 5pt; font-style:italic; color:var(--green-deep); }
  blockquote p:last-child { margin:0; }
  table { width:100%; border-collapse:collapse; margin:8pt 0 12pt;
          font-size:9.5pt; break-inside:avoid; }
  th { text-align:left; font:600 8pt; text-transform:uppercase; letter-spacing:.06em;
       color:var(--sub); border-bottom:1.5px solid var(--ink); padding:5pt 8pt 4pt; }
  td { border-bottom:1px solid var(--line); padding:5pt 8pt; vertical-align:top; }
  @page { size:Letter; margin:14mm 12mm; }
</style></head>
<body><div class="wrap">
${render(md)}
</div></body></html>`;

const tmp = out.replace(/\.pdf$/, '.tmp.html');
writeFileSync(tmp, html);
const { chromium } = await import(pwPath());
const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
const p = await b.newPage();
await p.goto(pathToFileURL(tmp).href, { waitUntil: 'load' });
await p.pdf({ path: out, format: 'Letter', printBackground: true,
              margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' } });
await b.close();
const pages = (/\/Count\s+(\d+)/.exec(readFileSync(out, 'latin1')) || [, '?'])[1];
console.log(`wrote ${out}  (${pages} pages)`);
