// Turning a queued item into something Ismail can paste into LinkedIn.
//
// The studio generates and stages; it never publishes. LinkedIn's API will not
// reliably post polls, carousels or articles to a PERSONAL profile, so the last
// step is always a human with a clipboard. That makes the export the product:
// if pasting is fiddly, the studio has failed no matter how good the writing is.
//
// Two things ship from here:
//   copy  - the exact wording, clean, ready to paste
//   pack  - a zip that unzips to ONE tidy folder: caption.txt + the images,
//           named so a carousel stays in order
//
// JSZip is imported dynamically, inside the two functions that build zips. It
// is ~100kB and is only needed at the moment someone exports, so loading it
// eagerly would slow the first paint of every tab for a feature used on one.
const loadZip = () => import('jszip').then((m) => m.default);

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/**
 * Strip the markdown the model emits. LinkedIn's composer has no markdown -
 * it renders `**bold**` as literal asterisks, which is the single most obvious
 * tell that a post was pasted out of an AI tool.
 *
 * Structure is preserved as blank lines, because that IS how LinkedIn does
 * paragraphs and subheads.
 */
export function stripMarkdown(s) {
  if (!s) return '';
  return String(s)
    .replace(/\r\n/g, '\n')
    .replace(/^\s*#{1,6}\s+/gm, '')          // ## Heading  -> Heading
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')  // keep the URL, drop the syntax
    .replace(/(\*\*|__)(.*?)\1/g, '$2')      // bold
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?]|$)/g, '$1$2') // italic, not mid-word
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')   // code ticks
    .replace(/^\s*>\s?/gm, '')               // blockquote
    .replace(/^\s*[-*+]\s+/gm, '• ')         // bullets -> a real bullet
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The exact text to paste, per format.
 *
 * A poll is the awkward one: LinkedIn asks for the question and each option in
 * separate boxes, so a single blob cannot be pasted in one go. Rather than
 * pretend otherwise, the caption is laid out with labels that match the fields
 * on screen, so it is obvious what goes where.
 */
export function captionFor(item) {
  const t = item.content_type;
  const body = stripMarkdown(item.body);
  const post = stripMarkdown(item.post_text);

  if (t === 'poll') {
    const opts = (item.poll_options || []).map((o, i) => `  ${i + 1}. ${o}`).join('\n');
    return [
      post && `${post}\n`,
      `QUESTION\n  ${stripMarkdown(item.poll_question)}`,
      `\nOPTIONS\n${opts}`,
    ].filter(Boolean).join('\n');
  }

  if (t === 'article' || t === 'newsletter' || t === 'featured') {
    return [stripMarkdown(item.title), '', body].filter((x) => x !== null).join('\n').trim();
  }

  if (t === 'carousel') {
    // The caption is what goes in the post box. The slides are the document,
    // and live in their own file in the pack.
    return post || stripMarkdown(item.title);
  }

  return post;
}

/** Carousel slides as a numbered plain-text file, one block per slide. */
export function slidesText(item) {
  const slides = item.slides || [];
  return slides
    .map((s, i) => `--- SLIDE ${i + 1} of ${slides.length} ---\n${stripMarkdown(s.text)}`)
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

const kebab = (s) => String(s || '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** e.g. sanaku_2026-08-09_missed-calls */
export function packName(item) {
  const date = (item.created_at || new Date().toISOString()).slice(0, 10);
  const theme = kebab(item.bottleneck || item.title || item.content_type);
  return `sanaku_${date}_${theme}`;
}

/**
 * Keep the real extension. Alexya returns JPEG, so naming files .png would be
 * a lie that some upload widgets actually reject on mime sniff.
 */
function extFor(url) {
  const m = String(url).split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
  return m ? m[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}

/**
 * Every image on an item, in the order they should be uploaded.
 *
 * For a carousel the slide images ARE the upload order, and slide 1 is the
 * cover - so once any slide carries artwork, item.image_url is that same cover
 * and must not be emitted a second time under its own name. Doing so would put
 * six files in front of a five-slide carousel and quietly shift every slide by
 * one during upload, which is the exact failure the numbering exists to stop.
 */
export function imagesFor(item) {
  const out = [];
  if (item.content_type === 'carousel' && Array.isArray(item.slides)) {
    item.slides.forEach((s, i) => {
      if (s && s.image_url) out.push({ url: s.image_url, name: `slide-${String(i + 1).padStart(2, '0')}` });
    });
    if (out.length) return out;
  }
  if (item.image_url) {
    out.unshift({ url: item.image_url, name: item.content_type === 'carousel' ? 'cover' : 'image' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser actions
// ---------------------------------------------------------------------------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard API needs a secure context and a user gesture. Fall back so a
    // copy button never silently does nothing.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking immediately cancels the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function downloadImage(url, filename) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch image (${res.status})`);
  saveBlob(await res.blob(), filename);
}

/**
 * Add one item's files into `folder`. Shared by the single and batch packs so
 * a week's export and a one-off export cannot drift apart in layout.
 *
 * A failed image download is recorded in the pack as MISSING-IMAGES.txt rather
 * than aborting: a pack with the caption and three of four images is still
 * worth having, and silently shipping three would be worse than saying so.
 */
async function fill(folder, item) {
  folder.file('caption.txt', captionFor(item));
  if (item.content_type === 'carousel' && (item.slides || []).length) {
    folder.file('slides.txt', slidesText(item));
  }
  const missing = [];
  for (const img of imagesFor(item)) {
    try {
      const res = await fetch(img.url);
      if (!res.ok) throw new Error(String(res.status));
      // arrayBuffer, not blob: JSZip accepts both in a browser but only
      // ArrayBuffer under Node, and that difference is what makes this
      // testable outside one.
      folder.file(`${img.name}.${extFor(img.url)}`, await res.arrayBuffer());
    } catch (e) {
      missing.push(`${img.name} — ${img.url} (${e.message})`);
    }
  }
  if (missing.length) {
    folder.file('MISSING-IMAGES.txt',
      `These images could not be downloaded when this pack was built:\n\n${missing.join('\n')}\n`);
  }
  return missing.length;
}

/** One item -> one zip that unzips to one folder. */
export async function downloadPostPack(item) {
  const JSZip = await loadZip();
  const zip = new JSZip();
  const name = packName(item);
  const missing = await fill(zip.folder(name), item);
  saveBlob(await zip.generateAsync({ type: 'blob' }), `${name}.zip`);
  return { missing };
}

/** Many items -> one zip of separate per-item folders. A week in one go. */
export async function downloadBatchPack(items, onProgress) {
  const JSZip = await loadZip();
  const zip = new JSZip();
  const seen = new Map();
  let missing = 0;
  for (let i = 0; i < items.length; i++) {
    let name = packName(items[i]);
    // Two items on the same day about the same bottleneck would collide, and
    // JSZip would silently merge them into one folder.
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name}_${n}`;
    missing += await fill(zip.folder(name), items[i]);
    if (onProgress) onProgress(i + 1, items.length);
  }
  const stamp = todayISO();
  saveBlob(await zip.generateAsync({ type: 'blob' }), `sanaku_approved_${stamp}.zip`);
  return { missing, count: items.length };
}
