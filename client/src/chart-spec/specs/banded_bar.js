// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// banded_bar buildOption — end-state Stage 2 shape (replaces the legacy
// string-template branch in ComponentEditor.getDataDrivenChartCode).
//
// Levey-Jennings / control-chart style: a per-row envelope drawn from
// each row's own mean + ±1/±2 SD columns. Four visual styles:
//   - time_series     line + dots over stacked-area SD bands (default)
//   - column_filled   one vertical stacked-bar column per row, no borders
//   - column_outlined column_filled + band borders
//   - column_box      inner ±1 SD band only, with a mean tick
//
// Given current form values (data_mapping.band_columns + the chosen
// timestamp column + options.bandedBarStyle) and the query rows, returns
// an ECharts `option`. ChartShell renders it and owns the HTML title
// header — there is no option.title here (matches line/gauge).

import {
  COLOR_PRIMARY,
  COLOR_TEXT,
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  columnIndex,
} from '../option-helpers.js';

// Band fill/stroke colors. These are banded-bar-specific (teal inner,
// purple outer, white mean tick) and not part of the shared palette, so
// they live here. Kept byte-for-byte from the legacy template.
const BAND_OUTER_FILL = 'rgba(190, 149, 255, 0.18)'; // ±2 SD — purple
const BAND_OUTER_STROKE = '#be95ff';
const BAND_INNER_FILL_AREA = 'rgba(8, 189, 186, 0.22)'; // ±1 SD — teal (area)
const BAND_INNER_FILL_BAR = 'rgba(8, 189, 186, 0.30)'; // ±1 SD — teal (bar, denser)
const BAND_INNER_STROKE = '#08bdba';
const MEAN_TICK_COLOR = COLOR_TEXT; // gray10

const AXIS_LINE = '#525252';
const SPLIT_LINE = '#262626';
const TOOLTIP_BG = '#262626';
const TOOLTIP_BORDER = '#393939';

const round4 = (n) => Number(n.toFixed(4));

/**
 * Compute padded y-axis bounds. Auto-scale puts the floor at 0 because
 * the stacked width-helper series carry small delta values, which makes
 * the bands look tiny against an empty panel. Instead bound to the wider
 * of ±3 SD (extrapolated from the available SD columns) or 10% of the
 * mean; fall back to the data extent + 10% when no SD info is present.
 */
function computeYBounds({ meanVals, m1sd, p1sd, m2sd, p2sd, has1SD, has2SD }) {
  const yLowData = has2SD ? Math.min(...m2sd) : has1SD ? Math.min(...m1sd) : Math.min(...meanVals);
  const yHighData = has2SD ? Math.max(...p2sd) : has1SD ? Math.max(...p1sd) : Math.max(...meanVals);
  const meanAvg = meanVals.reduce((a, b) => a + b, 0) / meanVals.length;
  // SD estimate: prefer the ±2 SD half-width / 2, fall back to ±1 SD half-width.
  const sdEstimate = has2SD ? (p2sd[0] - m2sd[0]) / 4
    : has1SD ? (p1sd[0] - m1sd[0]) / 2
    : 0;
  const padSD = sdEstimate > 0 ? sdEstimate * 3 : 0;
  const padPct = Math.abs(meanAvg) * 0.10;
  const pad = Math.max(padSD, padPct);
  return { yMin: yLowData - pad, yMax: yHighData + pad };
}

/**
 * Build the ECharts legend block from options.legend. Defaults ON and
 * positioned TOP (banded_bar always has named band series worth a key).
 * Returns { legend, position } — position is null when the legend is
 * hidden so the grid math below doesn't reserve space for it.
 */
function buildLegend(legend) {
  const show = legend?.show != null ? Boolean(legend.show) : true;
  if (!show) return { legend: undefined, position: null };
  const pos = legend?.position || 'top';
  const block = { type: 'scroll', textStyle: { color: COLOR_TEXT_SECONDARY } };
  switch (pos) {
    case 'bottom': block.bottom = 0; break;
    case 'left': block.left = 0; block.orient = 'vertical'; break;
    case 'right': block.right = 0; block.orient = 'vertical'; break;
    case 'top':
    default: block.top = 0; break;
  }
  return { legend: block, position: pos };
}

/**
 * Shared axis + tooltip frame for every style. `legendPos` (null when the
 * legend is hidden) bumps the grid edge on the legend's side so the plot
 * doesn't run under it — side legends reserve ~135px, matching line.js.
 */
