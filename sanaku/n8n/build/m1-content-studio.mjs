// M1 - LinkedIn Content Studio.
//
// Generates one piece of LinkedIn content a day for Ismail's PERSONAL profile,
// rotating format across the week, and stages it in content_queue for approval.
// It does not publish. LinkedIn's API will not reliably post polls, carousels
// or articles to a personal profile, so the handoff is deliberate: the studio
// writes, the Marketing tab exports, Ismail pastes.
//
// Shape:
//   daily 7am -> pick brief -> read brand brain -> write -> validate
//             -> illustrate (best effort) -> insert as 'queued'
//
// Every format reads the SAME brand brain rows, which is what keeps voice and
// positioning identical across posts, carousels, polls, articles, newsletter
// editions and featured assets. Changing the positioning is a row edit in
// brand_brain, never a change to this workflow.
//
// ---------------------------------------------------------------------------
// WHERE THIS RUNS - read before installing
// ---------------------------------------------------------------------------
// The image step calls the Alexya wrapper, which listens on the Mac at
// 127.0.0.1:8000. Whether that address resolves depends on where n8n runs:
//
//   native n8n on the Mac      http://127.0.0.1:8000          works
//   n8n in a Docker container  http://host.docker.internal:8000  works
//   the remote n8n droplet     neither - needs a tunnel to the Mac
//
// So the URL comes from $env.ALEXYA_URL, defaulting to 127.0.0.1. Set that env
// var to match wherever this is installed.
//
// The image call is INTENTIONALLY non-fatal. If Alexya is unreachable - the Mac
// is asleep, the server is down, credits are out - the item is still queued,
// text complete, with needs_image flagged. A studio that stops producing
// writing because an illustrator is offline would be a worse studio.
import { writeFileSync } from 'node:fs';
import {
  dailyAt, code, gate, supaGet, supaWrite, openrouter, logError, sticky, to,
  workflow, RETRY,
} from './lib.mjs';

// Same model the existing Ismail/Sydney content workflows use.
const MODEL = 'google/gemma-4-31b-it';

// Credentials here are the repo's PLACEHOLDER names, same as every other
// workflow in n8n/workflows/. Real instance ids are wired in at install time
// by scripts/install-m1.sh, which is also where the naming drift is handled:
// the live OpenRouter credential is called "OpenRouter Sanaku", not the
// README's "OpenRouter (Header Auth)". A credential mismatch does not fail
// loudly at import - the node just shows a warning and every run 401s.

