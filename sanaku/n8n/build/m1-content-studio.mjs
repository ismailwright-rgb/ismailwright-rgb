// M1 - LinkedIn Content Studio.
//
// Three DRAFTS a morning, seven days a week, for Ismail's personal LinkedIn.
// He publishes what he likes from the Marketing tab; the rest are deleted. The
// studio never posts - LinkedIn's API will not reliably publish polls,
// carousels or articles to a personal profile.
//
// ---------------------------------------------------------------------------
// Why this is shaped like the Sydney pipeline
// ---------------------------------------------------------------------------
// V1 was a single LLM call: brand brain in, finished post out. It produced
// writing that was correct, on-message and forgettable, because nothing in it
// had a point of view before it started writing, and nothing remembered what it
// had already said.
//
// Sydney solves both, and this borrows the structure wholesale:
//
//   Sydney                              Sanaku
//   ------------------------------      ------------------------------------
//   story engine (mood/events)      ->  ANGLE ENGINE (thesis / why-now)
//   captions written FROM the story ->  item written FROM the angle
//   sydney_story, last 7 days       ->  recent theses, avoid repeats
//   sydney_memory, extracted daily  ->  content_memory, extracted daily
//   image_brief -> composed prompt   ->  scene brief -> composed prompt
//
// The two-stage split is the whole trick. Deciding WHAT to argue is a different
// job from writing it well, and a model asked to do both at once does neither.
//
// ---------------------------------------------------------------------------
// Where it runs
// ---------------------------------------------------------------------------
// The droplet, installed by scripts/install-m1.sh. It cannot reach Alexya
// (127.0.0.1:8000 on the Mac), so it generates no artwork at all - it writes a
// scene brief and stops. scripts/illustrate-queue.py draws APPROVED items
// locally afterwards. At three drafts a day, illustrating every draft would
// spend most of the Alexya balance on content that never ships.
import { writeFileSync } from 'node:fs';
import {
  dailyAt, code, gate, respond, supaGet, supaWrite, openrouter, logError,
  sticky, to, workflow, RETRY,
} from './lib.mjs';

// A ROTATING POOL of free models, not one primary with fixed spares.
//
// The free tier is a shared pool that rate-limits constantly, so "the model"
// is not a thing you can depend on - only "a model that is answering right
// now" is. Probed live on 2026-08-10, and the result made the point: the
// primary that had been configured (gemma-4-31b:free) was 429ing at that
// moment, and one of its two fallbacks (nemotron-3-super-120b:free) did not
// respond at all. A static list decided once is a list that rots.
//
// So: OpenRouter's `models` array handles fallback within a request (it falls
// through on a provider error), and the STARTING POINT rotates per call and
// per day so consecutive attempts do not all hammer whichever model is
// currently throttled. Three entries is the API's hard cap on that array.
//
// The pool is ordered by how well each followed instructions in that probe.
// The nemotron entries leak their reasoning into the response - harmless here
// only because both stages parse delimited blocks and ignore loose prose,
// which is a large part of why that format was chosen.
//
// Override either without a rebuild:
//   OPENROUTER_MODEL   pin one model, e.g. anthropic/claude-sonnet-5
//   OPENROUTER_MODELS  replace the whole pool, comma-separated
const POOL_DEFAULT = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-30b-a3b:free',
];

// The angle engine gets a narrower pool, and this is not fussiness.
//
// The nemotron entries answer reliably but emit their reasoning instead of the
// requested format. For the WRITER that is harmless - the block parser ignores
// loose prose before the first tag. For the ANGLE ENGINE it is fatal: a live
// run came back "We need to output exactly three angles, each with the format
// lines" and not a single [ANGLE] block, so there was nothing to parse.
//
// Only models that returned clean, exactly-formatted output when probed go
// here. Prose stages keep the full pool, so throttling still has somewhere to
// fall through to.
const POOL_STRUCTURED = [
  'google/gemma-4-26b-a4b-it:free',
  'google/gemma-4-31b-it:free',
];

// `salt` staggers the three calls in one run so a throttled model cannot take
// out the whole morning: the angle engine, the writer and the memory pass each
// start at a different point in the pool.
const modelPicker = (salt, pool = POOL_DEFAULT) => `
// --- model selection (rotating free pool) ---
const __env = (k) => (typeof $env !== 'undefined' && $env[k]) ? $env[k] : null;
const __pinned = __env('OPENROUTER_MODEL');
const __pool = (__env('OPENROUTER_MODELS') || '').split(',').map((x) => x.trim()).filter(Boolean);
const __models = __pool.length ? __pool : ${JSON.stringify(pool)};
const __day = Math.floor(Date.now() / 86400000);
const __off = (__day + ${salt}) % __models.length;
// Pinned wins outright, but still carries spares behind it so a paid model
// being briefly unavailable does not stop the studio.
// Deduped: a pool shorter than three would otherwise wrap and repeat an
// entry, which wastes one of the three slots the API allows and gives the
// request a spare that is the model that just failed.
const __ordered = __pinned
  ? [__pinned].concat(__models.filter((m) => m !== __pinned))
  : __models.map((_, i) => __models[(__off + i) % __models.length]);
const __trio = __ordered.filter((m, i) => __ordered.indexOf(m) === i).slice(0, 3);
`;

const DRAFTS_PER_DAY = 3;

