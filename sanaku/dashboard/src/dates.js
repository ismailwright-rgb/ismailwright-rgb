/**
 * Dates that do not move when you do.
 *
 * The bug this replaces: `new Date().toISOString().slice(0, 10)` returns the
 * date in **UTC**, not where you are. From Los Angeles at 6pm that is already
 * tomorrow; from Tokyo at 8am it is still yesterday. It was being used to stamp
 * `pilot_ends_on`, `billing_starts_on`, and the start/end of statement periods,
 * so onboarding a client in the evening wrote the wrong dates and pulling a
 * statement from a UTC+ timezone shifted the whole month back a day.
 *
 * The fix is not "use local time" — that has the same disease with extra steps,
 * because then the numbers change depending on which airport you are in. A
 * business has one month-end. So everything here is computed in a single pinned
 * BUSINESS timezone, and a statement pulled from Tokyo matches the one your
 * accountant pulls in California.
 *
 * The exception is genuinely instantaneous things (a call happening *now*),
 * where the reader wants their own wall clock. Those use `formatLocal*`, and
 * say so at the call site.
 */

/**
 * Vite only substitutes the exact text `import.meta.env.VITE_*`. Writing it
 * with optional chaining (`import.meta?.env?.VITE_...`) defeats that: the
 * bundle keeps a runtime lookup, `import.meta.env` does not exist in the built
 * output, and the override silently never works — a config knob that looks real
 * and isn't. So it is written literally, and the try/catch is what lets the
 * same file be imported by `node --test`, where `import.meta.env` is undefined.
 */
function envTz() {
  try {
    return import.meta.env.VITE_BUSINESS_TZ;
  } catch {
    return undefined;
  }
}

// Matches the DB default for client business hours (migration-005-t1.sql), so
// the dashboard and the scheduling logic agree on when a day starts.
export const BUSINESS_TZ = envTz() || 'America/Los_Angeles';

/** Short label for the UI, e.g. "PDT" — so a figure is never unattributed. */
export function tzLabel(tz = BUSINESS_TZ, at = new Date()) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(at)
    .find((x) => x.type === 'timeZoneName');
  return p ? p.value : tz;
}

/**
 * How far `tz` is from UTC at a given instant, in ms. Positive east of
 * Greenwich. Derived from Intl rather than a table so DST is handled by the
 * platform instead of by us.
 */
function offsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  // Intl can report hour "24" for midnight in some engines; normalise it.
  const hour = p.hour === '24' ? 0 : Number(p.hour);
  const asIfUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hour, Number(p.minute), Number(p.second));
  return asIfUTC - date.getTime();
}

/** The civil date in `tz` as {y, m, d} — m is 1-based. */
export function civilParts(date = new Date(), tz = BUSINESS_TZ) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

const pad = (n) => String(n).padStart(2, '0');
const fromParts = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;

/** YYYY-MM-DD for "today", in the business timezone. Replaces the UTC version. */
export function todayISO(tz = BUSINESS_TZ) {
  return fromParts(civilParts(new Date(), tz));
}

/**
 * YYYY-MM-DD, `n` days from today in the business timezone.
 *
 * Day arithmetic is done on the civil date via UTC (which has no DST), not by
 * adding 86400000ms to a wall-clock instant — that drifts an hour across a DST
 * boundary and can land on the wrong day.
 */
export function addDaysISO(n, from = null, tz = BUSINESS_TZ) {
  const base = from || todayISO(tz);
  const [y, m, d] = base.split('-').map(Number);
  const u = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return `${u.getUTCFullYear()}-${pad(u.getUTCMonth() + 1)}-${pad(u.getUTCDate())}`;
}

/** The exact instant business-timezone midnight begins on a civil date. */
export function startOfDayUTC(isoDate, tz = BUSINESS_TZ) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  // One correction is enough: the offset at the guess is the offset that
  // applies, except within the hour a DST transition moves midnight itself,
  // which no timezone in use does.
  return new Date(guess - offsetMs(new Date(guess), tz));
}

/**
 * A whole month, `back` months ago (0 = current), in the business timezone.
 *
 * Returns civil dates for anything that is a *date* (RPC params, display) and
 * instants for anything that is a *timestamp* comparison, because mixing those
 * two is what broke the original.
 */
export function monthPeriod(back = 0, tz = BUSINESS_TZ) {
  const { y, m } = civilParts(new Date(), tz);
  // Normalise through UTC so month underflow (January minus 1) is handled.
  const anchor = new Date(Date.UTC(y, m - 1 - back, 1));
  const py = anchor.getUTCFullYear();
  const pm = anchor.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();

  const startISO = `${py}-${pad(pm)}-01`;
  const endISO = `${py}-${pad(pm)}-${pad(lastDay)}`;

  return {
    startISO,
    endISO,
    // Half-open instant range: [startAt, endAt). Use `lt` on endAt, never `lte`,
    // or the last day's rows land in two months at once.
    startAt: startOfDayUTC(startISO, tz),
    endAt: startOfDayUTC(addDaysISO(1, endISO, tz), tz),
    label: new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'long', year: 'numeric' })
      .format(startOfDayUTC(startISO, tz)),
  };
}

/* ------------------------------------------------------------- formatting --
   Business-timezone formatters. A record shows the same day and time to
   everyone, wherever they open it.
   ------------------------------------------------------------------------- */

const fmt = (opts, tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts });

/** "Aug 12" — in business time. */
export function formatDay(value, tz = BUSINESS_TZ) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return fmt({ month: 'short', day: 'numeric' }, tz).format(d);
}

/** "Aug 12, 3:40 PM" — in business time. */
export function formatDateTime(value, tz = BUSINESS_TZ) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return fmt({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, tz).format(d);
}

/** "Tue, Aug 12, 3:40 PM" — in business time. For scheduled things. */
export function formatSchedule(value, tz = BUSINESS_TZ) {
  if (!value) return '—';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return fmt({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, tz).format(d);
}

/** Whether the reader is somewhere other than the business timezone. */
export function isAwayFromBusinessTz(tz = BUSINESS_TZ) {
  try {
    const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (here === tz) return false;
    // Same wall clock (e.g. Vancouver vs Los Angeles) is not "away" in any way
    // that matters — only flag it when the offset genuinely differs.
    return offsetMs(new Date(), here) !== offsetMs(new Date(), tz);
  } catch {
    return false;
  }
}