// ---------------------------------------------------------------------------
// 1. What are we making today?
// ---------------------------------------------------------------------------
const pickBrief = `// Decide the day's format, audience and bottleneck.
//
// The rotation lives here rather than in a settings table on purpose: it is one
// array, it changes rarely, and putting it in the database would mean a second
// place to look when the week's output is not what was expected. The POSITIONING
// is what needs to be editable without touching this file, and that is in
// brand_brain.

const now = new Date();

// Day of week, local. 0 = Sunday.
const dow = now.getDay();

// Three posts a week, because the text post is the daily driver and the thing
// the profile is actually judged on. The heavier formats are the authority
// layer, not the volume.
const WEEK = {
  0: 'article',      // Sunday    - long-form, people read on Sundays
  1: 'post',         // Monday
  2: 'carousel',     // Tuesday   - the authority builder
  3: 'post',         // Wednesday
  4: 'poll',         // Thursday  - engagement + market signal
  5: 'post',         // Friday
  6: 'newsletter',   // Saturday  - The Private Practice
};
let content_type = WEEK[dow];

// Featured assets are not timely - they are the pinned storefront. Refresh one
// on the first Sunday of the month instead of that week's article.
const dom = now.getDate();
if (dow === 0 && dom <= 7) content_type = 'featured';

// Audience rotation. Personal injury law is the priority vertical, so it gets
// every other slot; the rest cycle behind it. An 8-slot cycle over day-of-year
// keeps it from locking to a weekday - otherwise 'article' would be forever
// about family offices.
const VERTICALS = [
  'personal_injury_law', 'accounting_tax',
  'personal_injury_law', 'therapy',
  'personal_injury_law', 'financial_advisory',
  'personal_injury_law', 'family_office',
];
const startOfYear = new Date(now.getFullYear(), 0, 0);
const doy = Math.floor((now - startOfYear) / 86400000);
const target_vertical = VERTICALS[doy % VERTICALS.length];

// One bottleneck per item, never two. Cycles independently of the vertical so
// the pairings vary instead of always sending the same theme to the same reader.
const BOTTLENECKS = [
  'missed_calls', 'data_exposure', 'compliance_pressure',
  'loss_of_control', 'paperwork_load',
];
const bottleneck = BOTTLENECKS[doy % BOTTLENECKS.length];

// Which formats get artwork, and how many scenes.
//   post/featured - one illustration
//   carousel      - ONE cover illustration by default, not one per slide.
//                   A teaching carousel is text-forward; per-slide art costs
//                   ~31 credits a slide and usually reads worse than clean
//                   type. Per-slide art is available by raising this number.
//   poll/article/newsletter - none. Polls render as their own card on
//                   LinkedIn, and articles/newsletters carry their own header.
const IMAGES = { post: 1, featured: 1, carousel: 1, poll: 0, article: 0, newsletter: 0 };
const image_count = IMAGES[content_type] || 0;

const slug = [
  now.toISOString().slice(0, 10),
  bottleneck.replace(/_/g, '-'),
].join('_');

return [{ json: {
  content_type,
  target_vertical,
  bottleneck,
  image_count,
  needs_image: image_count > 0,
  slug,
  generated_for: now.toISOString().slice(0, 10),
} }];`;