// ---------------------------------------------------------------------------
// 0. What was asked for
// ---------------------------------------------------------------------------
const normalizeRequest = `// What was asked for, from either trigger.
//
// Both the 7am cron and the Generate button land here, so nothing downstream
// has to know which one fired. Referencing a node that did not run throws in
// n8n, and that throw IS the signal: no webhook node means this is the cron.
let body = {};
try {
  body = $('Generate now').first().json.body || {};
} catch (e) {
  body = null;   // scheduled run
}

if (body === null) {
  return [{ json: { source: 'schedule', forced_type: null, count: ${DRAFTS_PER_DAY} } }];
}

const TYPES = ['post', 'carousel', 'poll', 'article', 'newsletter', 'featured'];
const forced = TYPES.includes(body.content_type) ? body.content_type : null;

// Capped at 5. Each draft is a separate model call on a rate-limited free tier,
// so a request for fifty would mostly produce failures and a long wait.
let count = parseInt(body.count, 10);
if (!Number.isFinite(count) || count < 1) count = forced ? 1 : ${DRAFTS_PER_DAY};
count = Math.min(count, 5);

return [{ json: { source: 'on_demand', forced_type: forced, count } }];`;

// ---------------------------------------------------------------------------
// 1. What is actually happening in their world today
// ---------------------------------------------------------------------------
const buildQueries = `// Real triggers beat evergreen. A post about state bar AI guidance the week it
// changes is worth ten timeless ones about data custody.
//
// Google News RSS needs no key and no quota, which is why it is used here
// rather than a paid news API.

// Four a day, rotated, so every vertical gets covered across the week without
// four times the requests every morning.
const QUERIES = [
  { q: 'state bar artificial intelligence guidance lawyers', vertical: 'personal_injury_law' },
  { q: 'law firm data breach client records', vertical: 'personal_injury_law' },
  { q: 'IRS Circular 230 artificial intelligence tax preparer', vertical: 'accounting_tax' },
  { q: 'accounting firm client data breach', vertical: 'accounting_tax' },
  { q: 'HIPAA artificial intelligence therapy notes', vertical: 'therapy' },
  { q: 'mental health app patient data privacy', vertical: 'therapy' },
  { q: 'SEC FINRA artificial intelligence adviser compliance', vertical: 'financial_advisory' },
  { q: 'registered investment adviser data breach', vertical: 'financial_advisory' },
  { q: 'family office cybersecurity private wealth', vertical: 'family_office' },
  { q: 'AI vendor training data lawsuit confidential', vertical: null },
  { q: 'chatbot leaked confidential business data', vertical: null },
  { q: 'professional services artificial intelligence policy', vertical: null },
];

const now = new Date();
const startOfYear = new Date(now.getFullYear(), 0, 0);
const doy = Math.floor((now - startOfYear) / 86400000);

const picked = [];
for (let i = 0; i < 4; i++) {
  picked.push(QUERIES[(doy * 4 + i) % QUERIES.length]);
}

return picked.map((p) => ({ json: {
  url: 'https://news.google.com/rss/search?q=' + encodeURIComponent(p.q)
       + '&hl=en-US&gl=US&ceid=US:en',
  query: p.q,
  vertical: p.vertical,
} }));`;

const parseTriggers = `// Collapse the per-query responses into ONE item carrying all the headlines.
//
// This node exists because n8n runs the fetch once per query and would
// otherwise carry four items forward, making every downstream node run four
// times. Everything after this point is single-item.

const items = $input.all();
const triggers = [];

for (const item of items) {
  const xml = typeof item.json.data === 'string' ? item.json.data
            : typeof item.json.body === 'string' ? item.json.body
            : '';
  if (!xml) continue;

  // A regex parser, not an XML one: the Code node has no DOM, and RSS from one
  // known publisher is regular enough that a parser is not worth the weight.
  const blocks = xml.split('<item>').slice(1, 7);
  for (const b of blocks) {
    const grab = (tag) => {
      const m = b.match(new RegExp('<' + tag + '>([\\\\s\\\\S]*?)</' + tag + '>'));
      if (!m) return null;
      return m[1]
        .replace(/<!\\[CDATA\\[|\\]\\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .trim();
    };
    const title = grab('title');
    if (!title) continue;
    triggers.push({
      title,
      url: grab('link'),
      published: grab('pubDate'),
      source: grab('source'),
    });
  }
}

// Newest first, and deduplicated - Google News repeats the same story across
// queries constantly.
const seen = new Set();
const unique = triggers.filter((t) => {
  const k = t.title.toLowerCase().slice(0, 60);
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log('[m1] ' + unique.length + ' unique headlines from ' + items.length + ' queries');
return [{ json: { triggers: unique.slice(0, 18) } }];`;

