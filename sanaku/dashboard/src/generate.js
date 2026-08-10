// Asking the studio for something, on demand.
//
// M1 normally runs itself at 7am. This is the Generate button: same pipeline,
// entered through a webhook instead of the cron, with a format forced.
//
// AUTHORISATION, and why there is no API key in this file.
//
// The obvious version ships a shared token in the bundle - which is a password
// published on the internet, since anyone can read a deployed dashboard's
// JavaScript. Instead the caller's own Supabase session is forwarded, and n8n
// asks PostgREST to read `sanaku_staff` AS THAT USER. That table's only policy
// is `sanaku_is_staff()`, so a client-portal login gets an empty array and a
// logged-out one gets a 401. RLS does the authorising; there is nothing here
// worth stealing.
import { supabase } from './supabase.js';

const ENDPOINT = import.meta.env.VITE_N8N_WEBHOOK_URL;

export const canGenerate = Boolean(ENDPOINT);

/**
 * Ask for `count` drafts of `contentType` (null = let the angle engine choose).
 *
 * Resolves as soon as the studio ACCEPTS the request, not when it finishes -
 * a run takes 30-90 seconds and holding a browser connection open that long
 * is a worse experience than watching the queue fill in.
 */
export async function requestGeneration(contentType, count = 1) {
  if (!ENDPOINT) {
    throw new Error('VITE_N8N_WEBHOOK_URL is not set in this build');
  }

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('your session expired — sign in again');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ content_type: contentType, count }),
  });

  // n8n answers the refusal with 200 and a body, so status alone is not enough.
  let payload = {};
  try { payload = await res.json(); } catch { /* empty body */ }

  if (!res.ok) throw new Error(`the studio returned ${res.status}`);
  if (payload.error) throw new Error(payload.error);
  if (!payload.accepted) throw new Error('the studio did not accept the request');
  return true;
}
