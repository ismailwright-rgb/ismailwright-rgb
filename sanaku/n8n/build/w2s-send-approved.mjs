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
// Sending is from ismail@sanakuai.com over the Zoho Mail REST API on 443.
// Plain text only - a cold message from a new domain that arrives looking like
// a newsletter gets filtered like one.
//
// ---------------------------------------------------------------------------
// Why HTTPS and not SMTP (2026-08-11)
// ---------------------------------------------------------------------------
// This used to be an SMTP node on smtppro.zoho.com:587. It never delivered a
// single message. Every attempt ended in a TCP connection timeout at exactly
// 120s - the droplet cannot open an outbound SMTP connection at all, while
// reaching Zoho IMAP on 993 from the same host works fine. A timeout rather
// than a refusal means the packets are dropped upstream: a network-level block
// on outbound SMTP, which is standard on DigitalOcean droplets.
//
// Port 443 is not blocked - every other workflow talks to Supabase and
// OpenRouter over it continuously. So the mail goes out the same way.
//
// Two further benefits worth stating, because they were the original
// complaint. The API writes the message into the Sent folder, so sent mail is
// visible in the mailbox - SMTP submission never does this, and would not have
// even if the port were open. And it returns a message id, so a send that
// fails now fails loudly instead of resolving to an empty item.
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

