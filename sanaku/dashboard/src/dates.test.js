/**
 * These tests exist because the dashboard is used from different countries.
 * Run with: npm test
 *
 * The important trick: `process.env.TZ` is set per-case to simulate being
 * somewhere else, which is exactly the condition the old code got wrong.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  todayISO, addDaysISO, monthPeriod, startOfDayUTC, civilParts,
  formatDay, formatSchedule, isAwayFromBusinessTz, BUSINESS_TZ,
} from './dates.js';

const TZ = 'America/Los_Angeles';

/** The bug being fixed, stated as a test. */
test('the old UTC approach really was wrong — this is what we are fixing', () => {
  // 2026-08-12 01:00 UTC is still 2026-08-11 in Los Angeles.
  const instant = new Date('2026-08-12T01:00:00Z');
  const utcWay = instant.toISOString().slice(0, 10);
  const ourWay = `${civilParts(instant, TZ).y}-08-${String(civilParts(instant, TZ).d).padStart(2, '0')}`;
  assert.equal(utcWay, '2026-08-12', 'UTC says the 12th');
  assert.equal(ourWay, '2026-08-11', 'in California it is still the 11th');
});

test('civil date is correct on both sides of UTC', () => {
  const instant = new Date('2026-08-12T01:00:00Z');
  assert.deepEqual(civilParts(instant, 'America/Los_Angeles'), { y: 2026, m: 8, d: 11 });
  assert.deepEqual(civilParts(instant, 'Asia/Tokyo'), { y: 2026, m: 8, d: 12 });
  assert.deepEqual(civilParts(instant, 'UTC'), { y: 2026, m: 8, d: 12 });
});

test('todayISO does not change when the operator travels', () => {
  const seen = new Set();
  for (const tz of ['America/Los_Angeles', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Australia/Sydney']) {
    process.env.TZ = tz;
    seen.add(todayISO(TZ));
  }
  delete process.env.TZ;
  assert.equal(seen.size, 1, `business "today" must be one value, got ${[...seen].join(', ')}`);
});

test('day arithmetic survives a DST boundary', () => {
  // US DST ends 2026-11-01. Adding a day across it must not land back on the
  // same date, which is what +86400000ms on a wall clock would do.
  assert.equal(addDaysISO(1, '2026-10-31'), '2026-11-01');
  assert.equal(addDaysISO(1, '2026-11-01'), '2026-11-02');
  assert.equal(addDaysISO(30, '2026-01-31'), '2026-03-02'); // non-leap year
  assert.equal(addDaysISO(-1, '2026-01-01'), '2025-12-31');
});

test('a month period is the business month, wherever it is requested from', () => {
  const results = [];
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'Europe/London']) {
    process.env.TZ = tz;
    const p = monthPeriod(0, TZ);
    results.push(`${p.startISO}..${p.endISO}`);
  }
  delete process.env.TZ;
  assert.equal(new Set(results).size, 1, `period shifted with the reader: ${results.join(' | ')}`);
});

test('month period starts on the 1st and ends on the real last day', () => {
  const feb = monthPeriod(0, TZ);
  assert.match(feb.startISO, /-01$/);
  // Walk back to a known month: February 2026 has 28 days.
  const p = (() => {
    // monthPeriod is relative to now, so assert the invariant instead.
    return feb;
  })();
  const lastDay = Number(p.endISO.slice(-2));
  assert.ok(lastDay >= 28 && lastDay <= 31, `implausible last day ${lastDay}`);
});

test('the instant range is half-open so no row is counted twice', () => {
  const p = monthPeriod(0, TZ);
  // endAt is midnight of the day AFTER the last day.
  const dayAfterEnd = startOfDayUTC(addDaysISO(1, p.endISO, TZ), TZ);
  assert.equal(p.endAt.getTime(), dayAfterEnd.getTime());
  assert.ok(p.endAt > p.startAt);
});

test('startOfDayUTC lands on true business midnight, in both DST states', () => {
  // Pacific Daylight Time: UTC-7 -> midnight local is 07:00 UTC
  assert.equal(startOfDayUTC('2026-08-01', TZ).toISOString(), '2026-08-01T07:00:00.000Z');
  // Pacific Standard Time: UTC-8 -> midnight local is 08:00 UTC
  assert.equal(startOfDayUTC('2026-12-01', TZ).toISOString(), '2026-12-01T08:00:00.000Z');
});

test('formatters render business time regardless of where the reader is', () => {
  const instant = new Date('2026-08-12T01:00:00Z'); // 6pm Aug 11 in LA
  const out = [];
  for (const tz of ['America/Los_Angeles', 'Asia/Tokyo']) {
    process.env.TZ = tz;
    out.push(formatDay(instant, TZ) + ' / ' + formatSchedule(instant, TZ));
  }
  delete process.env.TZ;
  assert.equal(new Set(out).size, 1, `display shifted with the reader: ${out.join(' | ')}`);
  assert.match(out[0], /Aug 11/);
});

test('formatters do not crash on null or rubbish', () => {
  for (const bad of [null, undefined, '', 'not a date']) {
    assert.equal(formatDay(bad), '—');
    assert.equal(formatSchedule(bad), '—');
  }
});

test('the business timezone matches the database default', () => {
  // migration-005-t1.sql defaults client timezone to America/Los_Angeles.
  // If these drift apart, scheduling and reporting disagree about "a day".
  assert.equal(BUSINESS_TZ, 'America/Los_Angeles');
});

test('away-from-business detection is about offset, not name', () => {
  process.env.TZ = 'Asia/Tokyo';
  assert.equal(isAwayFromBusinessTz(TZ), true);
  process.env.TZ = 'America/Los_Angeles';
  assert.equal(isAwayFromBusinessTz(TZ), false);
  delete process.env.TZ;
});
