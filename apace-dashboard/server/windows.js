/**
 * Time-of-day structure for a US equity session.
 *
 * Intraday volume is U-shaped: heavy at the open, thin through the middle,
 * heavy again into the close. The windows below name those phases and rate how
 * suitable each is for opening a new day trade.
 *
 * IMPORTANT: these ratings are conventional trading-desk wisdom, not numbers
 * fitted to your fills. They are a prompt to think about timing, not evidence
 * that a given window is profitable. Nothing here has been backtested.
 *
 * Everything is measured against the session's own open and close, so half days
 * collapse the middle rather than producing nonsense.
 */

const WINDOWS = {
  premarket: {
    label: 'Pre-market',
    quality: 0,
    note: 'Regular session has not opened. Orders will not fill until the bell.',
  },
  opening_drive: {
    label: 'Opening drive',
    quality: 0.45,
    note: 'Heaviest volume of the day, but spreads are wide and the first move often reverses. The opening range is still forming.',
  },
  morning_trend: {
    label: 'Morning trend',
    quality: 1,
    note: 'The strongest window for continuation setups. The opening range is established, volume is still high, and there is time for a move to develop.',
  },
  midday_lull: {
    label: 'Midday lull',
    quality: 0.35,
    note: 'Thinnest volume of the session. Breakouts fail more often here and spreads widen relative to the move on offer.',
  },
  afternoon_trend: {
    label: 'Afternoon trend',
    quality: 0.8,
    note: 'Volume returns as the close approaches. Second-best window, though there is less room for a position to work.',
  },
  closing_imbalance: {
    label: 'Closing imbalance',
    quality: 0.15,
    note: 'Auction imbalances dominate and moves are mechanical. Manage what you hold; do not open something new.',
  },
  closed: {
    label: 'Closed',
    quality: 0,
    note: 'The session has ended.',
  },
};

const MINUTE = 60000;

function classify(minutesFromOpen, minutesToClose) {
  if (minutesFromOpen < 0) return 'premarket';
  if (minutesToClose <= 0) return 'closed';
  if (minutesFromOpen < 30) return 'opening_drive';
  if (minutesFromOpen < 120) return 'morning_trend';
  if (minutesToClose > 120) return 'midday_lull';
  if (minutesToClose > 30) return 'afternoon_trend';
  return 'closing_imbalance';
}

/** Boundaries in minutes-from-open, so we can say when the next window starts. */
function boundaries(sessionMinutes) {
  const points = [
    { at: 0, key: 'opening_drive' },
    { at: 30, key: 'morning_trend' },
    { at: 120, key: 'midday_lull' },
    { at: sessionMinutes - 120, key: 'afternoon_trend' },
    { at: sessionMinutes - 30, key: 'closing_imbalance' },
    { at: sessionMinutes, key: 'closed' },
  ];

  // On a short session the middle windows collapse; drop any that invert.
  return points
    .filter((point, index) => index === 0 || point.at > points[index - 1].at)
    .sort((a, b) => a.at - b.at);
}

export function tradeWindow(now, session) {
  const openAt = new Date(session.open).getTime();
  const closeAt = new Date(session.close).getTime();
  const at = now instanceof Date ? now.getTime() : now;

  const minutesFromOpen = (at - openAt) / MINUTE;
  const minutesToClose = (closeAt - at) / MINUTE;
  const sessionMinutes = (closeAt - openAt) / MINUTE;

  const key = classify(minutesFromOpen, minutesToClose);
  const window = WINDOWS[key];

  // The next boundary strictly after now, if the session is still running.
  const upcoming = boundaries(sessionMinutes).find((point) => point.at > minutesFromOpen);
  const next = upcoming
    ? {
        key: upcoming.key,
        label: WINDOWS[upcoming.key].label,
        quality: WINDOWS[upcoming.key].quality,
        inMinutes: Math.max(0, Math.round(upcoming.at - minutesFromOpen)),
        at: new Date(openAt + upcoming.at * MINUTE).toISOString(),
      }
    : null;

  // The best window still ahead today, so the dashboard can say "wait for it".
  const best = boundaries(sessionMinutes)
    .filter((point) => point.at > minutesFromOpen && WINDOWS[point.key].quality > window.quality)
    .map((point) => ({
      key: point.key,
      label: WINDOWS[point.key].label,
      quality: WINDOWS[point.key].quality,
      inMinutes: Math.max(0, Math.round(point.at - minutesFromOpen)),
    }))
    .sort((a, b) => b.quality - a.quality)[0] ?? null;

  return {
    key,
    label: window.label,
    quality: window.quality,
    note: window.note,
    minutesFromOpen: Math.round(minutesFromOpen),
    minutesToClose: Math.round(Math.max(0, minutesToClose)),
    next,
    bestRemaining: best,
  };
}

export { WINDOWS };
