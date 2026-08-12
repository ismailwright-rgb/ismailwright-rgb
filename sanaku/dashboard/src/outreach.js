// The outreach draft bench: read, edit, approve, send.
//
// Same authorisation shape as the content studio's Generate button - the
// caller's own Supabase session is forwarded and n8n reads sanaku_staff AS
// THAT USER. No shared token ships in this bundle.
import { supabase } from './supabase.js';
import { todayISO } from './dates.js';

const SEND_ENDPOINT = import.meta.env.VITE_N8N_SEND_URL;
const DRAFT_ENDPOINT = import.meta.env.VITE_N8N_DRAFT_URL;
export const canSend = Boolean(SEND_ENDPOINT);
export const canDraft = Boolean(DRAFT_ENDPOINT);

/**
 * Write a draft for one prospect, WITHOUT approving anything.
 *
 * The scheduled drafter only writes for prospects already approved into the
 * sequence, which meant the email had to be committed to before it could be
 * read - approve first, see what you approved afterwards. This lets the draft
 * be judged on its own merits; the prospect's status does not change until the
 * draft itself is approved.
 */
export async function draftFor(id) {
  if (!DRAFT_ENDPOINT) throw new Error('VITE_N8N_DRAFT_URL is not set in this build');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('your session expired — sign in again');
  const res = await fetch(DRAFT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ prospect_id: id }),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* empty */ }
  if (!res.ok) throw new Error(`the drafter returned ${res.status}`);
  if (payload.error) throw new Error(payload.error);
  return true;
}

/** Verified decision-makers with no draft yet — the pool to write for. */
export async function draftableProspects() {
  const { data, error } = await supabase.from('sanaku_prospects')
    .select('id,company_name,contact_name,contact_title,contact_email,contact_email_personal,contact_phone,contact_phone_source,company_phone,vertical,email_verified,status')
    .eq('email_verified', true).eq('decision_maker', true).eq('do_not_contact', false)
    .in('status', ['new', 'queued']).is('draft_body', null)
    .order('company_name');
  if (error) throw new Error(error.message);
  return data || [];
}

/** The most direct address we hold, and how much to trust it. */
export function bestEmail(p) {
  // A personal address beats a work one; a work one beats a shared inbox.
  if (p.contact_email_personal) return { email: p.contact_email_personal, kind: 'personal' };
  if (p.contact_email) {
    const generic = /^(info|contact|hello|admin|office|intake|support)@/i.test(p.contact_email);
    return { email: p.contact_email, kind: generic ? 'shared inbox' : 'direct' };
  }
  return { email: null, kind: 'none' };
}

/**
 * The number, labelled honestly.
 *
 * contact_phone is populated for every prospect but almost always came from
 * Google Places, which is the practice's published line - not the decision
 * maker's desk. Apollo's direct-dial reveal is what produces a real direct
 * number, and that credit pool is exhausted until the cycle resets, so calling
 * these "direct" would be a lie the UI tells every time it renders.
 */
export function bestPhone(p) {
  const n = p.contact_phone || p.company_phone;
  if (!n) return { phone: null, kind: 'none' };
  const direct = p.contact_phone_source && p.contact_phone_source !== 'google_places';
  return { phone: n, kind: direct ? 'direct dial' : 'practice line' };
}

/** Save an edited draft. Marks it edited, which is the signal the voice is off. */
export async function saveDraft(id, subject, body, wasEdited) {
  const { error } = await supabase.from('sanaku_prospects').update({
    draft_subject: subject,
    draft_body: body,
    draft_edited: wasEdited,
  }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Approve without sending — the scheduled sender will pick it up. */
export async function approveDraft(id) {
  const { error } = await supabase.from('sanaku_prospects').update({ status: 'approved' }).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Reject this draft. No send, and the sequence does not retry it. */
export async function skipDraft(id) {
  const { error } = await supabase.from('sanaku_prospects').update({
    status: 'skipped', draft_subject: null, draft_body: null,
  }).eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Approve AND send, now.
 *
 * The button click is the authorisation, so this path does not consult the
 * global SANAKU_SEND_ENABLED switch — that guards the unattended schedule.
 * Every other brake still applies on the n8n side: staff auth, the
 * verified/decision-maker gate, and the daily ramp.
 */
export async function approveAndSend(id) {
  if (!SEND_ENDPOINT) throw new Error('VITE_N8N_SEND_URL is not set in this build');
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('your session expired — sign in again');

  await approveDraft(id);

  const res = await fetch(SEND_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ prospect_id: id }),
  });
  let payload = {};
  try { payload = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(`the sender returned ${res.status}`);
  if (payload.error) throw new Error(payload.error);
  return true;
}

/**
 * The master send switch, read from the database rather than an env var.
 *
 * It lived in n8n's environment, which meant only someone with shell access to
 * the droplet could stop outbound email, after a restart. The one control that
 * halts every send now sits next to the drafts it governs.
 */
export async function sendSwitch() {
  const { data } = await supabase.from('sanaku_settings')
    .select('value').eq('key', 'send_enabled').maybeSingle();
  return Number(data?.value) === 1;
}

export async function setSendSwitch(on) {
  const { error } = await supabase.from('sanaku_settings')
    .update({ value: on ? 1 : 0, updated_at: new Date().toISOString() })
    .eq('key', 'send_enabled');
  if (error) throw new Error(error.message);
}

/** Today's remaining warm-up allowance, so the bench can show it. */
export async function sendBudget() {
  // The send budget resets on the business day, not the UTC day.
  const today = todayISO();
  const { data } = await supabase.from('sanaku_send_budget').select('cap,sent').eq('day', today).maybeSingle();
  if (!data) return { cap: 15, sent: 0, left: 15 };
  return { cap: data.cap, sent: data.sent, left: Math.max(0, data.cap - data.sent) };
}

/**
 * Whether the sender is actually working.
 *
 * On 2026-08-11 this panel reported "11 of 15 sends used" while the sender had
 * delivered nothing at all - every attempt was timing out against a blocked
 * SMTP port, and because the counter incremented on the ATTEMPT it read as
 * success. n8n compounded it by marking the runs "success", since the failure
 * routed to a handled branch. The failures were being written to sanaku_errors
 * the whole time; nothing displayed them.
 *
 * So the panel no longer infers health from the allowance. It counts what
 * actually left (outbound email rows) and what actually broke, and says so.
 */
export async function sendHealth() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const [delivered, failed, blocked] = await Promise.all([
    supabase.from('sanaku_conversations')
      .select('id', { count: 'exact', head: true })
      .eq('channel', 'email').eq('direction', 'outbound').gte('sent_at', since),
    supabase.from('sanaku_errors')
      .select('error,occurred_at', { count: 'exact' })
      .like('workflow', '%W2s%').gte('occurred_at', since)
      .order('occurred_at', { ascending: false }).limit(1),
    supabase.from('sanaku_prospects')
      .select('id', { count: 'exact', head: true }).eq('status', 'send_blocked'),
  ]);

  return {
    delivered: delivered.count ?? 0,
    failed: failed.count ?? 0,
    blocked: blocked.count ?? 0,
    lastError: failed.data?.[0]?.error || null,
    lastErrorAt: failed.data?.[0]?.occurred_at || null,
  };
}
