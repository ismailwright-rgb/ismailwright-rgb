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

// Placeholder values keep createClient from throwing when config is absent.
// Nothing can be reached through it, which is the point - the error screen is
// already on top by the time anything would try.
export const supabase = createClient(
  url || 'https://unconfigured.invalid',
  anonKey || 'unconfigured',
);
