// W2s - send the drafts Ismail has approved.
//
// The second half of the split. W2 drafts and stops at 'draft_review'; Ismail
// reads it in the Marketing... in the Pipeline tab, edits if he wants, and
// approves. Only then does this workflow see it.
//
// ---------------------------------------------------------------------------
// Three independent brakes, because one is not enough
// ---------------------------------------------------------------------------
// 1. THE GLOBAL SWITCH. $env.SANAKU_SEND_ENABLED must equal the exact string
//    'true'. Anything else - unset, 'TRUE', '1', 'yes' - and the run stops at
//    the first gate having sent nothing. Defaulting to off means a
//    misconfiguration fails safe, and a fat-fingered value does too.
//
// 2. THE DAILY RAMP. Every send claims a slot through sanaku_claim_send_slot(),
//    which increments and checks inside ONE statement. A read-then-write in
//    the workflow would let two concurrent executions both see 14 of 15 and
//    both send. Proven in testing: four simultaneous claims at 14/15 returned
//    exactly one true.
//
// 3. THE RECIPIENT GATE. Only status='approved' AND email_verified AND
//    decision_maker AND not do_not_contact. A prospect has to have been
//    approved as a prospect, then had its draft read and approved, and hold an
//    address Apollo confirmed, before a single byte leaves.
//
// Sending is from ismail@sanakuai.com over Zoho SMTP on 587/STARTTLS. Plain
// text only - a cold message from a new domain that arrives looking like a
// newsletter gets filtered like one.
import { writeFileSync } from 'node:fs';
import { code, gate, respond, supaGet, supaWrite, logError, sticky, to, workflow, RETRY } from './lib.mjs';

// Every 30 minutes rather than once a day: the ramp is a daily CAP, not a daily
// batch, and drip-feeding a handful of messages across working hours looks far
// more like a person than fifteen arriving in one burst at 09:00.
const schedule = (name, minutes, position) => ({
  parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: minutes }] } },
  id: 'ed100000-0000-4000-8000-000000000001', name,
  type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position,
});

const checkSwitch = `// The global brake, read from the DATABASE rather than the environment.
//
// It used to be $env.SANAKU_SEND_ENABLED, which only someone with shell access
// to the droplet could change, followed by an n8n restart. That put the one
// control that stops every outbound email furthest from the person responsible
// for it. It is a row now, so the dashboard owns it.
//
// sanaku_settings.value is numeric; sanaku_send_enabled() applies the "exactly
// 1" rule in SQL so no caller can get it subtly wrong.
const row = $input.first().json;
const enabled = row === true || row?.sanaku_send_enabled === true
  || (Array.isArray(row) && row[0] === true);

// Business hours in the recipient's timezone, not the server's. A cold email
// timestamped 03:40 reads as machinery no matter how well it is written.
const hour = Number(new Date().toLocaleString('en-US', {
  timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false,
}));
const day = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
const inHours = hour >= 8 && hour < 17 && !['Sat', 'Sun'].includes(day);

if (!enabled) console.log('[w2s] send_enabled is off in sanaku_settings - nothing will send');
else if (!inHours) console.log('[w2s] outside 08:00-17:00 PT Mon-Fri (' + day + ' ' + hour + ':00) - holding');

return [{ json: { proceed: enabled && inHours, enabled, inHours, hour, day } }];`;

const requestedProspect = `// The one prospect the button was clicked for.
const body = $('Send Now').first().json.body || {};
const id = String(body.prospect_id || '').trim();
if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('send-now called without a valid prospect_id');
return [{ json: { prospect_id: id } }];`;

const pickOne = `// One approved draft per run, oldest first.
//
// One, not a batch: each send has to claim its own slot, and a batch that
// claims fifteen slots and then fails on the third has already spent them.
const rows = $input.all().map((i) => i.json).filter((r) => r && r.id);
if (!rows.length) {
  console.log('[w2s] nothing approved is waiting');
  return [];
}
const p = rows[0];

// Belt and braces. The query already filters on all of these, but this is the
// last place before an email leaves, and the cost of being wrong here is a
// stranger receiving mail they never should have.
const problems = [];
if (!p.email_verified) problems.push('email not verified');
if (!p.decision_maker) problems.push('not a decision maker');
if (p.do_not_contact) problems.push('on the do-not-contact list');
if (!p.contact_email) problems.push('no address');
if (!p.draft_subject || !p.draft_body) problems.push('no approved draft on the record');
// A button click approves and sends in one action, so draft_review is
// acceptable on that path; the scheduled path only ever queries 'approved'.
if (!['approved', 'draft_review'].includes(p.status)) problems.push('status is ' + p.status);
if (problems.length) throw new Error('refusing to send to ' + p.company_name + ': ' + problems.join('; '));

console.log('[w2s] candidate: ' + p.company_name + ' step ' + (p.draft_step || 1));
return [{ json: p }];`;

