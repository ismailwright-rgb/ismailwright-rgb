import { supabase } from './supabase.js';

/**
 * Invite someone at a client to their portal.
 *
 * Creating an auth user needs the service_role key, which must never reach a
 * browser - so this goes through the n8n `invite-client-user` workflow, which
 * re-checks the caller is staff before doing anything.
 *
 * Returns { ok } or { ok:false, error, manual } where `manual` is true when
 * the endpoint could not be reached at all and the fallback path applies.
 */
export async function invitePortalUser({ email, clientId }) {
  const addr = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) {
    return { ok: false, error: "That doesn't look like an email address." };
  }

  const base = import.meta.env.VITE_N8N_WEBHOOK_BASE;
  if (!base) {
    return {
      ok: false, manual: true,
      error: 'This build has no n8n address baked in. Re-deploy with `sh ~/sanaku.sh dashboard`.',
    };
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { ok: false, error: 'Your session expired — sign in again.' };

  try {
    const r = await fetch(`${base}/invite-client-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ email: addr, client_id: clientId }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.ok) return { ok: true };
    if (j.error) return { ok: false, error: j.error };
    // A 2xx with no body means the workflow died before any Respond node ran.
    // "answered 200" reads like success and tells you nothing about where.
    return {
      ok: false,
      error: r.ok
        ? 'The workflow started but never confirmed - open n8n > Executions and look at the last run of "Sanaku - Invite Client User".'
        : `The invite endpoint answered ${r.status}.`,
    };
  } catch (e) {
    // A blocked mixed-content request and a dead server look identical from
    // here, so name both rather than guessing at one.
    return {
      ok: false, manual: true,
      error: base.startsWith('http://')
        ? 'Blocked: this page is HTTPS and n8n is plain HTTP, so the browser refused the request. Put n8n behind HTTPS (sh ~/sanaku.sh secure).'
        : `Could not reach n8n: ${e.message}`,
    };
  }
}

/** The path that needs no n8n at all — two steps, both in Supabase. */
export function manualInviteSteps({ email, clientId, company }) {
  return [
    `Invite ${email} to ${company} by hand — two steps, both in Supabase:`,
    '',
    '1. Authentication → Users → Invite user',
    `   ${email}`,
    '',
    '2. SQL Editor → New query → paste and Run:',
    '',
    `insert into sanaku_client_users (user_id, client_id)`,
    `select u.id, '${clientId}'::uuid`,
    `from auth.users u where lower(u.email) = lower('${email}')`,
    `on conflict do nothing;`,
    '',
    'They set a password from the email, sign in at the command center address,',
    'and land on their own portal.',
  ].join('\n');
}
