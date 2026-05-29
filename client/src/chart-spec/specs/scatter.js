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

function buildValueAxis(range) {
  const r = range || {};
  const def = { type: r.scale === 'log' ? 'log' : 'value' };
  if (r.min != null) def.min = Number(r.min);
  if (r.max != null) def.max = Number(r.max);
  def.axisLabel = { color: COLOR_TEXT_SECONDARY };
  return def;
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
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data) {
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};

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

  // Tooltip — point mode shows x/y (and size when present), formatted.
  const tt = opts.tooltip || {};
  const fmt = makeValueFormatter(tt.decimals, tt.units);
  const tooltip = tt.mode === 'hidden'
    ? { show: false }
    : {
        trigger: 'item',
        formatter: (p) => {
          const v = p.value || [];
          const lines = [`${xCol}: ${fmt(v[0])}`, `${yCol}: ${fmt(v[1])}`];
          if (sizeIdx >= 0 && v[2] != null) lines.push(`${sizeCol}: ${fmt(v[2])}`);
          const head = p.seriesName ? `${p.marker || ''}${p.seriesName}` : '';
          return [head, ...lines].filter(Boolean).join('<br/>');
        },
      };

  const option = {
    backgroundColor: TRANSPARENT_BG,
    tooltip,
    grid: { top: 30, left: 50, right: 20, bottom: 40, containLabel: true },
    xAxis: withAxisName(buildValueAxis(opts.xAxisRange), dm.x_axis_label || '', true),
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