// ---------------------------------------------------------------------------
// 2. Build the model request from the brand brain
// ---------------------------------------------------------------------------
const buildPrompt = `// Assemble the OpenRouter request. The whole brand brain for this channel and
// vertical goes in - not a top-k semantic slice - because every format must
// come out in the same voice, and "most similar rows" is not the same thing as
// "the brief".

const brief = $('Pick today\\'s brief').first().json;

// PostgREST returns a JSON array, and n8n splits an array response into ONE
// ITEM PER ELEMENT. So the rows arrive as $input.all(), and $input.first()
// would be a single brand_brain row - which reads as "the brain is empty"
// rather than as a shape error. Handle the wrapped-array case too, in case a
// future n8n version stops splitting.
const raw = $input.all().map((i) => i.json);
const brain = (raw.length === 1 && Array.isArray(raw[0]) ? raw[0] : raw)
  .filter((r) => r && r.kind && r.content);

if (!brain.length) {
  throw new Error('brand_brain returned no linkedin rows - refusing to write off-brief. Check the seed ran and channel=linkedin rows exist.');
}

const section = (kinds) => brain
  .filter((r) => kinds.includes(r.kind))
  .map((r) => '### ' + r.title + '\\n' + r.content)
  .join('\\n\\n');

const positioning = section(['offer']);
const voice = section(['brand_voice', 'voice']);
const rules = section(['rule']);
const audience = section(['icp']);
const objections = section(['objection']);
const extras = section(['message_snippet', 'proof', 'proof_point', 'case_study']);

// Per-format instructions and the exact JSON each must return. Keeping the
// schema next to the instruction is what makes the parse step downstream a
// validation rather than a guess.
const FORMATS = {
  post: {
    how: 'Write ONE LinkedIn text post. 120-200 words. Open with a hook of one or two lines that survives truncation - LinkedIn cuts off around there and the reader decides on those lines alone. Then the teaching body. Then a one-line takeaway the reader could repeat to a partner. No hashtags. No emoji. No call to action.',
    json: '{"post_text": "the full post, newlines allowed", "image_prompt": "one sentence describing a flat-cartoon scene that illustrates the idea"}',
  },
  carousel: {
    how: 'Write a LinkedIn document carousel of 5 to 8 slides. It must be a real teaching sequence, not a post chopped into pieces. Slide 1 is the promise and names the payoff. Middle slides carry ONE idea each in under 25 words. The last slide is the takeaway. It has to be useful screenshotted with no caption.',
    json: '{"title": "the carousel title", "slides": [{"text": "slide 1 text"}, {"text": "slide 2 text"}], "post_text": "the short caption that accompanies the document when posted", "image_prompt": "one sentence describing a flat-cartoon cover scene"}',
  },
  poll: {
    how: 'Write ONE LinkedIn poll. The question must be one the reader genuinely does not know the answer to about their own firm - not a leading question with an obvious right answer. 2 to 4 options, each under 30 characters. Add a short body that gives the question context and teaches something.',
    json: '{"poll_question": "the question, under 140 characters", "poll_options": ["option 1", "option 2", "option 3"], "post_text": "the accompanying body text"}',
  },
  article: {
    how: 'Write ONE LinkedIn article on a single bottleneck. 700-1200 words. Real structure with subheads. Go deeper than a post can - this is where the mechanism gets explained properly, without ever crossing into how the system is built.',
    json: '{"title": "the article headline", "body": "the full article with markdown subheads"}',
  },
  newsletter: {
    how: 'Write ONE edition of the newsletter named The Private Practice. 500-900 words. The most personal of the formats - first person throughout, the register of explaining something to one managing partner across a desk. It ties this weeks theme together and must stand alone. Consistent sign-off. Never beg for subscribers.',
    json: '{"title": "the edition title", "body": "the full edition with markdown subheads"}',
  },
  featured: {
    how: 'Write ONE Featured-section asset for the profile - a pinned proof piece, not a timely post. Pick whichever of the three is most relevant to this bottleneck: the "what I do" one-pager, the before/after explainer, or the "hidden risk" explainer. It is a storefront piece, so it should read as durable rather than newsy.',
    json: '{"title": "the asset name", "body": "the full asset copy", "image_prompt": "one sentence describing a flat-cartoon scene for the asset"}',
  },
};

const spec = FORMATS[brief.content_type];
if (!spec) throw new Error('no format spec for ' + brief.content_type);

const system = [
  'You write LinkedIn content as Ismail Rogers-Wright, in the first person.',
  'This is his PERSONAL profile, not a company page. Never write as "we" or as a brand.',
  '',
  '## Positioning', positioning,
  '', '## Voice - match this exactly', voice,
  '', '## Hard rules - these override everything else', rules,
  '', '## Who you are writing for today', audience,
  '', '## Objections you may hear', objections,
  extras ? '\\n## Other context\\n' + extras : '',
  '',
  '## Output',
  'Return ONLY minified JSON matching this shape, with no markdown fence and no commentary:',
  spec.json,
].join('\\n');

const user = [
  'Format: ' + brief.content_type,
  'Audience: ' + brief.target_vertical,
  'Bottleneck to address (exactly this one, not any other): ' + brief.bottleneck,
  '',
  spec.how,
  '',
  'The image_prompt, if the shape asks for one, describes a SCENE only - no style words, they are added later. Two things the illustrator gets wrong unless you are explicit: to show an empty room you must say "no people, nobody in frame"; to show something inside a building you must say "cutaway view" or it will be drawn on the roof.',
].join('\\n');

const requestBody = JSON.stringify({
  model: '${MODEL}',
  temperature: 0.8,
  max_tokens: 4000,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ],
});

return [{ json: { ...brief, requestBody } }];`;