// ---------------------------------------------------------------------------
// 2. Decide what today is about, before writing a word of it
// ---------------------------------------------------------------------------
const buildAngles = `${modelPicker(0, POOL_STRUCTURED)}// THE ANGLE ENGINE. Sydney's story engine, doing the equivalent job.
//
// It does not write the post. It decides what three genuinely different things
// are worth saying today, and commits each to a one-sentence thesis. Prose gets
// written in the next step, FROM that thesis. Everything good about this
// pipeline comes from that separation.

const ctx = $input.first().json;
const triggers = $('Read the signals').first().json.triggers || [];
const req = $('What was asked for').first().json;
const WANT = req.count;

const brain = ctx.brain || [];
if (!brain.length) {
  throw new Error('brand_brain returned no linkedin rows - refusing to write off-brief. Check the seed ran.');
}

const section = (kinds) => brain
  .filter((r) => kinds.includes(r.kind))
  .map((r) => '### ' + r.title + '\\n' + r.content)
  .join('\\n\\n');

const memory = (ctx.memory || [])
  .map((m) => '- [' + m.category + '] ' + m.key + ': ' + m.value)
  .join('\\n') || '(nothing remembered yet - this is an early run)';

const recent = (ctx.recent || []).slice(0, 20)
  .map((r) => '- ' + r.day + ' ' + r.content_type + ' / ' + (r.vertical || '?')
              + ' / ' + (r.bottleneck || '?') + ': ' + (r.thesis || r.title || '(no thesis recorded)'))
  .join('\\n') || '(nothing published yet)';

const approved = (ctx.approved_recent || [])
  .map((r) => '- ' + r.content_type + ': ' + (r.thesis || '(no thesis)'))
  .join('\\n') || '(nothing approved yet)';

const counts = ctx.format_counts || {};
const FORMATS = ['post', 'carousel', 'poll', 'article', 'newsletter', 'featured'];
const gaps = FORMATS.map((f) => f + '=' + (counts[f] || 0)).join(', ');
const starved = FORMATS.filter((f) => !counts[f]);

const headlines = triggers.length
  ? triggers.map((t, i) => (i + 1) + '. ' + t.title + (t.source ? ' (' + t.source + ')' : '')
                           + (t.url ? '\\n   ' + t.url : '')).join('\\n')
  : '(no headlines pulled today - go evergreen)';

const system = [
  'You are the editorial director for Ismail Rogers-Wright\\'s personal LinkedIn.',
  'You do NOT write posts. You decide what is worth saying, and hand each decision to a writer.',
  '',
  '## The positioning everything ladders to', section(['offer']),
  '', '## The voice the writer will use', section(['brand_voice', 'voice']),
  '', '## Hard rules - these bind you too', section(['rule']),
  '', '## The five audiences', section(['icp']),
  '', '## Objections that come up', section(['objection']),
  '',
  '## What has already been said - DO NOT REPEAT ANY OF THIS',
  recent,
  '',
  '## What Ismail actually approved (he liked these - note what they have in common)',
  approved,
  '',
  '## Long-term memory - arguments, analogies and openers already spent',
  memory,
].join('\\n');

const user = [
  '## Real headlines from the last few days',
  headlines,
  '',
  '## Format balance over the last 7 days',
  gaps + (starved.length ? '  <- NOT USED AT ALL THIS WEEK: ' + starved.join(', ') : ''),
  '',
  '## Your job',
  'Choose EXACTLY ' + WANT + ' angle' + (WANT === 1 ? '' : 's') + ' for today. They are alternatives Ismail will choose between,',
  'so they must be genuinely different from each other - different audience, different',
  'bottleneck, or a fundamentally different argument. Three phrasings of one idea is a',
  'failure. So is three posts about data exposure to law firms.',
  '',
  'Rules for choosing:',
  '- Prefer an angle anchored to a real headline above. Say which one. If nothing in the',
  '  list genuinely touches a confidentiality-driven profession, go evergreen rather than',
  '  forcing a connection - a strained news hook reads worse than none.',
  '- Favour formats not used this week, unless a specific angle demands otherwise.',
  '- Each angle targets exactly ONE bottleneck for ONE audience.',
  '- The thesis must be arguable. "AI is risky" is not a thesis. "A BAA tells you who is',
  '  liable after a breach, not where the data sits" is.',
  '- Nothing that repeats a thesis in the DO NOT REPEAT list, in substance or in framing.',
  '',
  'Output format - follow EXACTLY. Your very first characters must be "[ANGLE]".',
  'No JSON, no markdown fence, no preamble, no reasoning, no commentary, no',
  'restating of the task. Do not think out loud. Every tag alone at the start',
  'of its line.',
  'Emit this block ' + WANT + ' time' + (WANT === 1 ? '' : 's') + ', once per angle:',
  '',
  '[ANGLE]',
  '[TYPE] one of: post carousel poll article newsletter featured',
  '[VERTICAL] one of: personal_injury_law accounting_tax therapy financial_advisory family_office',
  '[BOTTLENECK] one of: missed_calls data_exposure compliance_pressure loss_of_control paperwork_load',
  '[THESIS] the single arguable sentence this piece exists to land',
  '[WHYNOW] what makes today the day - omit this line entirely if evergreen',
  '[SOURCE_TITLE] the exact headline used - omit if none',
  '[SOURCE_URL] its url - omit if none',
  '[HOOK] the opening line, written to survive LinkedIn truncation',
  '[BEAT] one teaching step',
  '[BEAT] the next teaching step (3-5 [BEAT] lines in total, in order)',
  '[SCENE] a concrete visual moment that illustrates the thesis - who is in it, where, what is happening. No style words.',
  '[DISTINCT] one line on how this differs from the other two angles',
  '[/ANGLE]',
].join('\\n');

const requestBody = JSON.stringify({
  model: __trio[0],\n  models: __trio,
  temperature: 0.95,
  max_tokens: 3000,
  messages: [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ],
});

return [{ json: { requestBody, trigger_count: triggers.length } }];`;

