/**
 * "We could not load this" — as distinct from "there is nothing here".
 *
 * These two states looked identical before. Supabase does not throw when the
 * network fails; it resolves with `{ data: null, error }`. Every screen then
 * did `(res.data || [])`, got an empty array, and rendered its empty state. On
 * hotel wifi the Earnings page said *"No active clients yet"* and showed zero
 * revenue — a confident wrong answer, which is worse than a spinner, because
 * there is nothing about it that looks broken.
 *
 * So: any screen that reads data must distinguish the two, and this is the
 * thing it renders when the read failed.
 */

export default function LoadError({ error, onRetry, what = 'this' }) {
  if (!error) return null;

  const msg = typeof error === 'string' ? error : error.message || String(error);
  // The fetch layer in supabase.js writes a human sentence for network drops.
  // Anything else is a real server/permission answer and is shown verbatim,
  // because inventing friendlier copy for those hides the actual cause.
  const isNetwork = /offline|could not reach|failed to fetch|networkerror|load failed/i.test(msg);

  return (
    <div className="loaderr" role="alert">
      <b>{isNetwork ? `Could not load ${what}.` : `Could not load ${what} — the server refused.`}</b>
      <p>
        {isNetwork
          ? 'The connection dropped or is being blocked. Nothing here is out of date — it simply has not loaded, so do not read the figures below as zero.'
          : msg}
      </p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>Try again</button>
      )}
    </div>
  );
}

/** Pull the first real error out of a batch of settled Supabase results. */
export function firstError(...results) {
  for (const r of results) {
    if (r && r.error) return r.error;
  }
  return null;
}