// ---------------------------------------------------------------------------
// 3. Validate what came back
// ---------------------------------------------------------------------------
const parseContent = `// Turn the model response into a content_queue row, or fail loudly.
//
// The per-format CHECK constraint on content_queue would reject a malformed row
// anyway, but failing here gives a readable error in the execution log instead
// of a Postgres constraint name.

const brief = $('Pick today\\'s brief').first().json;
const res = $input.first().json;

const raw = res?.choices?.[0]?.message?.content;
if (!raw) throw new Error('model returned no content: ' + JSON.stringify(res).slice(0, 400));

// Free models fence their JSON despite being told not to, and sometimes add a
// sentence before it. Take the outermost JSON object.
let text = String(raw).trim().replace(/^\\\`\\\`\\\`(?:json)?/i, '').replace(/\\\`\\\`\\\`$/, '').trim();
const start = text.indexOf('{');
const end = text.lastIndexOf('}');
if (start === -1 || end === -1) throw new Error('no JSON object in model output: ' + text.slice(0, 300));
text = text.slice(start, end + 1);

let out;
try {
  out = JSON.parse(text);
} catch (e) {
  throw new Error('model output was not valid JSON (' + e.message + '): ' + text.slice(0, 300));
}

const t = brief.content_type;
const need = (field) => {
  const v = out[field];
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) {
    throw new Error(t + ' is missing required field "' + field + '"');
  }
  return v;
};

const row = {
  content_type: t,
  target_vertical: brief.target_vertical,
  bottleneck: brief.bottleneck,
  status: 'queued',
  audience: brief.target_vertical,
  angle: brief.bottleneck,
};

if (t === 'post') {
  row.post_text = need('post_text');
} else if (t === 'carousel') {
  row.title = need('title');
  const slides = need('slides');
  if (!Array.isArray(slides) || slides.length < 5 || slides.length > 8) {
    throw new Error('carousel needs 5-8 slides, got ' + (Array.isArray(slides) ? slides.length : typeof slides));
  }
  // Accept ["text", ...] as well as [{text}, ...] - the model drifts between them.
  row.slides = slides.map((s) => (typeof s === 'string' ? { text: s } : { text: String(s.text || '') }));
  if (row.slides.some((s) => !s.text.trim())) throw new Error('a carousel slide came back empty');
  row.post_text = out.post_text || null;
} else if (t === 'poll') {
  row.poll_question = need('poll_question');
  const opts = need('poll_options');
  if (!Array.isArray(opts) || opts.length < 2 || opts.length > 4) {
    throw new Error('poll needs 2-4 options, got ' + (Array.isArray(opts) ? opts.length : typeof opts));
  }
  row.poll_options = opts.map((o) => String(o));
  row.post_text = out.post_text || null;
} else if (t === 'article' || t === 'newsletter') {
  row.title = need('title');
  row.body = need('body');
} else if (t === 'featured') {
  row.title = need('title');
  row.body = out.body || null;
}

// Scene description for the illustrator, if this format takes artwork.
const image_prompt = out.image_prompt || null;
if (brief.needs_image && image_prompt) row.image_prompt = image_prompt;

return [{ json: {
  ...brief,
  row,
  image_prompt,
  // Only try to illustrate when the format wants art AND we got a scene for it.
  illustrate: Boolean(brief.needs_image && image_prompt),
} }];`;

