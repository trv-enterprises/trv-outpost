// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { parseTimestamp } from '../utils/dataTransforms.js';

/**
 * Time-series gap detection for line/area charts.
 *
 * THE PROBLEM. The x-axis is `type: 'category'`, which places rows side by
 * side at equal spacing with no notion of elapsed time. When a collector
 * misses an interval there is simply NO ROW for it, so ECharts joins the two
 * rows that do exist and the result looks like continuous data. There is no
 * ECharts option that fixes this, because the missing time never reaches the
 * chart — `connectNulls: false` (already the default) can only break a line
 * at an explicit `null`, and there is no null to break at.
 *
 * THE FIX HERE. Walk the rows in time order and splice in a synthetic row of
 * nulls wherever the delta between consecutive points is a multiple of the
 * expected cadence. The line then breaks, because every series reads its
 * value from the same row array the categories are built from.
 *
 * WHAT THIS IS NOT. The gap is visible but NOT TO SCALE: a six-hour hole and
 * a two-minute hole render the same width, because the category axis is still
 * evenly spaced. Rendering gaps at true width means moving to
 * `xAxis.type: 'time'`, which changes tick formatting, threshold markLine
 * placement (currently category-index based), and zoom — a separate piece of
 * work, deliberately not smuggled in here.
 */

// A gap must exceed this multiple of the expected interval before it counts.
// Real collectors jitter: a 60s cadence routinely delivers at 61s or 58s, and
// flagging that as a gap would shred every line into fragments. 1.5x is the
// smallest multiple that clears ordinary jitter without needing a whole
// missing interval — at 2.0x a single dropped sample would not register.
export const GAP_THRESHOLD_MULTIPLE = 1.5;

/**
 * inferIntervalMs — the expected cadence of a series, in ms.
 *
 * Uses the MEDIAN delta between consecutive timestamps, not the mean: a
 * single long outage would drag a mean far enough to hide every other gap,
 * which is precisely backwards. The median is the typical spacing and is
 * unmoved by however many gaps exist.
 *
 * Returns 0 when there is nothing usable (under 3 points, unparseable
 * timestamps, non-time x-axis), which callers treat as "no gap detection" —
 * silently doing nothing is right here, since a false break is worse than a
 * missed one.
 *
 * @param {Array<*>} xValues raw x-axis cell values, in row order
 * @returns {number} ms, or 0
 */
export function inferIntervalMs(xValues) {
  if (!Array.isArray(xValues) || xValues.length < 3) return 0;
  const ts = [];
  for (const v of xValues) {
    // parseTimestamp normalizes ts-store epoch SECONDS as well as ms/µs/ns
    // and ISO — rolling our own Date() here is the documented route to
    // 1970-era x-axes.
    const d = parseTimestamp(v);
    const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
    if (t != null) ts.push(t);
  }
  if (ts.length < 3) return 0;
  // Don't assume sorted input: pivots concatenate per-series groups.
  ts.sort((a, b) => a - b);
  const deltas = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) deltas.push(d); // drop duplicate timestamps
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  const median = deltas.length % 2 === 0
    ? (deltas[mid - 1] + deltas[mid]) / 2
    : deltas[mid];
  return median > 0 ? median : 0;
}

/**
 * findGaps — index positions where a gap precedes the row, with its size.
 *
 * Returns `[{ index, gapMs, missing }]` where `index` is the row the gap sits
 * BEFORE, so callers can splice in descending order without invalidating
 * later indices. `missing` is the approximate count of absent intervals,
 * useful for a tooltip or a log.
 *
 * @param {Array<*>} xValues    raw x-axis cell values, in row order
 * @param {number}   intervalMs expected cadence (0 → no detection)
 * @returns {Array<{index: number, gapMs: number, missing: number}>}
 */
export function findGaps(xValues, intervalMs) {
  if (!Array.isArray(xValues) || !intervalMs || intervalMs <= 0) return [];
  const threshold = intervalMs * GAP_THRESHOLD_MULTIPLE;
  const gaps = [];
  let prev = null;
  for (let i = 0; i < xValues.length; i++) {
    const d = parseTimestamp(xValues[i]);
    const t = d && !Number.isNaN(d.getTime()) ? d.getTime() : null;
    if (t == null) continue; // unparseable row: can't reason about it
    if (prev != null) {
      const delta = t - prev;
      // Only FORWARD gaps. Out-of-order rows produce a negative delta, which
      // is a data problem, not a gap — flagging it would add a phantom break.
      if (delta > threshold) {
        gaps.push({
          index: i,
          gapMs: delta,
          missing: Math.max(1, Math.round(delta / intervalMs) - 1),
        });
      }
    }
    prev = t;
  }
  return gaps;
}

/**
 * insertGapRows — splice a null row into `rows` at each detected gap.
 *
 * The synthetic row carries the x-cell (a timestamp one interval after the
 * last real point, so the axis label reads sensibly) and `null` everywhere
 * else. Every series reads from this same array, so one inserted row breaks
 * all of them at the same place — which is correct: the collector was down
 * for every column at once.
 *
 * Returns the ORIGINAL array reference when there is nothing to insert, so
 * the common no-gap case costs one comparison and no allocation.
 *
 * @param {Array<Array<*>>} rows       result rows
 * @param {number}          xColIdx    index of the x-axis column
 * @param {number}          intervalMs expected cadence (0 → no-op)
 * @returns {Array<Array<*>>}
 */
export function insertGapRows(rows, xColIdx, intervalMs) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  if (xColIdx < 0 || !intervalMs || intervalMs <= 0) return rows;
  const xValues = rows.map((r) => r[xColIdx]);
  const gaps = findGaps(xValues, intervalMs);
  if (gaps.length === 0) return rows;
  const width = rows[0]?.length || 0;
  const out = rows.slice();
  // Descending, so each splice leaves the earlier indices valid.
  for (let g = gaps.length - 1; g >= 0; g--) {
    const { index } = gaps[g];
    const prevRow = rows[index - 1];
    const prevD = prevRow ? parseTimestamp(prevRow[xColIdx]) : null;
    const prevT = prevD && !Number.isNaN(prevD.getTime()) ? prevD.getTime() : null;
    const filler = new Array(width).fill(null);
    // Place the marker one interval past the last real point. Using the raw
    // epoch ms keeps it parseable by the same formatter the real rows use.
    if (prevT != null) filler[xColIdx] = new Date(prevT + intervalMs).toISOString();
    out.splice(index, 0, filler);
  }
  return out;
}

export default { inferIntervalMs, findGaps, insertGapRows, GAP_THRESHOLD_MULTIPLE };
