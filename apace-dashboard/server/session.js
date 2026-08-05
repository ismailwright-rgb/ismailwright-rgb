import { getCalendar } from './alpaca.js';

const NY = 'America/New_York';

/**
 * Convert a wall-clock date+time in a named zone to a real instant.
 * Two-pass: guess in UTC, measure how that instant renders in the zone, subtract
 * the difference. Correct across DST without pulling in a date library.
 */
export function zonedToUtc(dateStr, timeStr, timeZone = NY) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hour, minute] = timeStr.split(':').map(Number);

  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const rendered = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
  );

  return new Date(guess - (rendered - guess));
}

/**
 * The session to analyze: today's if the market has opened, otherwise the most
 * recent completed one. Uses Alpaca's calendar so half-days and holidays are
 * handled rather than assumed.
 */
export async function resolveSession(now = new Date()) {
  const iso = (d) => d.toISOString().slice(0, 10);
  const calendar = await getCalendar({
    start: iso(new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000)),
    end: iso(new Date(now.getTime() + 24 * 60 * 60 * 1000)),
  });

  const sessions = calendar
    .map((day) => ({
      date: day.date,
      open: zonedToUtc(day.date, day.open),
      close: zonedToUtc(day.date, day.close),
    }))
    .filter((s) => s.open <= now)
    .sort((a, b) => a.open - b.open);

  const session = sessions[sessions.length - 1];
  if (!session) throw new Error('no trading session found in the calendar window');

  const isToday = now < session.close;
  return {
    ...session,
    isCurrent: isToday,
    minutesToClose: Math.max(0, (session.close - now) / 60000),
    halfDay: (session.close - session.open) / 3600000 < 6,
  };
}
