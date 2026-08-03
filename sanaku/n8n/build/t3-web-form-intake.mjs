// T3 - Web Form Intake.  Catalog: after_hours_intake_home / _law / _medical.
//
// A form on the client's site posts here. We capture the lead, grade it against
// the client's own definition of qualified, text the person back in the client's
// name, and alert the owner. The lead carries consent_source='web_form', which
// is what later lets T4 legally ring them.
import { writeFileSync } from 'node:fs';
import {
  guardSource, sticky, webhook, code, gate, supaGet, supaWrite, hasAddon,
  twilioSms, respond, logError, to, workflow, OPENROUTER_CRED, RETRY,
} from './lib.mjs';

const normalize = `// Read whatever the client's form plugin posted into a known shape.
// Form builders disagree on field names, so accept the common ones rather than
// making every client rename their fields.
const b = ($input.first().json || {}).body || {};
const pick = (...keys) => {
  for (const k of keys) {
    const v = b[k] ?? b[k.toLowerCase()] ?? b[k.toUpperCase()];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return null;
};

const e164 = (v) => {
  const d = String(v || '').replace(/[^\\d+]/g, '');
  if (/^\\+\\d{10,15}$/.test(d)) return d;
  if (/^1\\d{10}$/.test(d)) return '+' + d;
  if (/^\\d{10}$/.test(d)) return '+1' + d;
  return null;
};

// Which client's form is this? The site embeds their tracked number, same key
// every other T workflow uses, so onboarding sets one field and not two.
const forNumber = e164(pick('business_number', 'to', 'client_number', 'inbound_number'));
const phone = e164(pick('phone', 'tel', 'telephone', 'mobile', 'phone_number', 'your-phone'));
const email = pick('email', 'e-mail', 'email_address', 'your-email');
const name = pick('name', 'full_name', 'fullname', 'your-name', 'first_name');
const message = pick('message', 'comments', 'details', 'description', 'how_can_we_help', 'your-message');

if (!forNumber) {
  return [{ json: { invalid: true, error: 'the form did not say which business it belongs to' } }];
}
if (!phone && !email) {
  return [{ json: { invalid: true, error: 'no phone and no email - nothing to follow up with' } }];
}

return [{ json: {
  invalid: false, for_number: forNumber, phone, email, name,
  message: message || '(no message)',
} }];`;

const guardCall = `${guardSource()}

// Everything the send decision needs, gathered in one place so the execution log
// shows exactly why a message did or did not go out.
const client = $('Find Client').first().json;
const form = $('Normalize Submission').first().json;

// PostgREST returns a bare JSON scalar for an rpc that returns boolean, and n8n
// wraps a non-object body differently depending on version. Read every shape it
// can arrive in, and treat anything unrecognised as NO.
//
// Failing closed matters here: this is what stops a workflow running for a
// client who cancelled. An unreadable answer must never read as "yes".
function readBool(items) {
  const j = (items && items[0] && items[0].json);
  if (j === true || j === 'true') return true;
  if (j && typeof j === 'object') {
    for (const k of ['sanaku_has_addon', 'data', 'result', 'value']) {
      if (j[k] === true || j[k] === 'true') return true;
    }
  }
  return false;
}

// Both lookups run with alwaysOutputData, so an empty result is still one item.
const hasAddonResult = readBool($('Has The Add-On?').all());
const suppressed = ($('Check Suppression').all() || []).some((i) => i.json && i.json.id);

// A form submission IS the consent - they typed their number into the client's
// own website asking to be contacted about this job.
const g = outboundGuard({
  client,
  hasAddon: hasAddonResult,
  suppressed,
  consentSource: 'web_form',
  channel: 'sms',
});

const brand = client.brand_name || client.company_name;

return [{ json: {
  client_id: client.id,
  brand,
  from_number: client.sending_number || client.inbound_number,
  to_number: form.phone,
  name: form.name,
  email: form.email,
  message: form.message,
  after_hours: g.afterHours,
  may_send: g.maySend && !!form.phone,
  block_reason: g.reason,
  local_time: g.localTime,
  escalation_phone: client.escalation_phone,
  reply: 'Thanks for getting in touch with ' + brand + " - we've got your message and will come back to you"
       + (g.afterHours ? ' first thing.' : ' shortly.')
       + '\\n\\nReply STOP to opt out.',
} }];`;