const parseAngles = `// Turn the editorial decision into up to ${DRAFTS_PER_DAY} items, one per draft.
//
// Blocks, not JSON, for the same reason the writer uses them: the free-tier
// fallbacks include reasoning models that emit their working before the answer.
// A JSON parser sees that as garbage; a block scanner simply ignores it.

const res = $input.first().json;
let raw = res?.choices?.[0]?.message?.content;
if (!raw) {
  const e = res?.error;
  throw new Error(e ? ('angle engine provider error: ' + (e.message || JSON.stringify(e)).slice(0, 200))
                    : 'angle engine returned nothing: ' + JSON.stringify(res).slice(0, 300));
}

// Reasoning models wrap their working in <think>. Drop it before scanning.
let text = String(raw).replace(/<think>[\\s\\S]*?<\\/think>/gi, '').trim();

const angles = [];
let cur = null;
let lastTag = null;

const finish = () => {
  if (cur && cur.thesis && cur.content_type && cur.target_vertical) angles.push(cur);
  cur = null; lastTag = null;
};

for (const line of text.replace(/\\r/g, '').split('\\n')) {
  const t = line.trim();

  if (/^\\[ANGLE\\]$/i.test(t)) { finish(); cur = { beats: [] }; continue; }
  if (/^\\[\\/ANGLE\\]$/i.test(t)) { finish(); continue; }
  if (!cur) continue;

  const m = t.match(/^\\[(TYPE|VERTICAL|BOTTLENECK|THESIS|WHYNOW|SOURCE_TITLE|SOURCE_URL|HOOK|BEAT|SCENE|DISTINCT)\\]\\s*(.*)$/i);
  if (m) {
    const tag = m[1].toUpperCase();
    // Models restate the menu ("one of: post carousel ..."). Take the first
    // token for enum fields so a copied instruction line still resolves.
    const val = m[2].trim().replace(/^one of:\\s*/i, '');
    if (tag === 'BEAT') { cur.beats.push(val); lastTag = ['beats', cur.beats.length - 1]; continue; }
    const key = { TYPE: 'content_type', VERTICAL: 'target_vertical', BOTTLENECK: 'bottleneck',
                  THESIS: 'thesis', WHYNOW: 'why_now', SOURCE_TITLE: 'source_title',
                  SOURCE_URL: 'source_url', HOOK: 'hook', SCENE: 'scene',
                  DISTINCT: 'distinct_from' }[tag];
    cur[key] = ['content_type', 'target_vertical', 'bottleneck'].includes(key)
      ? val.split(/[\\s,|]+/)[0].toLowerCase()
      : val;
    lastTag = [key, null];
    continue;
  }

  // Untagged line continues the tag above it.
  if (lastTag && t) {
    const [k, i] = lastTag;
    if (i === null) cur[k] = (cur[k] ? cur[k] + ' ' : '') + t;
    else cur[k][i] = (cur[k][i] ? cur[k][i] + ' ' : '') + t;
  }
}
finish();

const TYPES = ['post', 'carousel', 'poll', 'article', 'newsletter', 'featured'];
const VERTS = ['personal_injury_law', 'accounting_tax', 'therapy', 'financial_advisory', 'family_office'];
const BNECKS = ['missed_calls', 'data_exposure', 'compliance_pressure', 'loss_of_control', 'paperwork_load'];

const usable = angles.filter((a) => TYPES.includes(a.content_type) && VERTS.includes(a.target_vertical));
if (!usable.length) {
  throw new Error('no usable angles in the response. Got ' + angles.length
    + ' block(s). First 300 chars: ' + text.slice(0, 300));
}

// One id shared by the morning's drafts, so the tab can show them as a set of
// alternatives rather than three unrelated items.
const group = [
  Math.random().toString(16).slice(2, 10),
  Math.random().toString(16).slice(2, 6),
  '4' + Math.random().toString(16).slice(2, 5),
  '8' + Math.random().toString(16).slice(2, 5),
  Math.random().toString(16).slice(2, 14),
].join('-');

const day = new Date().toISOString().slice(0, 10);

console.log('[m1] ' + usable.length + ' angles of ' + angles.length + ' blocks');

const req = $('What was asked for').first().json;
// A forced format is a hard filter, not a hint - the free models drift back to
// 'post' whatever the instruction says.
const wanted = req.forced_type
  ? (usable.filter((a) => a.content_type === req.forced_type).length
      ? usable.filter((a) => a.content_type === req.forced_type)
      : usable.map((a) => ({ ...a, content_type: req.forced_type })))
  : usable;

return wanted.slice(0, req.count).map((a, i) => ({ json: {
  ...a,
  bottleneck: BNECKS.includes(a.bottleneck) ? a.bottleneck : 'data_exposure',
  why_now: a.why_now || null,
  source_title: a.source_title || null,
  source_url: a.source_url || null,
  draft_group: group,
  draft_index: i + 1,
  generated_for: day,
} }));`;

