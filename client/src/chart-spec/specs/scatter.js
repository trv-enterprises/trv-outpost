// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// scatter buildOption — end-state Stage 2 shape. Scatter is its own
// module: points are numeric [x, y] pairs on true value axes (not a
// category axis like line/bar), with optional bubble sizing and
// color-by-category splitting. ChartShell renders the title.
//
// Capability gaps over legacy (which only set type+symbolSize+blue):
//   - symbol size + shape
//   - x-axis range (real value axis — has a codegen path here, unlike
//     the category-axis charts) + y-axis range, both with log scale
//   - tooltip mode + decimals + units
//   - bubble mode: size points by a third column
//   - color-by-category: one series per distinct value + legend

import {
  COLOR_PRIMARY,
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  toNumber,
  columnIndex,
  columnValues,
  makeValueFormatter,
} from '../option-helpers.js';

// Bubble sizing: map a size column's values onto a pixel-diameter range
// so the smallest point is MIN_BUBBLE and the largest MAX_BUBBLE. Linear
// in value (area-vs-value is a refinement we can add if asked).
const MIN_BUBBLE = 8;
const MAX_BUBBLE = 48;

function makeBubbleSizer(sizeValues) {
  const nums = sizeValues.map((v) => toNumber(v, 0));
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min;
  return (raw) => {
    const v = toNumber(raw, min);
    if (span <= 0) return (MIN_BUBBLE + MAX_BUBBLE) / 2;
    return MIN_BUBBLE + ((v - min) / span) * (MAX_BUBBLE - MIN_BUBBLE);
  };
}

function buildValueAxis(range, labelFormatter, labelRotate) {
  const r = range || {};
  const def = { type: r.scale === 'log' ? 'log' : 'value' };
  // scale:true makes the axis FIT the data range instead of anchoring at 0.
  // ECharts value axes include 0 by default — fine for magnitudes near 0, but
  // catastrophic for data far from 0 like epoch-second timestamps (~1.78e9):
  // the axis would span 0…1.78e9 and cram every point against the right edge.
  // A manual min/max overrides this, so only auto-scale when neither is set.
  if (r.min == null && r.max == null) def.scale = true;
  if (r.min != null) def.min = Number(r.min);
  if (r.max != null) def.max = Number(r.max);
  def.axisLabel = { color: COLOR_TEXT_SECONDARY };
  // Timestamp x-axes: format the numeric tick VALUES as times while keeping
  // the axis a value axis so points stay positioned by their numeric x. The
  // caller passes a formatter only when the x column is a timestamp.
  if (labelFormatter) def.axisLabel.formatter = labelFormatter;
  if (labelRotate) def.axisLabel.rotate = Number(labelRotate);
  return def;
}

// resolveXTimestampFormat decides how to format a scatter x-axis when it's a
// timestamp column, returning the format preset or null (not a timestamp →
// leave the axis numeric). Detection mirrors line.js: a column is timestamp-
// like when formatCellValue with a timestamp preset CHANGES its first value
// (non-timestamps pass through unchanged).
//
// When the user picked an explicit format it wins. For 'auto' we pick by the
// data's time SPAN so short windows get finer granularity (the reported case:
// ~100 points over ~100 seconds want time+seconds, not a bare date+time):
//   span ≥ ~1 day   → 'chart'                (date + time)
//   span ≥ ~10 min  → 'chart_time'           (time only)
//   span < ~10 min  → 'chart_time_seconds'   (time + seconds)
// The 10-minute seconds cutoff matches the reported case: ~100 points over
// ~100 seconds want second-granularity labels, not a bare HH:MM that repeats.
function resolveXTimestampFormat(xValues, xCol, formatCellValue, xAxisFormat) {
  if (!formatCellValue) return null;
  const nonNull = xValues.filter((v) => v != null);
  const sample = nonNull[0];
  if (sample == null) return null;

  // Timestamp detection using an explicit preset that always transforms a real
  // timestamp; if unchanged, it's not a timestamp column.
  const probe = formatCellValue(sample, xCol, { timestampFormat: 'chart_time' });
  if (String(probe) === String(sample)) return null;

  // Explicit user choice wins.
  if (xAxisFormat && xAxisFormat !== 'auto') return xAxisFormat;

  // Auto: pick by span. Normalize the raw x values to ms for the span calc.
  const ms = nonNull
    .map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n)) return NaN;
      // seconds (~1.7e9) → ms; ms (~1.7e12) → as-is; anything else, best-effort.
      return n < 1e11 ? n * 1000 : n;
    })
    .filter((n) => Number.isFinite(n));
  if (ms.length < 2) return 'chart_time_seconds';
  const span = Math.max(...ms) - Math.min(...ms);
  if (span >= 24 * 60 * 60 * 1000) return 'chart';          // ≥ 1 day
  if (span >= 10 * 60 * 1000) return 'chart_time';          // ≥ 10 minutes
  return 'chart_time_seconds';                              // < 10 minutes
}

function withAxisName(axis, label, isX) {
  if (!label) return axis;
  return {
    ...axis,
    name: label,
    nameLocation: 'middle',
    nameGap: isX ? 30 : 45,
    nameTextStyle: { color: COLOR_TEXT_SECONDARY },
  };
}

function buildLegend(legend) {
  if (legend?.show === false) return undefined;
  const pos = legend?.position || 'top';
  const block = { type: 'scroll', textStyle: { color: COLOR_TEXT_SECONDARY } };
  switch (pos) {
    case 'bottom': block.bottom = 0; break;
    case 'left':   block.left = 0; block.orient = 'vertical'; break;
    case 'right':  block.right = 0; block.orient = 'vertical'; break;
    case 'top':
    default:       block.top = 0; break;
  }
  return block;
}