const readGrade = `// Read the grader's JSON, and fail toward capturing the lead.
// A model that returns prose must not cost the client a customer, so an
// unreadable answer means "keep it, unqualified" rather than "drop it".
let out = { qualified: false, score: 0, urgent: false, summary: '' };
try {
  const raw = $input.first().json.choices[0].message.content;
  const m = String(raw).match(/\\{[\\s\\S]*\\}/);
  // No braces at all is the common failure - the model answered in prose and
  // threw nothing. That has to land in the same place as a parse error, or the
  // owner gets an alert with a blank summary and no clue why.
  if (!m) throw new Error('no JSON in the reply');
  out = { ...out, ...JSON.parse(m[0]) };
} catch (e) {
  out.summary = 'could not grade automatically - read the message yourself';
}
const g = $('Guard').first().json;
return [{ json: { ...g, ...out } }];`;

const ownerAlert = `const g = $('Grade Submission').first().json;
const row = $input.first().json;

const lines = [];
lines.push((g.urgent ? 'URGENT web enquiry' : 'New web enquiry') + (g.after_hours ? ' (after hours)' : ''));
if (g.name) lines.push('Who: ' + g.name);
if (g.to_number) lines.push('Call back: ' + g.to_number);
if (g.email) lines.push('Email: ' + g.email);
lines.push('', String(g.message).slice(0, 300));
if (!g.may_send) lines.push('', 'We did NOT text them: ' + g.block_reason);

return [{ json: {
  send: !!g.escalation_phone && (g.qualified || g.urgent || !g.after_hours),
  to: g.escalation_phone,
  from: g.from_number,
  body: lines.join('\\n'),
  lead_id: (row && row.id) || null,
} }];`;

const STICKY = `## T3 - Web Form Intake

Catalog: \`after_hours_intake_home\` / \`_law\` / \`_medical\`.

The client's website form posts here. We capture the lead, grade it against
their own \`qualified_definition\`, text the person back in their name, and
alert the owner.

**Checked in order, and every refusal is logged with a reason:**
1. Does the form say which business it is? (\`business_number\` = their
   \`inbound_number\` - the same key T1 and T2 use.)
2. \`sanaku_has_addon\` - bought and still active. A cancelled add-on stops the
   software the same day it stops the invoice.
3. \`workflow_enabled\` + \`status\` - the kill switch.
4. Opted out? Permanent, per client.
5. Inside 8am-9pm in the client's timezone.

**We capture the lead even when we may not reply.** The enquiry is theirs and
the alert still goes out; only the automated text waits.

**consent_source = 'web_form'.** They typed their number into the client's own
site asking to be contacted. This is what makes T4's callback lawful - without a
row like this, T4 refuses to dial.

The reply always carries STOP instructions.

**Form fields** (POST /webhook/t3-form) - common aliases are accepted:
\`\`\`
{ "business_number": "+17145551234",   // required: whose form this is
  "name": "...", "phone": "...", "email": "...", "message": "..." }
\`\`\`

Credentials: Supabase Service Role (Custom Auth), Twilio account,
OpenRouter (Header Auth).  Env: SUPABASE_URL, OPENROUTER_MODEL.`;