// ---------------------------------------------------------------------------
// 3. Write each one FROM its angle
// ---------------------------------------------------------------------------
const buildItems = `${modelPicker(1)}// One request per angle. The writer never re-decides what to argue - the thesis
// is handed to it and it writes to that. This is the half that V1 collapsed
// into the same call, and why V1 drifted to whatever the model found easiest.

const ctx = $('Studio context').first().json;
const brain = ctx.brain || [];

const section = (kinds, vertical) => brain
  .filter((r) => kinds.includes(r.kind))
  .filter((r) => !vertical || !r.vertical || r.vertical === vertical)
  .map((r) => '### ' + r.title + '\\n' + r.content)
  .join('\\n\\n');

// Output is DELIMITED BLOCKS, not JSON.
//
// JSON was the first attempt and it failed on two of every three drafts. The
// failures were always the same: a free-tier model emitting multi-paragraph
// prose inside a JSON string value, and getting the newline and quote escaping
// wrong somewhere around character 1200. "Expected ',' or '}' after property
// value" is not a prompting problem you can fix by asking more firmly - it is
// a format that requires the writer to escape its own output while writing.
//
// Blocks need no escaping at all, so the writer can just write.
const SHAPES = {
  post: {
    how: 'Write ONE LinkedIn text post, 130-220 words. Open with the hook you were given, or something better in the same direction - it has to survive truncation at two lines. Then walk the beats. Close on a takeaway a reader could repeat to a partner from memory. No hashtags, no emoji, no call to action, no "thoughts?"',
    blocks: '[POST]\\nthe full post, as many paragraphs as it needs\\n[/POST]',
  },
  carousel: {
    how: 'Write a document carousel of 5-8 slides that teaches the beats in order. Slide 1 states the promise and names the payoff. Each middle slide carries ONE idea in under 25 words - these are read at a glance, not studied. The final slide is the takeaway. It must stand alone screenshotted with no caption.',
    blocks: '[TITLE] the carousel title\\n[CAPTION]\\nthe short caption that accompanies the document\\n[/CAPTION]\\n[SLIDE] slide 1 text\\n[SCENE] a concrete visual moment for slide 1, no style words\\n[SLIDE] slide 2 text\\n[SCENE] a concrete visual moment for slide 2\\n(repeat [SLIDE] then [SCENE] for every slide, 5 to 8 of them)',
  },
  poll: {
    how: 'Write ONE poll. The question must be one the reader genuinely cannot answer about their own firm without going and checking - that discomfort is the whole point. Not a leading question with an obvious right answer. 2-4 options, each under 30 characters. Then a body that teaches the beats and earns the question.',
    blocks: '[QUESTION] the poll question, under 140 characters\\n[OPTION] first option\\n[OPTION] second option\\n(2 to 4 [OPTION] lines total)\\n[POST]\\nthe body text that sets up the question\\n[/POST]',
  },
  article: {
    how: 'Write ONE long-form article, 800-1300 words, working through the beats with real subheads. This is where the mechanism gets explained properly. Go deeper than a post can - concrete scenarios, the actual sequence of how the exposure happens, what a firm would see and not see. Never cross into how the system is built.',
    blocks: '[TITLE] the headline\\n[BODY]\\nthe full article, using ## for subheads\\n[/BODY]',
  },
  newsletter: {
    how: 'Write ONE edition of "The Private Practice", 600-1000 words. The most personal register of any format - first person throughout, the way you would explain this to one managing partner across a desk. It must stand alone. Consistent sign-off. Never ask for subscribers.',
    blocks: '[TITLE] the edition title\\n[BODY]\\nthe full edition, using ## for subheads\\n[/BODY]',
  },
  featured: {
    how: 'Write ONE Featured-section asset - a pinned proof piece, not a timely post. Durable, not newsy. Pick whichever fits: the "what I do" one-pager, the before/after explainer, or the "hidden risk" explainer.',
    blocks: '[TITLE] the asset name\\n[BODY]\\nthe full copy\\n[/BODY]',
  },
};

return $input.all().map((item) => {
  const a = item.json;
  const shape = SHAPES[a.content_type];
  if (!shape) throw new Error('no shape for ' + a.content_type);

  const system = [
    'You are Ismail Rogers-Wright, writing in the first person on your PERSONAL LinkedIn profile.',
    'Never "we". Never a brand voice. You build these systems for a living and you are explaining what you see.',
    '',
    '## Positioning', section(['offer']),
    '', '## Voice - match this exactly', section(['brand_voice', 'voice']),
    '', '## Hard rules - these override every other instruction', section(['rule']),
    '', '## Who you are writing to', section(['icp'], a.target_vertical),
    '', '## Objections in the room', section(['objection']),
    '',
    '## Output format - follow this EXACTLY',
    'Emit only these labelled blocks. No JSON, no markdown fence, no preamble, no commentary.',
    'Every tag sits alone at the start of its line. Write prose normally - do not escape anything.',
    '',
    shape.blocks,
  ].join('\\n');

  const user = [
    'THESIS - this is what the piece must land. Do not drift off it:',
    a.thesis,
    '',
    a.why_now ? 'WHY TODAY: ' + a.why_now : 'This one is evergreen.',
    a.source_title ? 'ANCHORED TO: ' + a.source_title : '',
    '',
    'Audience: ' + a.target_vertical,
    'Bottleneck (exactly this one): ' + a.bottleneck,
    'Opening direction: ' + (a.hook || '(choose your own)'),
    '',
    'Walk these beats, in order:',
    (a.beats || []).map((b, i) => (i + 1) + '. ' + b).join('\\n'),
    '',
    shape.how,
    '',
    'Do not invent statistics, client results or testimonials. If a number would help and',
    'you do not have a real one, describe the mechanism instead.',
  ].filter(Boolean).join('\\n');

  return { json: {
    ...a,
    requestBody: JSON.stringify({
      model: __trio[0],\n  models: __trio,
      temperature: 0.85,
      max_tokens: 4000,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  } };
});`;