function baseOption(categories, yMin, yMax, legendPos, extra = {}) {
  const gridTop = legendPos === 'top' ? 36 : 50;
  const gridBottom = legendPos === 'bottom' ? 56 : 40;
  const gridLeft = legendPos === 'left' ? 135 : 50;
  const gridRight = legendPos === 'right' ? 135 : 20;
  return {
    backgroundColor: TRANSPARENT_BG,
    grid: { top: gridTop, left: gridLeft, right: gridRight, bottom: gridBottom, containLabel: true },
    xAxis: {
      type: 'category',
      data: categories,
      axisLabel: { color: COLOR_TEXT_SECONDARY },
      axisLine: { lineStyle: { color: AXIS_LINE } },
    },
    yAxis: {
      type: 'value',
      min: yMin,
      max: yMax,
      axisLabel: { color: COLOR_TEXT_SECONDARY },
      axisLine: { lineStyle: { color: AXIS_LINE } },
      splitLine: { lineStyle: { color: SPLIT_LINE } },
    },
    ...extra,
  };
}

/**
 * @param {Object} values   { data_mapping, options }
 * @param {Object} data     { columns: string[], rows: any[][] }
 * @param {Object} helpers  { formatCellValue, xAxisFormat }
 * @returns {Object|null}   ECharts option, or null when unconfigured
 */