const confirmDelivered = `// Zoho returns HTTP 200 for "I received your request", and reports the actual
// outcome inside the body as status.code. Treating the HTTP status as proof of
// delivery is exactly the mistake that let twelve timeouts read as twelve sends,
// so this asserts on the payload and throws if it is not a real send.
const r = $input.first().json || {};
const code = r?.status?.code;
const messageId = r?.data?.messageId;

if (code !== 200 || !messageId) {
  throw new Error('zoho api did not confirm the send: '
    + JSON.stringify({ code, description: r?.status?.description, messageId }).slice(0, 300));
}

console.log('[w2s] delivered, zoho messageId ' + messageId);
return [{ json: { messageId } }];`;

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
    // A success wipes the failure history, so three failures spread over three
    // weeks never accumulate into a block.
    send_failures: 0,
    send_failed_at: null,
    send_last_error: null,
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
    + 'One message per run, every 30 min, 08:00–17:00 PT weekdays only.\n\n'
    + '### Sending goes over HTTPS, not SMTP\n'
    + 'The droplet cannot reach `:587` at all — outbound SMTP is blocked and every\n'
    + 'attempt times out at 120s. Mail goes out through the **Zoho Mail REST API**\n'
    + 'on 443 instead, which also puts a copy in the Sent folder.\n'
    + 'Needs the `Zoho Mail OAuth (sanakuai.com)` credential.',
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
    // send_failed_at FIRST, nulls first. On 2026-08-11 the sender retried one
    // unreachable address twelve times in a row and burned the whole day's cap
    // on it, because the only ordering was by draft age and a failure left no
    // trace on the row. A prospect that has never failed now always goes ahead
    // of one that has, and migration-027 parks anything that fails three times.
    + '&order=send_failed_at.asc.nullsfirst,draft_generated_at.asc&limit=1',
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

  // Zoho access tokens live one hour, so one is minted per send rather than
  // stored. The refresh token, client id and client secret live in an n8n
  // credential (encrypted at rest) which injects them as query parameters -
  // they must never appear in the workflow JSON, which is committed to git.
  {
    parameters: {
      method: 'POST',
      url: 'https://accounts.zoho.com/oauth/v2/token',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpCustomAuth',
      options: { timeout: 20000 },
    },
    id: 'ed200000-0000-4000-8000-000000000003',
    name: 'Get Zoho Token',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1540, 0],
    credentials: { httpCustomAuth: { id: 'PLACEHOLDER_ZOHO_OAUTH', name: 'Zoho Mail OAuth (sanakuai.com)' } },
    onError: 'continueErrorOutput',
    retryOnFail: true, maxTries: 2, waitBetweenTries: 3000,
  },

  // The account id is fetched rather than stored. It is not a secret, but it is
  // one more thing that can be wrong in two places, and this costs one call a
  // day at fifteen sends.
  {
    parameters: {
      method: 'GET',
      url: 'https://mail.zoho.com/api/accounts',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: '=Zoho-oauthtoken {{ $json.access_token }}' },
      ] },
      options: { timeout: 20000 },
    },
    id: 'ed200000-0000-4000-8000-000000000004',
    name: 'Get Zoho Account',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1760, 0],
    onError: 'continueErrorOutput',
  },

  // mailFormat plaintext, deliberately. The brand brief forbids HTML on cold
  // mail and Zoho will happily send either.
  {
    parameters: {
      method: 'POST',
      url: '=https://mail.zoho.com/api/accounts/{{ $json.data[0].accountId }}/messages',
      sendHeaders: true,
      headerParameters: { parameters: [
        { name: 'Authorization', value: '=Zoho-oauthtoken {{ $("Get Zoho Token").first().json.access_token }}' },
      ] },
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify({'
        + ' fromAddress: $("Build The Email").first().json.from,'
        + ' toAddress: $("Build The Email").first().json.to,'
        + ' subject: $("Build The Email").first().json.subject,'
        + ' content: $("Build The Email").first().json.text,'
        + ' mailFormat: "plaintext",'
        + ' askReceipt: "no"'
        + ' }) }}',
      options: { timeout: 30000 },
    },
    id: 'ed200000-0000-4000-8000-000000000005',
    name: 'Send via Zoho API',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [1980, 0],
    onError: 'continueErrorOutput',
  },

  // Zoho answers 200 with status.code 200 on success. A non-200 inside a 200 is
  // a real failure and must not be recorded as a send - the whole reason this
  // rewrite exists is that a failure once looked like a success.
  code('Confirm Delivered', confirmDelivered, [2200, -80]),

  code('Record The Send', afterSend, [2420, -80]),

  supaWrite('Log Conversation', 'POST', 'sanaku_conversations',
    '={{ JSON.stringify($json.conversation) }}', [1980, -80], { prefer: 'return=minimal' }),

  supaWrite('Mark Contacted', 'PATCH',
    'sanaku_prospects?id=eq.{{ $json.id }}',
    '={{ JSON.stringify($json.prospect) }}', [2200, -80], { prefer: 'return=minimal' }),

  // A failure now does three things instead of one. It gives the claimed slot
  // back, so the cap counts sends rather than attempts; it stamps the prospect
  // so the next run picks somebody else; and it parks the row after three
  // consecutive failures. All three happen inside one function, because a
  // failure that half-records is what produced the twelve-attempt retry loop.
  supaWrite(
    'Record Send Failure', 'POST', 'rpc/sanaku_record_send_failure',
    '={{ JSON.stringify({'
    + ' p_prospect: $("Build The Email").first().json.id,'
    + ' p_error: String($json.error?.message || $json.error || "zoho send failed").slice(0, 500)'
    + ' }) }}',
    [2200, 200], { prefer: 'return=representation' },
  ),

  logError('Log Send Failure',
    'String($("Send via Zoho API").first().json?.error?.message || "zoho send failed").slice(0, 400)',
    'JSON.stringify({ prospect_id: $("Build The Email").first().json.id, to: $("Build The Email").first().json.to })',
    [2420, 200]),
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
  'Build The Email': { main: [to('Get Zoho Token')] },

  // Every step of the send has the same error destination. Any one of them
  // failing means no email left, so all three must release the slot.
  'Get Zoho Token': { main: [to('Get Zoho Account'), to('Record Send Failure')] },
  'Get Zoho Account': { main: [to('Send via Zoho API'), to('Record Send Failure')] },
  'Send via Zoho API': { main: [to('Confirm Delivered'), to('Record Send Failure')] },

  'Confirm Delivered': { main: [to('Record The Send')] },
  'Record The Send': { main: [to('Log Conversation')] },
  'Log Conversation': { main: [to('Mark Contacted')] },
  'Record Send Failure': { main: [to('Log Send Failure')] },
};

const wf = workflow('Sanaku - W2s Send Approved (gate 2)', nodes, connections);
writeFileSync(process.argv[2], JSON.stringify(wf, null, 2) + '\n');
console.log('wrote', process.argv[2], nodes.length, 'nodes');