const validateDrafts = `// Pair each response back to the angle that produced it and build the row.
//
// Paired BY INDEX: n8n preserves item order through an HTTP node, and the angle
// carries draft_index so a mismatch would be visible rather than silent.

// Parse the delimited-block format. Deliberately forgiving about everything
// except structure - a model that writes [Slide] or adds a stray blank line
// should not cost the draft, but a missing required block must.
function parseBlocks(text) {
  const out = { slides: [], scenes: [], options: [] };
  const lines = String(text).replace(/\\r/g, '').split('\\n');
  let open = null;
  let buf = [];
  let last = null;   // the inline tag an untagged line should continue

  const closeBlock = () => {
    if (open) out[open] = buf.join('\\n').trim();
    open = null; buf = [];
  };

  for (const line of lines) {
    const t = line.trim();

    const opening = t.match(/^\\[(POST|BODY|CAPTION)\\]$/i);
    if (opening) { closeBlock(); open = opening[1].toLowerCase(); last = null; continue; }

    const closing = t.match(/^\\[\\/(POST|BODY|CAPTION)\\]$/i);
    if (closing) { closeBlock(); continue; }

    if (open) { buf.push(line); continue; }

    const inline = t.match(/^\\[(TITLE|QUESTION|SLIDE|SCENE|OPTION)\\]\\s*(.*)$/i);
    if (inline) {
      const tag = inline[1].toUpperCase();
      const val = inline[2].trim();
      if (tag === 'SLIDE') { out.slides.push(val); last = ['slides', out.slides.length - 1]; }
      else if (tag === 'SCENE') { out.scenes.push(val); last = ['scenes', out.scenes.length - 1]; }
      else if (tag === 'OPTION') { out.options.push(val.replace(/^[-*\\d.)\\s]+/, '').trim()); last = null; }
      else { out[tag.toLowerCase()] = val; last = [tag.toLowerCase(), null]; }
      continue;
    }

    // An untagged line continues the tag above it. Without this a slide whose
    // text runs onto a second line keeps only its first line - which showed up
    // in testing as a final slide reading exactly 'The Takeaway:' and nothing
    // else, because the model put the payoff on the next line.
    if (last && t) {
      const [k, i] = last;
      if (i === null) out[k] = (out[k] ? out[k] + ' ' : '') + t;
      else out[k][i] = (out[k][i] ? out[k][i] + ' ' : '') + t;
    }
  }
  closeBlock();
  return out;
}

const angles = $('Build the item prompts').all().map((i) => i.json);
const rows = [];
const failures = [];

$input.all().forEach((item, idx) => {
  const a = angles[idx];
  if (!a) return;

  try {
    const raw = item.json?.choices?.[0]?.message?.content;
    if (!raw) {
      const e = item.json?.error;
      throw new Error(e ? ('provider error: ' + (e.message || JSON.stringify(e)).slice(0, 160))
                        : 'model returned no content');
    }

    const out = parseBlocks(raw);
    const need = (f, label) => {
      const v = out[f];
      if (!v || !String(v).trim()) throw new Error('missing [' + (label || f.toUpperCase()) + '] block');
      return String(v).trim();
    };

    const row = {
      content_type: a.content_type,
      target_vertical: a.target_vertical,
      bottleneck: a.bottleneck,
      status: 'queued',
      audience: a.target_vertical,
      angle: a.bottleneck,
      thesis: a.thesis,
      why_now: a.why_now || null,
      source_title: a.source_title || null,
      source_url: a.source_url || null,
      draft_group: a.draft_group,
      image_prompt: a.scene || null,
    };

    const t = a.content_type;
    if (t === 'post') {
      row.post_text = need('post');
    } else if (t === 'carousel') {
      row.title = need('title');
      if (out.slides.length < 5 || out.slides.length > 8) {
        throw new Error('carousel needs 5-8 [SLIDE] lines, got ' + out.slides.length);
      }
      // Scenes are optional and matched by position; a slide without one simply
      // goes unillustrated rather than shifting every later slide's artwork.
      row.slides = out.slides.map((text, i) => (out.scenes[i]
        ? { text, scene: out.scenes[i] }
        : { text }));
      row.post_text = out.caption || null;
    } else if (t === 'poll') {
      row.poll_question = need('question');
      if (out.options.length < 2 || out.options.length > 4) {
        throw new Error('poll needs 2-4 [OPTION] lines, got ' + out.options.length);
      }
      row.poll_options = out.options;
      row.post_text = out.post || null;
    } else if (t === 'article' || t === 'newsletter') {
      row.title = need('title');
      row.body = need('body');
    } else if (t === 'featured') {
      row.title = need('title');
      row.body = out.body || null;
    }

    rows.push({ json: { row, thesis: a.thesis } });
  } catch (err) {
    // One bad draft must not cost the other two. At three a day, losing the
    // whole morning because one model fumbled its output is the wrong trade.
    failures.push('draft ' + (a.draft_index || idx + 1) + ' (' + a.content_type + '): ' + err.message);
    console.log('[m1] dropped ' + a.content_type + ': ' + err.message);
  }
});

if (!rows.length) throw new Error('every draft failed: ' + failures.join(' | '));
if (failures.length) console.log('[m1] ' + rows.length + ' of ' + $input.all().length + ' drafts survived');
return rows;`;