const nodes = [
  sticky(STICKY, [-560, 380], { height: 860 }),
  webhook('Form Webhook', 't3-form', [140, 720]),
  code('Normalize Submission', normalize, [360, 720]),
  gate('Readable?', '$json.invalid !== true', [580, 720]),

  supaGet('Find Client',
    'sanaku_clients?inbound_number=eq.{{ encodeURIComponent($json.for_number) }}&select=*&limit=1',
    [800, 640]),
  gate('Client Found?', '!!$json.id', [1020, 640]),

  hasAddon('Has The Add-On?', '$json.id',
    // One code per vertical, same software. The client's own vertical decides
    // which row we ask about, so a law firm is not checked against the
    // home-services product they were never sold.
    "'after_hours_intake_' + ($json.vertical === 'law_firm' ? 'law' : $json.vertical === 'medical' ? 'medical' : 'home')",
    [1240, 640]),

  supaGet('Check Suppression',
    "sanaku_client_suppression?client_id=eq.{{ $('Find Client').first().json.id }}&phone=eq.{{ encodeURIComponent($('Normalize Submission').first().json.phone || 'none') }}&select=id&limit=1",
    [1460, 640]),

  code('Guard', guardCall, [1680, 640]),

  {
    parameters: {
      method: 'POST', url: 'https://openrouter.ai/api/v1/chat/completions',
      authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
      sendBody: true, specifyBody: 'json',
      jsonBody: "={{ JSON.stringify({ model: $env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free', messages: [ { role: 'system', content: 'You grade web enquiries to a local service business. The business defines a QUALIFIED lead as: ' + ($('Find Client').first().json.qualified_definition || 'someone with a real need for the service who left a way to reach them, not spam, not a vendor, not a wrong number') + '. Reply with STRICT JSON only: {\"qualified\": true|false, \"score\": 0-100, \"urgent\": true|false, \"summary\": \"under 15 words\"}. urgent = they need help today (leak, outage, pain, emergency).' }, { role: 'user', content: $('Normalize Submission').first().json.message } ], max_tokens: 120, temperature: 0 }) }}",
      options: { timeout: 45000 },
    },
    id: 'e8000000-0000-4000-8000-000000000001', name: 'Grade With Their Definition',
    type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [1900, 640],
    credentials: OPENROUTER_CRED, ...RETRY, onError: 'continueRegularOutput',
  },
  code('Grade Submission', readGrade, [2120, 640]),

  supaWrite('Log Lead (billing meter)', 'POST', 'sanaku_client_leads',
    "={{ JSON.stringify({ client_id: $json.client_id, name: $json.name, phone: $json.to_number, email: $json.email, channel: 'web_form', after_hours: $json.after_hours, qualified: $json.qualified === true, lead_score: $json.score || 0, billable: true, consent_source: 'web_form', consent_at: new Date().toISOString(), last_message_at: new Date().toISOString(), conversation: [{ dir: 'in', at: new Date().toISOString(), body: $json.message }] }) }}",
    [2340, 640], { onError: 'continueErrorOutput' }),
  logError('Log Write Failure',
    "'web form lead write failed: ' + String(($json.error && $json.error.message) || 'unknown').slice(0, 800)",
    "{ client_id: $('Guard').first().json.client_id, phone: $('Guard').first().json.to_number }",
    [2560, 860]),

  gate('May We Text Them?', "$('Guard').first().json.may_send === true", [2560, 560]),
  twilioSms('Text Them Back',
    "={{ $('Guard').first().json.from_number }}",
    "={{ $('Guard').first().json.to_number }}",
    "={{ $('Guard').first().json.reply }}",
    [2780, 460]),

  code('Build Owner Alert', ownerAlert, [3000, 560]),
  gate('Alert Configured?', '$json.send === true', [3220, 560]),
  twilioSms('Alert The Owner', '={{ $json.from }}', '={{ $json.to }}', '={{ $json.body }}', [3440, 480]),

  respond('Respond OK', '{ ok: true }', [3660, 560]),
  respond('Respond Skipped',
    "{ ok: false, reason: 'unreadable form, unknown business, add-on inactive, or client paused' }",
    [3660, 940]),
];

const connections = {
  'Form Webhook': { main: [to('Normalize Submission')] },
  'Normalize Submission': { main: [to('Readable?')] },
  'Readable?': { main: [to('Find Client'), to('Respond Skipped')] },
  'Find Client': { main: [to('Client Found?')] },
  'Client Found?': { main: [to('Has The Add-On?'), to('Respond Skipped')] },
  'Has The Add-On?': { main: [to('Check Suppression')] },
  'Check Suppression': { main: [to('Guard')] },
  'Guard': { main: [to('Grade With Their Definition')] },
  'Grade With Their Definition': { main: [to('Grade Submission')] },
  'Grade Submission': { main: [to('Log Lead (billing meter)')] },
  'Log Lead (billing meter)': { main: [to('May We Text Them?'), to('Log Write Failure')] },
  'Log Write Failure': { main: [to('Respond Skipped')] },
  'May We Text Them?': { main: [to('Text Them Back'), to('Build Owner Alert')] },
  'Text Them Back': { main: [to('Build Owner Alert')] },
  'Build Owner Alert': { main: [to('Alert Configured?')] },
  'Alert Configured?': { main: [to('Alert The Owner'), to('Respond OK')] },
  'Alert The Owner': { main: [to('Respond OK')] },
};

const wf = workflow('Sanaku - T3 Web Form Intake', nodes, connections);
writeFileSync(process.argv[2], JSON.stringify(wf, null, 2) + '\n');
console.log('wrote', process.argv[2], nodes.length, 'nodes');