const buildEmail = `// Assemble the message. The body is what Ismail approved, verbatim - this
// step adds only the footer, which is a legal requirement rather than copy.
const p = $('Pick One Approved').first().json;
const claimed = $input.first().json;

// The RPC returns a bare JSON boolean; PostgREST hands it back as the item
// body, which n8n presents differently depending on version.
const ok = claimed === true || claimed?.data === true
  || (Array.isArray(claimed) && claimed[0] === true)
  || claimed?.sanaku_claim_send_slot === true;
if (!ok) {
  console.log('[w2s] daily send cap reached - stopping');
  return [];
}

const FROM_NAME = 'Ismail Rogers-Wright';
const FROM = (typeof $env !== 'undefined' && $env.ZOHO_FROM) || 'ismail@sanakuai.com';

// CAN-SPAM: a real identity, a physical address, and a working opt-out on
// every message. The address comes from the same env var the outbound guard
// uses, so there is one place to change it.
const ADDRESS = (typeof $env !== 'undefined' && $env.SANAKU_MAILING_ADDRESS)
  || 'Sanaku, Los Angeles County, CA';

const footer = [
  '',
  '--',
  FROM_NAME,
  'Sanaku · ' + FROM,
  ADDRESS,
  '',
  'Reply STOP or say the word and I will not write again.',
].join('\\n');

return [{ json: {
  id: p.id,
  to: p.contact_email,
  from: FROM,
  fromName: FROM_NAME,
  subject: p.draft_subject,
  text: String(p.draft_body).trim() + '\\n' + footer,
  step: p.draft_step || 1,
  company_name: p.company_name,
} }];`;

const afterSend = `// Record what went out, and clear the draft so the record cannot be
// re-approved and re-sent by accident.
const e = $('Build The Email').first().json;
return [{ json: {
  id: e.id,
  conversation: {
    prospect_id: e.id,
    direction: 'outbound',
    channel: 'email',
    subject: e.subject,
    body: e.text,
    sequence_step: e.step,
    sent_at: new Date().toISOString(),
  },
  prospect: {
    status: 'contacted',
    last_contacted: new Date().toISOString(),
    last_activity_at: new Date().toISOString(),
    draft_subject: null,
    draft_body: null,
    draft_step: null,
    draft_angle: null,
    draft_generated_at: null,
  },
} }];`;