// ---------------------------------------------------------------------------
// 4. Remember what was argued, so tomorrow does not repeat it
// ---------------------------------------------------------------------------
const buildMemory = `${modelPicker(2)}// Sydney's memory extraction, doing the same job: decide what from today is
// worth keeping forever, and be stingy about it.

const ctx = $('Studio context').first().json;
const existing = (ctx.memory || [])
  .map((m) => m.category + '/' + m.key + ': ' + m.value).join('\\n') || '(none yet)';

const today = $('Validate the drafts').all()
  .map((i) => '- ' + i.json.row.content_type + ' / ' + i.json.row.target_vertical
              + ': ' + i.json.thesis).join('\\n');

const requestBody = JSON.stringify({
  model: __trio[0],\n  models: __trio,
  temperature: 0.3,
  max_tokens: 900,
  messages: [
    { role: 'system', content: [
      'You maintain the long-term memory of a LinkedIn content studio.',
      'Its whole purpose is to stop the studio repeating itself as it produces three drafts a day forever.',
      'Be selective. Most days add one row or none. Never duplicate something already known.',
      'Return JSON only.',
    ].join(' ') },
    { role: 'user', content: [
      'Already remembered:', existing,
      '', 'Argued today:', today,
      '',
      'Return ONLY: {"memories":[{"category":"...","key":"...","value":"..."}]}',
      'category is one of: angle (an argument now spent), analogy (a comparison now used),',
      'opener (a hook pattern now used), fact (a durable claim cleared for reuse).',
      'key is short, stable and snake_case. value is one sentence.',
      'Empty array if today added nothing new.',
    ].join('\\n') },
  ],
});

return [{ json: { requestBody } }];`;

