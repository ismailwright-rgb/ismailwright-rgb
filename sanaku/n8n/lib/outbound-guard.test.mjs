// Run: node --test sanaku/n8n/lib/
//
// This guard is the only thing standing between a bug and texting someone who
// said stop, or ringing a mobile with an artificial voice and no consent. Every
// refusal path gets a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { outboundGuard } = createRequire(import.meta.url)('./outbound-guard.js');

const CLIENT = {
  id: 'c1',
  status: 'active',
  workflow_enabled: true,
  timezone: 'America/Los_Angeles',
  business_hours: { mon: ['07:00', '17:00'], tue: ['07:00', '17:00'], wed: ['07:00', '17:00'],
                    thu: ['07:00', '17:00'], fri: ['07:00', '17:00'], sat: null, sun: null },
};

// 2026-08-03 is a Monday. 19:00Z = 12:00 Los Angeles - inside both the TCPA
// window and this client's opening hours.
const NOON_LA = new Date('2026-08-03T19:00:00Z');
const ELEVEN_PM_LA = new Date('2026-08-04T06:00:00Z');   // 23:00 Mon LA
const SEVEN_AM_LA = new Date('2026-08-03T14:00:00Z');    // 07:00 Mon LA - open, but pre-TCPA
const MIDNIGHT_LA = new Date('2026-08-03T07:00:00Z');    // 00:00 Mon LA

const ok = (over = {}) => outboundGuard({
  client: CLIENT, hasAddon: true, suppressed: false,
  consentSource: 'web_form', channel: 'sms', now: NOON_LA, ...over,
});

test('lets a consented, in-hours message through', () => {
  const r = ok();
  assert.equal(r.maySend, true);
  assert.equal(r.reason, null);
});

test('refuses when the add-on was never bought or was cancelled', () => {
  const r = ok({ hasAddon: false });
  assert.equal(r.maySend, false);
  assert.match(r.reason, /has not bought|cancelled/);
});

test('refuses when the client is paused', () => {
  assert.equal(ok({ client: { ...CLIENT, workflow_enabled: false } }).maySend, false);
  assert.equal(ok({ client: { ...CLIENT, status: 'churned' } }).maySend, false);
});

test('refuses when no consent is on record', () => {
  const r = ok({ consentSource: null });
  assert.equal(r.maySend, false);
  assert.match(r.reason, /no consent/);
});

test('existing_customer is enough to text, but never enough to place an AI call', () => {
  assert.equal(ok({ consentSource: 'existing_customer', channel: 'sms' }).maySend, true);
  const voice = ok({ consentSource: 'existing_customer', channel: 'voice' });
  assert.equal(voice.maySend, false);
  assert.match(voice.reason, /voice/);
});

test('refuses anyone who opted out', () => {
  const r = ok({ suppressed: true });
  assert.equal(r.maySend, false);
  assert.match(r.reason, /opted out/);
});

test('opt-out beats consent — a form fill does not undo a STOP', () => {
  assert.equal(ok({ suppressed: true, consentSource: 'web_form' }).maySend, false);
});

test('holds outside 8am-9pm local, and says the local time', () => {
  const late = ok({ now: ELEVEN_PM_LA });
  assert.equal(late.maySend, false);
  assert.match(late.reason, /8am-9pm/);
  assert.match(late.reason, /23:00/);
  assert.equal(ok({ now: SEVEN_AM_LA }).maySend, false);   // client is open, TCPA is not
});

// Note: on Node this passes with or without the `% 24` normalisation, because
// hour12:false resolves to hourCycle h23 here. It guards the midnight boundary
// itself, not the modulo.
test('midnight is inside quiet hours and reports as 00:00', () => {
  const r = ok({ now: MIDNIGHT_LA });
  assert.equal(r.maySend, false);
  assert.match(r.localTime, /^00:00/);
});

test('the window follows the client timezone, not the server', () => {
  // 2026-08-04T01:00:00Z: 21:00 Monday in New York (blocked), 18:00 in LA (fine).
  const t = new Date('2026-08-04T01:00:00Z');
  assert.equal(ok({ now: t }).maySend, true);
  assert.equal(ok({ now: t, client: { ...CLIENT, timezone: 'America/New_York' } }).maySend, false);
});

test('after_hours tracks the client opening hours, separately from the send window', () => {
  assert.equal(ok({ now: NOON_LA }).afterHours, false);         // 12:00, open
  assert.equal(ok({ now: SEVEN_AM_LA }).afterHours, false);     // 07:00, open on the dot
  const sunday = new Date('2026-08-09T19:00:00Z');              // Sunday noon LA
  assert.equal(ok({ now: sunday }).afterHours, true);           // closed, but sendable
  assert.equal(ok({ now: sunday }).maySend, true);
});

test('refuses when no client matched rather than sending to nobody', () => {
  assert.equal(outboundGuard({ client: null, hasAddon: true, suppressed: false,
                               consentSource: 'web_form', channel: 'sms', now: NOON_LA }).maySend, false);
  assert.equal(outboundGuard({ client: {}, hasAddon: true, suppressed: false,
                               consentSource: 'web_form', channel: 'sms', now: NOON_LA }).maySend, false);
});

test('a client with no business_hours is treated as closed, never as open', () => {
  const r = ok({ client: { ...CLIENT, business_hours: null } });
  assert.equal(r.afterHours, true);
});
