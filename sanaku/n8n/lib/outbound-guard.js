/**
 * The one gate every outbound message passes through.
 *
 * T1 grew its own version of this inline, and copying that node into five more
 * workflows would give five copies that drift. This is the single source: the
 * build scripts in n8n/build/ inline it into each workflow's Code node, and
 * outbound-guard.test.mjs is what proves it still does what it claims.
 *
 * Four questions, in this order. Any "no" stops the send.
 *
 *   1. Did they buy it?      A cancelled add-on must stop the software the same
 *                            day it stops the invoice.
 *   2. Is the client on?     workflow_enabled and status - the kill switch.
 *   3. Did they ask for it?  consent_source on the lead. An AI voice is an
 *                            artificial voice under the TCPA; calling a mobile
 *                            without prior express consent runs $500-$1,500 per
 *                            call. Texts carry the same exposure.
 *   4. Is it a decent hour?  8am-9pm in the CLIENT's timezone, since the person
 *                            being contacted just dialled a local business.
 *   5. Have they said stop?  Permanent, per client, honoured immediately.
 *
 * Deliberately returns a reason on refusal rather than a bare false: the
 * execution log is where you find out why a client's customer heard nothing,
 * and "blocked" without a why is a support ticket.
 */

/** Consent kinds that permit us to start a conversation, by channel. */
const CONSENT_FOR_VOICE = ['web_form', 'inbound_call', 'inbound_sms', 'chat'];
const CONSENT_FOR_SMS = ['web_form', 'inbound_call', 'inbound_sms', 'chat', 'existing_customer'];

/**
 * @param {object} o
 * @param {object} o.client        the sanaku_clients row
 * @param {boolean} o.hasAddon     result of sanaku_has_addon()
 * @param {boolean} o.suppressed   a row exists in sanaku_client_suppression
 * @param {string=} o.consentSource lead.consent_source
 * @param {string} o.channel       'sms' | 'voice'
 * @param {Date=} o.now            injectable so the tests are not time-of-day flaky
 * @returns {{maySend:boolean, reason:string|null, localTime:string, afterHours:boolean}}
 */
function outboundGuard({ client, hasAddon, suppressed, consentSource, channel, now }) {
  const at = now || new Date();
  const tz = (client && client.timezone) || 'America/Los_Angeles';

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
  }).formatToParts(at);
  const get = (t) => parts.find((p) => p.type === t).value;
  // Node resolves hour12:false to hourCycle h23, so this reads 00-23 and the
  // modulo never fires. It is here because h24 is a real hour cycle (01-24) and
  // a runtime resolving to it would read midnight as 24, i.e. "later than 21",
  // and silently refuse to send for an hour every night. Cheap insurance.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const dow = get('weekday').toLowerCase();
  const localTime = String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ' ' + tz;

  // after_hours is the CLIENT's own opening hours - a billing and renewal
  // signal, and a different question from whether we are allowed to send.
  const span = ((client && client.business_hours) || {})[dow];
  let afterHours = true;
  if (Array.isArray(span) && span.length === 2) {
    const toMin = (s) => Number(String(s).split(':')[0]) * 60 + Number(String(s).split(':')[1] || 0);
    const mins = hour * 60 + minute;
    afterHours = !(mins >= toMin(span[0]) && mins < toMin(span[1]));
  }

  const refuse = (reason) => ({ maySend: false, reason, localTime, afterHours });

  if (!client || !client.id) return refuse('no client matched');
  if (!hasAddon) return refuse('this client has not bought this service, or cancelled it');
  if (client.workflow_enabled !== true || client.status !== 'active') {
    return refuse('client paused (kill switch)');
  }

  const allowed = channel === 'voice' ? CONSENT_FOR_VOICE : CONSENT_FOR_SMS;
  if (!consentSource || allowed.indexOf(consentSource) === -1) {
    return refuse(
      'no consent on record' + (consentSource ? ' valid for ' + channel + ' (' + consentSource + ')' : '')
    );
  }

  if (suppressed) return refuse('this person has opted out');

  // Quiet hours are a deferral, not a rejection: the lead is already captured,
  // only the send waits. Callers should re-try rather than drop.
  if (!(hour >= 8 && hour < 21)) return refuse('outside the 8am-9pm window (' + localTime + ')');

  return { maySend: true, reason: null, localTime, afterHours };
}

// Node can require this for the tests; n8n Code nodes get the function body
// inlined by the build scripts and never see this line.
if (typeof module !== 'undefined') module.exports = { outboundGuard, CONSENT_FOR_VOICE, CONSENT_FOR_SMS };