const parseMemories = `const resp = $input.first().json;
let text = (resp?.choices?.[0]?.message?.content || '').replace(/\\\`\\\`\\\`json|\\\`\\\`\\\`/g, '').trim();
let parsed = { memories: [] };
try {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s !== -1 && e > s) parsed = JSON.parse(text.slice(s, e + 1));
} catch (err) { /* a day that adds nothing to memory is a normal day */ }

const mems = (Array.isArray(parsed.memories) ? parsed.memories : [])
  .filter((m) => m && m.category && m.key && m.value)
  .slice(0, 6);

console.log('[m1] ' + mems.length + ' new memories');
// An empty result must not stall the branch, so emit a skip marker instead.
return mems.length ? mems.map((m) => ({ json: m })) : [{ json: { _skip: true } }];`;

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
const nodes = [
  sticky(
    '## M1 - LinkedIn Content Studio\n\n'
    + "**3 drafts every morning, 7 days a week.** You publish what you like from "
    + 'the Marketing tab and delete the rest. It never posts.\n\n'
    + '### Two stages, like the Sydney pipeline\n'
    + '1. **Angle engine** — reads the brand brain, the memory, the last 14 items '
    + 'and real headlines, then commits to three genuinely different theses.\n'
    + '2. **The writer** — takes ONE thesis and writes to it.\n\n'
    + 'Deciding what to argue and writing it well are different jobs. Asking one '
    + 'call to do both is what made v1 read generic.\n\n'
    + '### It remembers\n'
    + '`content_memory` keeps spent arguments, used analogies and used openers. '
    + 'The angle engine is shown them and told not to repeat.\n\n'
    + '### No artwork here\n'
    + 'Alexya is on the Mac; this runs on the droplet. Each draft carries a '
    + '`scene` brief instead. `illustrate-queue.py` draws **approved** items '
    + 'locally — at 3 drafts a day, illustrating everything would spend the '
    + 'balance on content that never ships.\n\n'
    + '### The brief lives in Supabase\n'
    + "Edit `brand_brain` rows with `channel = 'linkedin'`, not this workflow.",
    [-520, -260], { width: 470, height: 760, color: 4 },
  ),

  dailyAt('Daily 7am', 7, [-220, -120]),

  // ---- the Generate button in the Marketing tab -------------------------
  {
    parameters: {
      httpMethod: 'POST',
      path: 'sanaku-generate',
      responseMode: 'responseNode',
      options: {
        // The dashboard is on a different origin, so the browser preflights.
        allowedOrigins: 'https://sanaku-command-center.netlify.app',
      },
    },
    id: 'eb000000-0000-4000-8000-000000000001',
    name: 'Generate now',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [-220, 160],
    webhookId: 'eb100000-0000-4000-8000-000000000001',
  },

  // Authorisation with no shared secret.
  //
  // The obvious design - a token baked into the dashboard bundle - is a
  // password published on the internet. Instead the browser forwards the
  // caller's own Supabase session, and this asks PostgREST to read
  // sanaku_staff AS THAT USER. Its only policy is `sanaku_is_staff()`, so a
  // non-staff session gets an empty array and a logged-out one gets a 401.
  // RLS is the authorizer; there is nothing here to leak.
  {
    parameters: {
      method: 'GET',
      // n8n expression syntax, and the same {{ $env.SUPABASE_URL }} placeholder
      // the installer rewrites to a literal - the droplet's own env var points
      // at the TCR project, not Sanaku.
      url: '={{ $env.SUPABASE_URL }}/rest/v1/sanaku_staff?select=user_id&limit=1',
      sendHeaders: true,
      headerParameters: {
        parameters: [
          { name: 'apikey', value: `={{ $env.SUPABASE_ANON_KEY }}` },
          { name: 'Authorization', value: `={{ $json.headers.authorization }}` },
        ],
      },
      options: { timeout: 10000 },
    },
    id: 'eb200000-0000-4000-8000-000000000001',
    name: 'Verify the caller is staff',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [0, 160],
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
  },

    // Requires an actual row back. PostgREST returns [] for an authenticated
  // NON-staff caller, which n8n turns into one empty item - so checking merely
  // for "no error" would have waved them straight through.
gate('Staff?', '$json.user_id != null', [220, 160]),

  respond('Refuse', "{ error: 'not authorised' }", [440, 300]),
  respond('Accepted', "{ accepted: true, queued_for: 'generation' }", [440, 40]),

  code('What was asked for', normalizeRequest, [660, 0]),
  code('Build the news queries', buildQueries, [880, 0]),

  {
    parameters: {
      method: 'GET',
      url: '={{ $json.url }}',
      options: { timeout: 20000, response: { response: { responseFormat: 'text' } } },
    },
    id: 'ea000000-0000-4000-8000-000000000001',
    name: 'Fetch headlines',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [440, 0],
    // Google News rate-limits and occasionally 503s. A missing feed costs the
    // day its news hook, not the day's content.
    onError: 'continueRegularOutput',
    alwaysOutputData: true,
    retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
  },

  code('Read the signals', parseTriggers, [660, 0]),

  supaWrite(
    'Studio context',
    'POST',
    'rpc/content_studio_context',
    '={{ JSON.stringify({ _days: 14 }) }}',
    [880, 0],
    { prefer: 'return=representation' },
  ),

  code('Build the angle brief', buildAngles, [1100, 0]),
  openrouter('Angle engine', [1320, 0]),
  code('Decide the three angles', parseAngles, [1540, 0]),
  code('Build the item prompts', buildItems, [1760, 0]),
  openrouter('Write them', [1980, 0]),
  code('Validate the drafts', validateDrafts, [2200, 0]),

  supaWrite(
    'Queue the drafts',
    'POST',
    'content_queue',
    '={{ JSON.stringify($json.row) }}',
    [2420, 0],
    { prefer: 'return=minimal' },
  ),

  code('Build the memory prompt', buildMemory, [2640, 0]),
  openrouter('Memory engine', [2860, 0]),
  code('Parse the memories', parseMemories, [3080, 0]),

  supaWrite(
    'Save memory',
    'POST',
    'content_memory?on_conflict=category,key',
    '={{ JSON.stringify({ category: $json.category, key: $json.key, value: $json.value }) }}',
    [3300, 0],
    { prefer: 'resolution=merge-duplicates,return=minimal' },
  ),

  logError(
    'Log the failure',
    '$json.error?.message || "content studio run failed"',
    'JSON.stringify({ stage: "m1" })',
    [2420, 220],
  ),
];

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
// Strictly linear. The memory branch hangs off the insert so it only records
// what actually made it into the queue.
const connections = {
  // Two ways in, one pipeline. Both triggers land on a node that says what was
  // asked for, so nothing downstream needs to know which one fired.
  'Daily 7am': { main: [to('What was asked for')] },

  'Generate now': { main: [to('Verify the caller is staff')] },
  'Verify the caller is staff': { main: [to('Staff?')] },
  // Answer the browser before generating - a run takes 30-90s and holding the
  // connection open that long is a worse experience than polling the queue.
  'Staff?': { main: [to('Accepted'), to('Refuse')] },
  'Accepted': { main: [to('What was asked for')] },
  'What was asked for': { main: [to('Build the news queries')] },

  'Build the news queries': { main: [to('Fetch headlines')] },
  'Fetch headlines': { main: [to('Read the signals')] },
  'Read the signals': { main: [to('Studio context')] },
  'Studio context': { main: [to('Build the angle brief')] },
  'Build the angle brief': { main: [to('Angle engine')] },
  'Angle engine': { main: [to('Decide the three angles')] },
  'Decide the three angles': { main: [to('Build the item prompts')] },
  'Build the item prompts': { main: [to('Write them')] },
  'Write them': { main: [to('Validate the drafts')] },
  'Validate the drafts': { main: [to('Queue the drafts')] },
  'Queue the drafts': { main: [to('Build the memory prompt')] },
  'Build the memory prompt': { main: [to('Memory engine')] },
  'Memory engine': { main: [to('Parse the memories')] },
  'Parse the memories': { main: [to('Save memory')] },
};

const wf = workflow('Sanaku - M1 Content Studio', nodes, connections);
writeFileSync(process.argv[2], JSON.stringify(wf, null, 2) + '\n');
console.log('wrote', process.argv[2], nodes.length, 'nodes');
