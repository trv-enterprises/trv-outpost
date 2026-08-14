// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the dataview column-format vocabulary's timestamp-vs-duration
// distinction. The original bug: the only "HH:MM:SS" option was
// duration_clock (elapsed seconds), so an epoch timestamp column rendered
// as ~211221:30:12 — total hours since 1970 — when the author wanted
// time-of-day. The date/time ids route through the datetime path instead.
// Assertions are timezone-agnostic (formatTimestamp renders local time).

import { describe, it, expect } from 'vitest';
import { formatNumberValue } from './number-formats';

// A fixed epoch-seconds timestamp (2026-08-13T12:34:56Z).
const EPOCH = 1786624496;

const datetime = (raw, sub) =>
  formatNumberValue(raw, 'timestamp', { numberFormat: 'datetime', numberDateFormat: sub });

describe('dataview column formats: timestamp vs duration', () => {
  it('time_seconds renders an epoch as time-of-day with seconds, not total hours', () => {
    const out = datetime(EPOCH, 'time_seconds');
    // hh:mm:ss with a sane hour (≤ 2 digits) — never the 6-digit
    // duration-hours rendering the bug produced.
    expect(out).toMatch(/\b\d{1,2}:\d{2}:\d{2}\b/);
    expect(out).not.toMatch(/\d{3,}:\d{2}:\d{2}/);
  });

  it('time renders without seconds', () => {
    expect(datetime(EPOCH, 'time')).toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(datetime(EPOCH, 'time')).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('datetime_seconds includes a date and seconds', () => {
    const out = datetime(EPOCH, 'datetime_seconds');
    expect(out).toMatch(/[A-Za-z]{3}/); // month name
    expect(out).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  });

  it('date renders date only', () => {
    const out = datetime(EPOCH, 'date');
    expect(out).toMatch(/[A-Za-z]{3}/);
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('duration_clock remains an elapsed-seconds formatter (uncapped hours)', () => {
    // 90061s = 1d 1h 1m 1s → 25:01:01. Applied to an EPOCH it produces the
    // huge-hours rendering — correct for durations, which is why the
    // dropdown labels it "Duration in seconds", not a time format.
    expect(formatNumberValue(90061, 'uptime.sec', { numberFormat: 'duration_clock' })).toBe('25:01:01');
    expect(formatNumberValue(EPOCH, 'timestamp', { numberFormat: 'duration_clock' })).toMatch(/^\d{6}:\d{2}:\d{2}$/);
  });

  it('unknown numberDateFormat falls back to chart_datetime instead of breaking', () => {
    const out = datetime(EPOCH, 'not-a-real-preset');
    expect(out).toMatch(/[A-Za-z]{3}/);
    expect(out).toMatch(/\d{1,2}:\d{2}/);
  });
});