// ---------------------------------------------------------------------------
// 4. Fold whatever the illustrator managed into the row
// ---------------------------------------------------------------------------
const attachImages = `// Best-effort. Alexya being down must not cost us the writing.

const prev = $('Validate the draft').first().json;
const row = { ...prev.row };

let urls = [];
let note = null;
try {
  const res = $input.first().json;
  if (res && Array.isArray(res.image_urls)) urls = res.image_urls.filter(Boolean);
  if (res && res.error) note = String(res.error);
} catch (e) {
  note = e.message;
}

if (urls.length) {
  row.image_url = urls[0];
  // A carousel cover illustrates slide 1; the rest stay text.
  if (row.content_type === 'carousel' && Array.isArray(row.slides)) {
    row.slides = row.slides.map((s, i) => (i < urls.length ? { ...s, image_url: urls[i] } : s));
  }
} else {
  console.log('[m1] no illustration attached' + (note ? ': ' + note : '') + ' - queueing text-only');
}

return [{ json: { ...prev, row, image_attached: urls.length } }];`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
const nodes = [
  sticky(
    '## M1 - LinkedIn Content Studio\n\n'
    + "Writes one item a day for Ismail's personal LinkedIn and stages it in "
    + '`content_queue` as `queued`. **It never publishes.**\n\n'
    + '### Rotation\n'
    + 'Sun article (1st Sun: featured) / Mon post / Tue carousel / Wed post / '
    + 'Thu poll / Fri post / Sat newsletter\n\n'
    + '### The brief lives in Supabase, not here\n'
    + 'Positioning, voice, audience and guardrails are `brand_brain` rows with '
    + "`channel = 'linkedin'`. Edit those, not this workflow.\n\n"
    + '### Alexya\n'
    + 'Set `$env.ALEXYA_URL` to something this n8n can actually reach:\n'
    + '- native on the Mac: `http://127.0.0.1:8000`\n'
    + '- in Docker: `http://host.docker.internal:8000`\n'
    + '- remote droplet: needs a tunnel back to the Mac\n\n'
    + 'The image step is non-fatal by design - if Alexya is unreachable the item '
    + 'still queues, text complete.\n\n'
    + '### Video\n'
    + 'Phase 2. `content_kind` has the value; nothing generates it yet.',
    [-460, -200], { width: 460, height: 620, color: 4 },
  ),

  dailyAt('Daily 7am', 7, [40, 0]),
  code("Pick today's brief", pickBrief, [260, 0]),

  supaGet(
    'Read the brand brain',
    'brand_brain'
    + '?select=kind,title,content,vertical'
    + '&channel=eq.linkedin'
    + '&status=in.(proven,testing)'
    + '&or=(vertical.is.null,vertical.eq.{{ $json.target_vertical }})'
    + '&order=kind.asc',
    [480, 0],
  ),

  code('Build the brief prompt', buildPrompt, [700, 0]),
  openrouter('Write it', [920, 0]),
  code('Validate the draft', parseContent, [1140, 0]),

  gate('Needs artwork?', '$json.illustrate', [1360, 0]),

  {
    parameters: {
      method: 'POST',
      url: "={{ $env.ALEXYA_URL || 'http://127.0.0.1:8000' }}/generate-illustration",
      sendBody: true, specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({'
        + ' prompts: [$json.image_prompt],'
        + ' slug: $json.slug,'
        + ' project: "sanaku",'
        + ' bucket: "sanaku-marketing",'
        + ' aspect_ratio: "1:1",'
        + ' mode: "fast"'
        + ' }) }}',
      options: { timeout: 600000 },
    },
    id: 'e9000000-0000-4000-8000-000000000001',
    name: 'Alexya: illustrate',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1580, -110],
    // Non-fatal on purpose. See the header note.
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
    retryOnFail: true, maxTries: 2, waitBetweenTries: 5000,
  },

  code('Attach artwork', attachImages, [1800, -110]),

  supaWrite(
    'Queue it',
    'POST',
    'content_queue',
    '={{ JSON.stringify($json.row) }}',
    [2020, 0],
    { prefer: 'return=representation' },
  ),

  logError(
    'Log the failure',
    '$json.error?.message || "content studio run failed"',
    'JSON.stringify({ content_type: $json.content_type, vertical: $json.target_vertical })',
    [2020, 200],
  ),
];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// The false branch of the gate goes straight to the insert: formats without
// artwork (poll, article, newsletter) are complete as soon as they validate.
const connections = {
  'Daily 7am': { main: [to("Pick today's brief")] },
  "Pick today's brief": { main: [to('Read the brand brain')] },
  'Read the brand brain': { main: [to('Build the brief prompt')] },
  'Build the brief prompt': { main: [to('Write it')] },
  'Write it': { main: [to('Validate the draft')] },
  'Validate the draft': { main: [to('Needs artwork?')] },
  'Needs artwork?': { main: [to('Alexya: illustrate'), to('Queue it')] },
  'Alexya: illustrate': { main: [to('Attach artwork')] },
  'Attach artwork': { main: [to('Queue it')] },
};

const wf = workflow('Sanaku - M1 Content Studio', nodes, connections);
writeFileSync(process.argv[2], JSON.stringify(wf, null, 2) + '\n');
console.log('wrote', process.argv[2], nodes.length, 'nodes');
