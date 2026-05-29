// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// gauge buildOption — end-state Stage 2 shape (replaces the Stage 1
// gauge_v1.js string-emitter port). Given current form values (keyed by
// spec binds path) + the query result rows, returns an ECharts `option`.
// ChartShell renders it; the title is the shell's HTML header (unified
// with line/bar/area), NOT option.title.

import {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_PRIMARY,
  COLOR_TEXT,
  TRANSPARENT_BG,
  toNumber,
  firstNumericValue,
} from '../option-helpers.js';

/**
 * Build the gauge axisLine color-segment stops. The spec stores the
 * warning/danger thresholds as PERCENTAGES of the min→max span (0-100),
 * matching the legacy gauge_v1 codegen (`warning/100`, `danger/100`).
 * Returns ECharts `[[fraction, color], ...]` stops.
 */
function buildSegments(warningPct, dangerPct) {
  const w = toNumber(warningPct, 70) / 100;
  const d = toNumber(dangerPct, 90) / 100;
  return [[w, COLOR_OK], [d, COLOR_WARN], [1, COLOR_DANGER]];
}

/**
 * Main entry point. Pure function.
 *
 * Gauge consumes a single value — the first row of the (already
 * transformed: filtered / aggregated / sliding-windowed) result set.
 *
 * @param {Object} values  Form state: { data_mapping, options }
 * @param {Object} data    Query result: { columns: string[], rows: any[][] }
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data) {
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};

  // Value column: spec binds to data_mapping.y_axis[0]. Fall back to a
  // legacy flat value_column field for old records.
  const valueColumn = (Array.isArray(dm.y_axis) ? dm.y_axis[0] : undefined) || dm.value_column || '';
  const value = firstNumericValue(data, valueColumn, 0);

  const gaugeMin = toNumber(opts.gaugeMin, 0);
  const gaugeMax = toNumber(opts.gaugeMax, 100);
  const unit = opts.gaugeUnit || '';
  // Arc thickness is a percentage (1-16) of the dial; legacy used /100
  // against the gauge's pixel radius. We can't measure pixels in a pure
  // buildOption, so map the same 1-16 range onto a sensible px width.
  const thicknessPct = toNumber(opts.gaugeLineThickness, 8);
  const axisWidth = Math.max(6, Math.round(thicknessPct * 1.5));

  const detailFormatter = (v) => `${v}${unit ? unit : ''}`;

  return {
    backgroundColor: TRANSPARENT_BG,
    series: [{
      type: 'gauge',
      min: gaugeMin,
      max: gaugeMax,
      progress: { show: false },
      axisLine: {
        lineStyle: {
          width: axisWidth,
          color: buildSegments(opts.gaugeWarningThreshold, opts.gaugeDangerThreshold),
        },
      },
      axisTick: { show: false },
      splitLine: { length: 8, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { color: '#999' },
      pointer: { itemStyle: { color: COLOR_PRIMARY } },
      anchor: { show: true, showAbove: true, size: 14, itemStyle: { borderWidth: 6 } },
      title: { show: false },
      detail: {
        valueAnimation: true,
        formatter: detailFormatter,
        color: COLOR_TEXT,
        fontSize: 24,
        offsetCenter: [0, '70%'],
      },
      data: [{ value }],
    }],
  };
}
