// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Pins the time-series direction for line / area / bar: earliest on the
// left, newest on the right.
//
// The x-axis is `type: 'category'`, which places rows in array order. The
// streaming backfill normalizes to oldest-first (useData.js), but a polled
// REST fetch delivers the source's order — and ts-store's /data/newest is
// NEWEST-first, so REST ts-store charts drew right-to-left (prod "Temp Over
// Time", 2026-10-27). These tests feed newest-first rows straight into
// buildOption, the way the REST path does.

import { describe, it, expect } from 'vitest';
import { buildOption } from './line';

// ts-store epoch SECONDS, one minute apart.
const T0 = 1793000000;
const ts = (min) => T0 + min * 60;

const chart = (extra = {}) => ({
  data_mapping: { x_axis: 'timestamp', y_axis: ['temperature'], ...extra },
  options: { showGaps: false },
});

const xData = (opt) => opt.xAxis.data;
const yData = (opt, i = 0) => opt.series[i].data;

describe('line/area/bar time order', () => {
  it('reverses newest-first rows so the newest point is on the right', () => {
    const data = {
      columns: ['timestamp', 'temperature'],
      rows: [[ts(2), 72], [ts(1), 71], [ts(0), 70]],
    };
    const opt = buildOption(chart(), data);
    expect(xData(opt)).toEqual([ts(0), ts(1), ts(2)]);
    expect(yData(opt)).toEqual([70, 71, 72]);
  });

  it('applies to area and bar, which share this builder', () => {
    const data = {
      columns: ['timestamp', 'temperature'],
      rows: [[ts(1), 71], [ts(0), 70]],
    };
    for (const chartType of ['area', 'bar']) {
      const opt = buildOption(chart(), data, { chartType });
      expect(xData(opt)).toEqual([ts(0), ts(1)]);
      expect(yData(opt)).toEqual([70, 71]);
    }
  });

  it('sorts ISO timestamps too', () => {
    const iso = (min) => new Date(T0 * 1000 + min * 60000).toISOString();
    const data = {
      columns: ['timestamp', 'temperature'],
      rows: [[iso(1), 71], [iso(2), 72], [iso(0), 70]],
    };
    expect(xData(buildOption(chart(), data))).toEqual([iso(0), iso(1), iso(2)]);
  });

  it('leaves a categorical x-axis in query order', () => {
    const data = {
      columns: ['room', 'temperature'],
      rows: [['Kitchen', 72], ['Bedroom', 68], ['Attic', 80]],
    };
    const opt = buildOption(chart({ x_axis: 'room' }), data);
    expect(xData(opt)).toEqual(['Kitchen', 'Bedroom', 'Attic']);
  });

  it('leaves small-integer categories alone — they are not 1970 timestamps', () => {
    const data = {
      columns: ['rank', 'temperature'],
      rows: [[3, 80], [2, 72], [1, 68]],
    };
    const opt = buildOption(chart({ x_axis: 'rank' }), data);
    expect(xData(opt)).toEqual([3, 2, 1]);
  });

  it('takes accumulator deltas in time order', () => {
    // A monotonic counter delivered newest-first: in time order the deltas
    // are +5, +5. Unsorted they would be negative and dropped.
    const data = {
      columns: ['timestamp', 'bytes'],
      rows: [[ts(2), 110], [ts(1), 105], [ts(0), 100]],
    };
    const opt = buildOption(
      chart({ y_axis: ['bytes'], accumulator_columns: [true] }),
      data,
    );
    expect(yData(opt).slice(1)).toEqual([5, 5]);
  });

  it('keeps each pivot series aligned under its own timestamp', () => {
    const data = {
      columns: ['timestamp', 'room', 'temperature'],
      rows: [
        [ts(1), 'kitchen', 72], [ts(0), 'kitchen', 70],
        [ts(1), 'attic', 82], [ts(0), 'attic', 80],
      ],
    };
    const opt = buildOption(chart({ series: 'room' }), data);
    expect(xData(opt)).toEqual([ts(0), ts(1)]);
    const byName = Object.fromEntries(opt.series.map((s) => [s.name, s.data]));
    expect(byName.kitchen).toEqual([70, 72]);
    expect(byName.attic).toEqual([80, 82]);
  });
});
