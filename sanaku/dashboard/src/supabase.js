import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Why this no longer throws.
 *
 * It used to `throw` right here when the config was missing, with a comment
 * saying it should "fail loudly during setup instead of silently rendering an
 * empty app". The intent was right; the mechanism did the opposite. A throw at
 * module scope happens while the bundle is still being evaluated - before React
 * mounts, before anything is painted - so the visible result is a pure white
 * page with no text, no error, nothing. The loudest possible failure in the
 * console is the quietest possible failure on screen.
 *
 * That happened in production on 2026-08-12: a build ran without the VITE_
 * variables, Vite emitted a bundle with no config in it, and the dashboard went
 * blank. Nothing indicated why.
 *
 * So the failure is now data instead of an exception. `configError` is a string
 * when the app cannot possibly work, and main.jsx renders it as an actual
 * screen. The client is still constructed so that every module importing
 * `supabase` keeps working at import time - calls through it will fail, which
 * is correct and unavoidable, but they fail one request at a time rather than
 * taking the whole page down before it renders.
 */
export const configError = (!url || !anonKey)
  ? 'This build has no Supabase configuration. VITE_SUPABASE_URL and '
    + 'VITE_SUPABASE_ANON_KEY have to be set when the dashboard is BUILT, not '
    + 'when it runs - so a bundle built without them can never work, and '
    + 'rebuilding is the only fix.'
  : null;

/**
 * Networking, for a dashboard used from hotel wifi and phone tethering.
 *
 * Two things happen here that the default client does not do:
 *
 * 1. A timeout. Without one, a request on a captive-portal network hangs
 *    forever and the page sits on "Loading…" with no way to tell that it is
 *    never coming back.
 *
 * 2. Retry with backoff — but ONLY for GET/HEAD. This is the important
 *    restriction. Retrying a POST or PATCH whose response was lost in transit
 *    would re-run a write that already succeeded: a duplicated statement, a
 *    second invite, a lead counted twice. A read is safe to repeat; a write is
 *    not, and "the network was flaky" is not a good enough reason to risk
 *    double-billing a client.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Transient: worth trying again. Anything else is the server's real answer. */
const isTransientStatus = (s) => s === 408 || s === 425 || s === 429 || (s >= 500 && s <= 599);

async function resilientFetch(input, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const retryable = method === 'GET' || method === 'HEAD';
  let lastErr;

  for (let attempt = 0; attempt <= (retryable ? MAX_RETRIES : 0); attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);

    // Respect a caller's own abort signal as well as our timeout.
    const onAbort = () => ctl.abort();
    if (init.signal) {
      if (init.signal.aborted) ctl.abort();
      else init.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(input, { ...init, signal: ctl.signal });
      if (retryable && isTransientStatus(res.status) && attempt < MAX_RETRIES) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      // A caller-initiated abort is not a failure to retry — it is a cancel.
      if (init.signal?.aborted) throw err;
      if (!retryable || attempt === MAX_RETRIES) break;
      await sleep(400 * 2 ** attempt);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener?.('abort', onAbort);
    }
  }

  // Give the UI something a human can act on instead of "Failed to fetch".
  const e = new Error(
    navigator.onLine === false
      ? 'You appear to be offline. This will retry when the connection comes back.'
      : 'Could not reach Sanaku. The network dropped or is being blocked — common on hotel and guest wifi.',
  );
  e.cause = lastErr;
  e.isNetworkError = true;
  throw e;
}

// Placeholder values keep createClient from throwing when config is absent.
// Nothing can be reached through it, which is the point - the error screen is
// already on top by the time anything would try.
export const supabase = createClient(
  url || 'https://unconfigured.invalid',
  anonKey || 'unconfigured',
  {
    auth: {
      // Signing in on a new device or network has to survive a reload, and the
      // token has to renew itself on a laptop that has been shut since the last
      // airport. These are the library defaults; they are stated explicitly so
      // nobody "tidies them away" later without realising what they do.
      persistSession: true,
      autoRefreshToken: true,
      // Invite and password-recovery links arrive as a URL fragment, and
      // App.jsx keys off that. Turning this off silently breaks invites.
      detectSessionInUrl: true,
      storageKey: 'sanaku-auth',
    },
    global: { fetch: resilientFetch },
  },
);