export function buildOption(values, data, helpers = {}) {
  const { formatCellValue, xAxisFormat: helperXAxisFormat = 'chart' } = helpers;
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};
  const bc = dm.band_columns || {};
  const style = opts.bandedBarStyle || 'time_series';

  const xCol = dm.x_axis || '';
  const xAxisFormat = dm.x_axis_format || helperXAxisFormat;
  const meanCol = bc.mean || '';

  // Unconfigured → return null so ChartShell shows its placeholder
  // instead of an empty canvas. (The editor also gates the preview, but
  // a saved record missing the mapping should fail soft too.)
  if (!xCol || !meanCol) return null;

  const rows = data?.rows || [];
  if (rows.length === 0) return null;

  const idx = (name) => columnIndex(data, name);
  const colVals = (name) => {
    const i = idx(name);
    return i < 0 ? null : rows.map((r) => Number.parseFloat(r[i]));
  };

  const xColIdx = idx(xCol);
  const categories = xColIdx >= 0
    ? rows.map((r) => (formatCellValue ? formatCellValue(r[xColIdx], xCol, { timestampFormat: xAxisFormat }) : r[xColIdx]))
    : [];
  const meanVals = rows.map((r) => Number.parseFloat(r[idx(meanCol)]));

  const m1sd = bc.minus_1sd ? colVals(bc.minus_1sd) : null;
  const p1sd = bc.plus_1sd ? colVals(bc.plus_1sd) : null;
  const m2sd = bc.minus_2sd ? colVals(bc.minus_2sd) : null;
  const p2sd = bc.plus_2sd ? colVals(bc.plus_2sd) : null;
  const has1SD = Boolean(m1sd && p1sd);
  const has2SD = Boolean(m2sd && p2sd);

  const { yMin, yMax } = computeYBounds({ meanVals, m1sd, p1sd, m2sd, p2sd, has1SD, has2SD });

  // Legend (show + position) — defaults on/top, applied to every style.
  const { legend, position: legendPos } = buildLegend(opts.legend);

  // ── time_series: stacked-area SD envelope behind the mean line ──────
  if (style === 'time_series') {
    const baseLow = has2SD ? m2sd : has1SD ? m1sd : null;
    const wOuterLo = has2SD && has1SD ? rows.map((_, i) => round4(m1sd[i] - m2sd[i])) : null;
    const wInner = has1SD ? rows.map((_, i) => round4(p1sd[i] - m1sd[i])) : null;
    const wOuterHi = has2SD && has1SD ? rows.map((_, i) => round4(p2sd[i] - p1sd[i])) : null;

    const series = [];
    if (baseLow) {
      series.push({
        name: '_base', type: 'line', stack: 'band', data: baseLow, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true,
        tooltip: { show: false }, showInLegend: false,
      });
    }
    if (wOuterLo) {
      series.push({
        name: '±2 SD', type: 'line', stack: 'band', data: wOuterLo, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: BAND_OUTER_FILL },
      });
    }
    if (wInner) {
      series.push({
        name: '±1 SD', type: 'line', stack: 'band', data: wInner, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: BAND_INNER_FILL_AREA },
      });
    }
    if (wOuterHi) {
      series.push({
        name: '±2 SD', type: 'line', stack: 'band', data: wOuterHi, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { color: BAND_OUTER_FILL }, showInLegend: false,
      });
    }
    series.push({
      name: 'Mean', type: 'line', data: meanVals, symbol: 'circle', symbolSize: 6,
      lineStyle: { color: COLOR_PRIMARY, width: 2 }, itemStyle: { color: COLOR_PRIMARY },
    });

    // Legend lists only the meaningful keys. ECharts filters series into
    // the legend by `legend.data`; the transparent '_base' anchor and the
    // duplicate '±2 SD hi' half are omitted (the remaining '±2 SD' entry
    // toggles both halves since they share the name).
    const tsLegend = legend
      ? { ...legend, data: ['±2 SD', '±1 SD', 'Mean'].filter((n) => series.some((s) => s.name === n)) }
      : undefined;
    return baseOption(categories, yMin, yMax, legendPos, {
      tooltip: {
        trigger: 'axis', appendToBody: true,
        backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, textStyle: { color: COLOR_TEXT },
      },
      ...(tsLegend ? { legend: tsLegend } : {}),
      series,
    });
  }

  // ── column_* : per-row vertical stacked-bar glyphs ──────────────────
  const showBorders = style === 'column_outlined';
  const onlyInnerBand = style === 'column_box';
  const series = [];

  if (onlyInnerBand) {
    // column_box: inner ±1 SD band as a stacked bar with stroke, plus a
    // mean tick (rect scatter) on top.
    if (has1SD) {
      series.push({
        name: '_base', type: 'bar', stack: 'box', data: m1sd,
        itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false },
      });
      series.push({
        name: '±1 SD', type: 'bar', stack: 'box',
        data: rows.map((_, i) => round4(p1sd[i] - m1sd[i])),
        itemStyle: { color: BAND_INNER_FILL_AREA, borderColor: BAND_INNER_STROKE, borderWidth: 1 },
      });
    }
    series.push({
      name: 'Mean', type: 'scatter', data: meanVals, symbolSize: 14,
      symbol: 'rect', itemStyle: { color: MEAN_TICK_COLOR },
    });
  } else {
    // column_filled / column_outlined: stacked-bar rectangles per row.
    // Transparent base lifts the stack to the lower bound; widths fill
    // the band regions on top.
    if (has2SD) {
      series.push({
        name: '_base', type: 'bar', stack: 'col', data: m2sd,
        itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false },
      });
    } else if (has1SD) {
      series.push({
        name: '_base', type: 'bar', stack: 'col', data: m1sd,
        itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false },
      });
    }
    if (has2SD && has1SD) {
      series.push({
        name: '±2 SD lo', type: 'bar', stack: 'col',
        data: rows.map((_, i) => round4(m1sd[i] - m2sd[i])),
        itemStyle: {
          color: BAND_OUTER_FILL,
          ...(showBorders ? { borderColor: BAND_OUTER_STROKE, borderWidth: 1 } : {}),
        },
      });
    }
    if (has1SD) {
      series.push({
        name: '±1 SD', type: 'bar', stack: 'col',
        data: rows.map((_, i) => round4(p1sd[i] - m1sd[i])),
        itemStyle: {
          color: BAND_INNER_FILL_BAR,
          ...(showBorders ? { borderColor: BAND_INNER_STROKE, borderWidth: 1 } : {}),
        },
      });
    }
    if (has2SD && has1SD) {
      series.push({
        name: '±2 SD hi', type: 'bar', stack: 'col',
        data: rows.map((_, i) => round4(p2sd[i] - p1sd[i])),
        itemStyle: {
          color: BAND_OUTER_FILL,
          ...(showBorders ? { borderColor: BAND_OUTER_STROKE, borderWidth: 1 } : {}),
        },
      });
    }
    series.push({
      name: 'Mean', type: 'scatter', data: meanVals, symbolSize: 6,
      itemStyle: { color: COLOR_PRIMARY },
    });
  }

  // Restrict the legend to meaningful entries — drop the transparent
  // '_base' anchor and dedupe the split '±2 SD lo'/'±2 SD hi' bars into a
  // single '±2 SD' key the user can toggle. (ECharts toggles every series
  // whose name matches a clicked legend key, so both halves react.)
  const columnLegend = legend
    ? {
        ...legend,
        data: ['±2 SD', '±1 SD', 'Mean'].filter((n) =>
          series.some((s) => s.name === n || (n === '±2 SD' && (s.name === '±2 SD lo' || s.name === '±2 SD hi')))),
      }
    : undefined;
  // Rename the split outer-band bars to the shared '±2 SD' key so the
  // single legend entry toggles both halves together.
  if (columnLegend) {
    series.forEach((s) => {
      if (s.name === '±2 SD lo' || s.name === '±2 SD hi') s.name = '±2 SD';
    });
  }

  return baseOption(categories, yMin, yMax, legendPos, {
    tooltip: {
      trigger: 'axis', appendToBody: true,
      backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, textStyle: { color: COLOR_TEXT },
      formatter: (params) => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        const lines = [`<b>${categories[i]}</b>`, `Mean: ${meanVals[i].toFixed(3)}`];
        if (has1SD) lines.push(`±1 SD: ${m1sd[i].toFixed(3)} / ${p1sd[i].toFixed(3)}`);
        if (has2SD) lines.push(`±2 SD: ${m2sd[i].toFixed(3)} / ${p2sd[i].toFixed(3)}`);
        return lines.join('<br/>');
      },
    },
    ...(columnLegend ? { legend: columnLegend } : {}),
    series,
  });
}