/**
 * @param {Object} values  Form state: { data_mapping, options }
 * @param {Object} data    Query result: { columns: string[], rows: any[][] }
 * @param {Object} [helpers] Runtime helpers from SpecDrivenChart:
 *   { formatCellValue, xAxisFormat } — used to format a timestamp x-axis.
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data, helpers = {}) {
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};
  const { formatCellValue, xAxisFormat } = helpers;

  const xCol = dm.x_axis || '';
  // y_axis[0] may be a bare string (saved shape) or a { column } object
  // (editor-preview shape); normalize both. Fall back to legacy
  // value_column.
  const rawY = Array.isArray(dm.y_axis) ? dm.y_axis[0] : undefined;
  const yCol = (typeof rawY === 'string' ? rawY : rawY?.column) || dm.value_column || '';
  const sizeCol = dm.size_column || '';
  const seriesCol = dm.series || '';

  const rows = data?.rows || [];
  const xIdx = columnIndex(data, xCol);
  const yIdx = columnIndex(data, yCol);
  const sizeIdx = sizeCol ? columnIndex(data, sizeCol) : -1;
  const seriesIdx = seriesCol ? columnIndex(data, seriesCol) : -1;

  const symbol = opts.symbolShape || 'circle';
  const baseSize = toNumber(opts.symbolSize, 15);

  // Bubble sizer built once over the whole size column so scaling is
  // consistent across (possibly multiple) series.
  const sizer = sizeIdx >= 0 ? makeBubbleSizer(columnValues(data, sizeCol)) : null;

  // Each ECharts scatter datum carries [x, y, ...extra] so the tooltip
  // and symbolSize callback can read the size value at index 2.
  const toPoint = (r) => {
    const x = toNumber(r[xIdx], null);
    const y = toNumber(r[yIdx], null);
    const pt = [x, y];
    if (sizeIdx >= 0) pt.push(toNumber(r[sizeIdx], 0));
    return pt;
  };

  const seriesBase = {
    type: 'scatter',
    symbol,
    symbolSize: sizer ? (val) => sizer(val[2]) : baseSize,
  };
  // Data labels: show the y-value next to each point (opt-in, mirrors line).
  if (opts.chartShowDataLabels) {
    seriesBase.label = { show: true, position: 'top', color: COLOR_TEXT_SECONDARY };
  }

  let series;
  if (seriesIdx >= 0 && xIdx >= 0 && yIdx >= 0) {
    // Color-by-category: one scatter series per distinct value.
    const seen = new Set();
    const order = [];
    rows.forEach((r) => {
      const v = r[seriesIdx];
      if (v != null && !seen.has(v)) { seen.add(v); order.push(v); }
    });
    series = order.map((sv) => ({
      ...seriesBase,
      name: String(sv),
      data: rows.filter((r) => r[seriesIdx] === sv).map(toPoint),
    }));
  } else if (xIdx >= 0 && yIdx >= 0) {
    series = [{
      ...seriesBase,
      data: rows.map(toPoint),
      itemStyle: { color: COLOR_PRIMARY },
    }];
  } else {
    series = [];
  }

  // Timestamp x-axis: when the x column is a timestamp, format both the axis
  // tick labels and the tooltip's x line as times (the axis stays a value axis
  // so points position by their raw numeric x). Without this the axis showed
  // raw epoch numbers (e.g. 1,783,452,050) instead of "7/7 2:20 PM".
  const xTsFormat = xIdx >= 0
    ? resolveXTimestampFormat(rows.map((r) => r[xIdx]), xCol, formatCellValue, xAxisFormat)
    : null;
  const xLabelFormatter = xTsFormat
    ? (val) => formatCellValue(val, xCol, { timestampFormat: xTsFormat })
    : null;

  // Tooltip — point mode shows x/y (and size when present), formatted.
  const tt = opts.tooltip || {};
  const fmt = makeValueFormatter(tt.decimals, tt.units);
  const fmtX = xLabelFormatter ? (v) => xLabelFormatter(v) : fmt;
  const tooltip = tt.mode === 'hidden'
    ? { show: false }
    : {
        trigger: 'item',
        formatter: (p) => {
          const v = p.value || [];
          const lines = [`${xCol}: ${fmtX(v[0])}`, `${yCol}: ${fmt(v[1])}`];
          if (sizeIdx >= 0 && v[2] != null) lines.push(`${sizeCol}: ${fmt(v[2])}`);
          const head = p.seriesName ? `${p.marker || ''}${p.seriesName}` : '';
          return [head, ...lines].filter(Boolean).join('<br/>');
        },
      };

  // grid.bottom: containLabel:true auto-reserves the axis-label height,
  // so this is the EXTRA gap below the labels. Flush (8px) by default;
  // bump to ~38 only when an x-axis NAME is set (nameGap 30 places the
  // name below the labels). Previously a flat 40 left a dead band under
  // label-less scatters, matching the line/area/bar fix.
  const gridBottom = dm.x_axis_label ? 38 : 8;

  const option = {
    backgroundColor: TRANSPARENT_BG,
    tooltip,
    grid: { top: 30, left: 50, right: 20, bottom: gridBottom, containLabel: true },
    xAxis: withAxisName(buildValueAxis(opts.xAxisRange, xLabelFormatter, opts.xAxisLabelRotate), dm.x_axis_label || '', true),
    yAxis: withAxisName(buildValueAxis(opts.yAxisRange?.left), dm.y_axis_label || '', false),
    series,
  };

  // Legend only meaningful with multiple (color-by) series.
  if (series.length > 1) {
    const legend = buildLegend(opts.legend || {});
    if (legend) option.legend = legend;
  }

  return option;
}