const nodes = [
  sticky(
    '## W2s — send approved drafts\n\n'
    + '**Nothing sends unless `send_enabled` = 1 in `sanaku_settings`.**\n'
    + 'Toggle it from the Outreach tab — it is a row, not an env var, so it can be\n'
    + 'turned off without shell access the moment something looks wrong.\n\n'
    + '### Three brakes\n'
    + '1. the global switch\n'
    + '2. the daily ramp — `sanaku_claim_send_slot()` claims atomically, so two runs cannot both take the last slot\n'
    + '3. the recipient gate — approved **and** verified **and** a decision maker\n\n'
    + '### Turning it off in a hurry\n'
    + 'Outreach tab → the sending toggle. Takes effect on the next run, ≤30 min.\n'
    + 'Raise the ramp by editing `cap` in `sanaku_send_budget` for today —\n'
    + 'start at 15/day and climb over weeks, never in one jump.\n\n'
    + 'One message per run, every 30 min, 08:00–17:00 PT weekdays only.',
    [-460, -120], { width: 440, height: 520, color: 3 },
  ),

  schedule('Every 30 min', 30, [-220, -140]),

  supaWrite(
    'Read Send Switch', 'POST', 'rpc/sanaku_send_enabled',
    '={{ JSON.stringify({}) }}', [0, -140], { prefer: 'return=representation' },
  ),

  code('Send Enabled?', checkSwitch, [220, -140]),
  gate('Proceed?', '$json.proceed', [440, -140]),

  // ---- Approve & Send, clicked in the dashboard --------------------------
  // A human pressing the button IS the authorisation, so this path does not
  // consult SANAKU_SEND_ENABLED - that switch guards the UNATTENDED schedule.
  // Every other brake still applies: staff auth, the verified/decision-maker
  // gate, and the daily ramp.
  {
    parameters: {
      httpMethod: 'POST', path: 'sanaku-send-now', responseMode: 'responseNode',
      options: { allowedOrigins: 'https://sanaku-command-center.netlify.app' },
    },
    id: 'ed300000-0000-4000-8000-000000000001', name: 'Send Now',
    type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 160],
    webhookId: 'ed310000-0000-4000-8000-000000000001',
  },
  {
    parameters: {
      method: 'GET',
      url: '={{ $env.SUPABASE_URL }}/rest/v1/sanaku_staff?select=user_id&limit=1',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'apikey', value: '={{ $env.SUPABASE_ANON_KEY }}' },
        { name: 'Authorization', value: '={{ $json.headers.authorization }}' },
      ] },
      options: { timeout: 10000 },
    },
    id: 'ed400000-0000-4000-8000-000000000001', name: 'Verify Staff',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [220, 160],
    onError: 'continueRegularOutput', alwaysOutputData: true,
  },
  gate('Staff?', '$json.user_id != null', [440, 160]),
  respond('Refuse Send', "{ error: 'not authorised' }", [660, 300]),
  respond('Send Accepted', "{ accepted: true }", [660, 160]),
  code('Requested Prospect', requestedProspect, [880, 160]),

  supaGet(
    'Get Approved Drafts',
    'sanaku_prospects'
    + '?status=eq.approved'
    + '&email_verified=is.true'
    + '&decision_maker=is.true'
    + '&do_not_contact=is.false'
    + '&contact_email=not.is.null'
    + '&draft_body=not.is.null'
    + '&select=id,company_name,contact_name,contact_email,vertical,status,email_verified,decision_maker,do_not_contact,draft_subject,draft_body,draft_step'
    + '&order=draft_generated_at.asc&limit=1',
    [660, 0],
  ),

  supaGet(
    'Get That Draft',
    'sanaku_prospects'
    + '?id=eq.{{ $json.prospect_id }}'
    + '&email_verified=is.true&decision_maker=is.true&do_not_contact=is.false'
    + '&contact_email=not.is.null&draft_body=not.is.null'
    + '&status=in.(approved,draft_review)'
    + '&select=id,company_name,contact_name,contact_email,vertical,status,email_verified,decision_maker,do_not_contact,draft_subject,draft_body,draft_step',
    [1100, 160],
  ),

  code('Pick One Approved', pickOne, [880, -140]),

  // Claiming the slot BEFORE composing, so a run that dies mid-send has still
  // consumed its allowance rather than silently retrying past the cap.
  supaWrite(
    'Claim A Send Slot', 'POST', 'rpc/sanaku_claim_send_slot',
    '={{ JSON.stringify({}) }}', [1100, 0], { prefer: 'return=representation' },
  ),

  code('Build The Email', buildEmail, [1320, 0]),

  {
    parameters: {
      fromEmail: '={{ $json.fromName }} <{{ $json.from }}>',
      toEmail: '={{ $json.to }}',
      subject: '={{ $json.subject }}',
      emailFormat: 'text',
      text: '={{ $json.text }}',
      options: {},
    },
    id: 'ed200000-0000-4000-8000-000000000001',
    name: 'Send via Zoho',
    type: 'n8n-nodes-base.emailSend',
    typeVersion: 2.1,
    position: [1540, 0],
    credentials: { smtp: { id: 'PLACEHOLDER_SMTP', name: 'Zoho SMTP (sanakuai.com)' } },
    onError: 'continueErrorOutput',
  },

  code('Record The Send', afterSend, [1760, -80]),

  supaWrite('Log Conversation', 'POST', 'sanaku_conversations',
    '={{ JSON.stringify($json.conversation) }}', [1980, -80], { prefer: 'return=minimal' }),

  supaWrite('Mark Contacted', 'PATCH',
    'sanaku_prospects?id=eq.{{ $json.id }}',
    '={{ JSON.stringify($json.prospect) }}', [2200, -80], { prefer: 'return=minimal' }),

  logError('Log Send Failure',
    '$json.error?.message || "zoho send failed"',
    'JSON.stringify({ prospect_id: $("Build The Email").first().json.id, to: $("Build The Email").first().json.to })',
    [1760, 140]),
];

const connections = {
  'Every 30 min': { main: [to('Read Send Switch')] },
  'Read Send Switch': { main: [to('Send Enabled?')] },
  'Send Enabled?': { main: [to('Proceed?')] },
  'Proceed?': { main: [to('Get Approved Drafts')] },
  'Get Approved Drafts': { main: [to('Pick One Approved')] },
  'Pick One Approved': { main: [to('Claim A Send Slot')] },

  'Send Now': { main: [to('Verify Staff')] },
  'Verify Staff': { main: [to('Staff?')] },
  'Staff?': { main: [to('Send Accepted'), to('Refuse Send')] },
  'Send Accepted': { main: [to('Requested Prospect')] },
  'Requested Prospect': { main: [to('Get That Draft')] },
  'Get That Draft': { main: [to('Pick One Approved')] },
  'Claim A Send Slot': { main: [to('Build The Email')] },
  'Build The Email': { main: [to('Send via Zoho')] },
  'Send via Zoho': { main: [to('Record The Send'), to('Log Send Failure')] },
  'Record The Send': { main: [to('Log Conversation')] },
  'Log Conversation': { main: [to('Mark Contacted')] },
};

const wf = workflow('Sanaku - W2s Send Approved (gate 2)', nodes, connections);
writeFileSync(process.argv[2], JSON.stringify(wf, null, 2) + '\n');
console.log('wrote', process.argv[2], nodes.length, 'nodes');
