// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins time-series gap indication.
//
// The x-axis is `type: 'category'`, which spaces rows evenly with no notion
// of elapsed time — a missing collection interval has NO ROW, so ECharts
// joins the neighbours and a multi-hour outage reads as continuous data.
// `connectNulls: false` (already the default) can only break a line at an
// explicit null, and there was no null to break at. These functions create
// one.
//
// Shape verified against the live kitchen-env store: 987 records, median
// cadence 360s, three real gaps (40h, 3.7h, 21h).

import { describe, it, expect } from 'vitest';
import { inferIntervalMs, findGaps, insertGapRows, GAP_THRESHOLD_MULTIPLE } from './gap-detection';

const T0 = Date.parse('2026-08-21T00:00:00Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

describe('inferIntervalMs', () => {
  it('finds the cadence of an even series', () => {
    expect(inferIntervalMs([0, 1, 2, 3, 4].map(at))).toBe(60000);
  });

  it('uses the MEDIAN so one long outage cannot mask the rest', () => {
    // A mean would be dragged to ~24 min by the single 120-min hole and then
    // no ordinary gap would clear the threshold — exactly backwards.
    const xs = [0, 6, 12, 132, 138, 144].map(at);
    expect(inferIntervalMs(xs)).toBe(6 * 60000);
  });

  it('ignores duplicate timestamps', () => {
    expect(inferIntervalMs([0, 0, 5, 10, 15].map(at))).toBe(5 * 60000);
  });

  it('sorts first — pivot rows arrive grouped, not in time order', () => {
    expect(inferIntervalMs([10, 0, 5, 15].map(at))).toBe(5 * 60000);
  });

  it('returns 0 when there is nothing usable', () => {
    expect(inferIntervalMs([])).toBe(0);
    expect(inferIntervalMs([at(0), at(1)])).toBe(0);      // under 3 points
    expect(inferIntervalMs(['a', 'b', 'c'])).toBe(0);      // not timestamps
    expect(inferIntervalMs(null)).toBe(0);
  });

  it('handles ts-store epoch SECONDS, not just ISO', () => {
    // parseTimestamp normalizes these; a bare new Date() would read them as
    // 1970 and the cadence would be nonsense.
    const secs = [0, 60, 120, 180].map((s) => Math.floor(T0 / 1000) + s);
    expect(inferIntervalMs(secs)).toBe(60000);
  });
});

describe('findGaps', () => {
  it('flags a hole and reports how many intervals are missing', () => {
    const xs = [0, 1, 2, 8, 9].map(at);
    const gaps = findGaps(xs, 60000);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].index).toBe(3);
    expect(gaps[0].missing).toBe(5);
  });

  it('does NOT flag ordinary collector jitter', () => {
    // Real collectors drift a second or two; flagging that would shred every
    // line into fragments.
    const jitter = [0, 1.02, 2.01, 3.05, 4, 5.02].map(at);
    expect(findGaps(jitter, 60000)).toHaveLength(0);
  });

  it('uses the documented threshold multiple', () => {
    // Just under the threshold: no gap. Just over: gap. Pins the constant so
    // a future tweak is a deliberate act.
    const under = [0, 1, 1 + (GAP_THRESHOLD_MULTIPLE - 0.1)].map(at);
    const over = [0, 1, 1 + (GAP_THRESHOLD_MULTIPLE + 0.1)].map(at);
    expect(findGaps(under, 60000)).toHaveLength(0);
    expect(findGaps(over, 60000)).toHaveLength(1);
  });

  it('ignores backwards deltas rather than inventing a gap', () => {
    // Out-of-order rows are a data problem; a phantom break would hide it.
    const xs = [0, 10, 5, 15].map(at);
    expect(findGaps(xs, 60000).every((g) => g.gapMs > 0)).toBe(true);
  });

  it('does nothing without a usable interval', () => {
    expect(findGaps([at(0), at(9)], 0)).toEqual([]);
    expect(findGaps(null, 60000)).toEqual([]);
  });
});

describe('insertGapRows', () => {
  const rows = (mins) => mins.map((m, i) => [at(m), i * 10]);

  it('splices one null row per gap, leaving real rows untouched', () => {
    const out = insertGapRows(rows([0, 1, 2, 8, 9]), 0, 60000);
    expect(out).toHaveLength(6);
    expect(out.map((r) => r[1])).toEqual([0, 10, 20, null, 30, 40]);
  });

  it('handles MULTIPLE gaps without index drift', () => {
    // Spliced in descending order; ascending would invalidate later indices.
    const out = insertGapRows(rows([0, 1, 7, 8, 14]), 0, 60000);
    expect(out.map((r) => r[1])).toEqual([0, 10, null, 20, 30, null, 40]);
  });

  it('nulls EVERY column, not just the first series', () => {
    const wide = [[at(0), 1, 2], [at(1), 3, 4], [at(9), 5, 6]];
    const out = insertGapRows(wide, 0, 60000);
    const filler = out[2];
    expect(filler[1]).toBeNull();
    expect(filler[2]).toBeNull();
  });

  it('gives the filler row a timestamp so the axis label stays sane', () => {
    const out = insertGapRows(rows([0, 1, 9]), 0, 60000);
    expect(out[2][0]).not.toBeNull();
    expect(Date.parse(out[2][0])).toBe(T0 + 2 * 60000); // one interval on
  });

  it('returns the SAME array reference when there is nothing to do', () => {
    const r = rows([0, 1, 2]);
    expect(insertGapRows(r, 0, 60000)).toBe(r);   // no gaps
    expect(insertGapRows(r, 0, 0)).toBe(r);       // no interval
    expect(insertGapRows(r, -1, 60000)).toBe(r);  // no x column
    expect(insertGapRows([], 0, 60000)).toEqual([]);
  });
});
