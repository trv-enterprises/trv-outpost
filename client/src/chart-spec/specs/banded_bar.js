// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// banded_bar buildOption — scheme-driven per-row band envelope.
//
// A "band scheme" (band-schemes.js) defines the SEMANTICS: a center
// column + ordered inner→outer band pairs, each pair a region between a
// lower and upper column, with display labels. The render here is
// scheme-agnostic — it draws the center plus N stacked band regions the
// same way for ±SD, Min/Mean/Max, SPC, or any future scheme.
//
// Four visual styles (options.bandedBarStyle):
//   - time_series     center line + dots over stacked-area band regions (default)
//   - column_filled   one vertical stacked-bar column per row, no borders
//   - column_outlined column_filled + band borders
//   - column_box      innermost band only, with a center tick
//
// Bands are per-row: each row carries its own band columns, so the
// envelope moves with the data. ChartShell renders the option and owns
// the HTML title header — there is no option.title here (matches line/gauge).

import {
  COLOR_PRIMARY,
  COLOR_TEXT,
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  columnIndex,
} from '../option-helpers.js';
import { getScheme } from './band-schemes.js';

// Band fill/stroke palette, indexed inner→outer. The innermost band is
// teal (denser fill for the bar styles), outer bands purple. Schemes with
// more than two pairs reuse the outer entry. Not part of the shared chart
// palette — these are banded-bar-specific control-band tones.
const MEAN_TICK_COLOR = COLOR_TEXT; // gray10
const BAND_TONES = [
  { areaFill: 'rgba(8, 189, 186, 0.22)', barFill: 'rgba(8, 189, 186, 0.30)', stroke: '#08bdba' }, // inner — teal
  { areaFill: 'rgba(190, 149, 255, 0.18)', barFill: 'rgba(190, 149, 255, 0.18)', stroke: '#be95ff' }, // outer — purple
];
const toneFor = (i) => BAND_TONES[Math.min(i, BAND_TONES.length - 1)];

const AXIS_LINE = '#525252';
const SPLIT_LINE = '#262626';
const TOOLTIP_BG = '#262626';
const TOOLTIP_BORDER = '#393939';

const round4 = (n) => Number(n.toFixed(4));

/**
 * Compute padded y-axis bounds from the center values plus every
 * resolved band's lower/upper series. Auto-scale would floor at 0
 * because the stacked width-helper series carry small delta values; we
 * instead bound to the actual data extent (widest band) plus 10% of the
 * center magnitude so the envelope sits comfortably in the panel.
 */
function computeYBounds(centerVals, resolvedPairs) {
  let lo = Math.min(...centerVals);
  let hi = Math.max(...centerVals);
  for (const p of resolvedPairs) {
    lo = Math.min(lo, ...p.lower);
    hi = Math.max(hi, ...p.upper);
  }
  const centerAvg = centerVals.reduce((a, b) => a + b, 0) / centerVals.length;
  const pad = Math.abs(centerAvg) * 0.10 || (hi - lo) * 0.10 || 1;
  return { yMin: lo - pad, yMax: hi + pad };
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
  // grid.bottom: containLabel:true reserves the label height, so this is
  // the extra gap below. Flush (8px) so labels sit at the panel bottom;
  // +26 for a bottom legend. (Was a flat 40 → dead band, matching the
  // line/area/bar + scatter flush-bottom fix. banded_bar's x-axis has no
  // axis name, so no name-room branch is needed.)
  const gridBottom = legendPos === 'bottom' ? 34 : 8;
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
 * Resolve a scheme's pairs against the data: for each declared pair,
 * pull the lower + upper column values when BOTH are mapped + present.
 * Returns an ordered inner→outer list of { key, label, lower, upper }
 * with numeric per-row arrays. Pairs missing a column are dropped (the
 * chart degrades gracefully to whatever bands are mapped).
 */
function resolvePairs(scheme, bandCols, colVals) {
  const out = [];
  for (const pair of scheme.pairs) {
    const lowerCol = bandCols[pair.lowerKey];
    const upperCol = bandCols[pair.upperKey];
    if (!lowerCol || !upperCol) continue;
    const lower = colVals(lowerCol);
    const upper = colVals(upperCol);
    if (!lower || !upper) continue;
    out.push({ key: pair.key, label: pair.label, lower, upper });
  }
  return out;
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
  const bandCols = dm.band_columns || {};
  const style = opts.bandedBarStyle || 'time_series';
  const scheme = getScheme(bandCols.scheme);

  const xCol = dm.x_axis || '';
  const xAxisFormat = dm.x_axis_format || helperXAxisFormat;
  const centerCol = bandCols[scheme.center.key] || '';

  // Unconfigured → return null so ChartShell shows its placeholder
  // instead of an empty canvas. The center column is always required.
  if (!xCol || !centerCol) return null;

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
  const centerVals = rows.map((r) => Number.parseFloat(r[idx(centerCol)]));

  // Inner→outer resolved pairs (each with per-row lower/upper arrays).
  const pairs = resolvePairs(scheme, bandCols, colVals);
  const centerLabel = scheme.center.label;

  const { yMin, yMax } = computeYBounds(centerVals, pairs);
  const { legend, position: legendPos } = buildLegend(opts.legend);

  // Shared tooltip: header = x value, then center, then each pair's
  // lower/upper readout labelled by the scheme.
  const tooltipFormatter = (params) => {
    const i = params[0]?.dataIndex;
    if (i == null) return '';
    const lines = [`<b>${categories[i]}</b>`, `${centerLabel}: ${centerVals[i].toFixed(3)}`];
    for (const p of pairs) {
      lines.push(`${p.label}: ${p.lower[i].toFixed(3)} / ${p.upper[i].toFixed(3)}`);
    }
    return lines.join('<br/>');
  };
  const tooltip = {
    trigger: 'axis', appendToBody: true,
    backgroundColor: TOOLTIP_BG, borderColor: TOOLTIP_BORDER, textStyle: { color: COLOR_TEXT },
    formatter: tooltipFormatter,
  };

  // Legend lists every rendered pair's label plus the center, inner→outer.
  // All styles (including column_box, which now draws the full scheme)
  // render every resolved pair, so the legend matches what's drawn.
  const legendData = [...pairs.map((p) => p.label), centerLabel];
  const legendBlock = legend ? { ...legend, data: legendData } : undefined;

  // ── time_series: stacked-area band regions behind the center line ───
  // ONE positive stack built from the outermost lower bound upward.
  // ECharts area-stacks by summing from the axis baseline and splits +/-
  // values into separate sub-stacks, so a center-anchored ±width approach
  // breaks the lower half (negatives anchor at 0, not at the center).
  // Instead lay contiguous positive-width regions bottom→top across the
  // full envelope:
  //   base = outermost lower bound (transparent)
  //   lower regions outer→inner: gap up to the next-inner lower (center for innermost)
  //   upper regions inner→outer: gap up to this pair's upper
  // Lower + upper region of a pair share the pair's name so one legend key
  // toggles both; only the upper region carries the legend entry.
  if (style === 'time_series') {
    const series = [];

    if (pairs.length > 0) {
      const outer = pairs[pairs.length - 1];
      series.push({
        name: '_base', type: 'line', stack: 'band', data: outer.lower, symbol: 'none',
        lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false },
      });
      // Lower regions, outer→inner.
      for (let k = pairs.length - 1; k >= 0; k--) {
        const p = pairs[k];
        const innerEdge = k === 0 ? centerVals : pairs[k - 1].lower;
        series.push({
          name: p.label, type: 'line', stack: 'band', symbol: 'none',
          data: p.lower.map((l, i) => round4(innerEdge[i] - l)),
          lineStyle: { opacity: 0 }, areaStyle: { color: toneFor(k).areaFill },
          showInLegend: false,
        });
      }
      // Upper regions, inner→outer (these carry the legend entries).
      for (let k = 0; k < pairs.length; k++) {
        const p = pairs[k];
        const innerEdge = k === 0 ? centerVals : pairs[k - 1].upper;
        series.push({
          name: p.label, type: 'line', stack: 'band', symbol: 'none',
          data: p.upper.map((u, i) => round4(u - innerEdge[i])),
          lineStyle: { opacity: 0 }, areaStyle: { color: toneFor(k).areaFill },
        });
      }
    }

    series.push({
      name: centerLabel, type: 'line', data: centerVals, symbol: 'circle', symbolSize: 6,
      lineStyle: { color: COLOR_PRIMARY, width: 2 }, itemStyle: { color: COLOR_PRIMARY },
    });

    return baseOption(categories, yMin, yMax, legendPos, {
      tooltip,
      ...(legendBlock ? { legend: legendBlock } : {}),
      series,
    });
  }

  // ── column_* : per-row vertical stacked-bar glyphs ──────────────────
  // All three column styles draw every band region as stacked bars from
  // the outermost lower bound up to the outermost upper bound. They differ
  // only in chrome:
  //   column_filled   — solid fills, no borders, small round center dot
  //   column_outlined — solid fills + band borders, small round center dot
  //   column_box      — solid fills + band borders, large rect center tick
  // (column_box used to draw the inner band only; it now shows the full
  // scheme like the others, distinguished by the box-style center tick.)
  const showBorders = style === 'column_outlined' || style === 'column_box';
  const series = [];

  if (pairs.length > 0) {
    const outer = pairs[pairs.length - 1];
    // Transparent base lifts the stack to the outermost lower bound.
    series.push({
      name: '_base', type: 'bar', stack: 'col', data: outer.lower,
      itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false },
    });
    // Lower gaps, outer→inner: width from this pair's lower to the next
    // inner pair's lower (or to the center for the innermost).
    for (let k = pairs.length - 1; k >= 0; k--) {
      const p = pairs[k];
      const tone = toneFor(k);
      const innerEdge = k === 0 ? centerVals : pairs[k - 1].lower;
      series.push({
        name: `${p.label} lo`, type: 'bar', stack: 'col',
        data: p.lower.map((l, i) => round4(innerEdge[i] - l)),
        itemStyle: {
          color: tone.barFill,
          ...(showBorders ? { borderColor: tone.stroke, borderWidth: 1 } : {}),
        },
      });
    }
    // Upper gaps, inner→outer: width from the inner edge to this pair's upper.
    for (let k = 0; k < pairs.length; k++) {
      const p = pairs[k];
      const tone = toneFor(k);
      const innerEdge = k === 0 ? centerVals : pairs[k - 1].upper;
      series.push({
        name: `${p.label} hi`, type: 'bar', stack: 'col',
        data: p.upper.map((u, i) => round4(u - innerEdge[i])),
        itemStyle: {
          color: tone.barFill,
          ...(showBorders ? { borderColor: tone.stroke, borderWidth: 1 } : {}),
        },
      });
    }
  }
  // Center marker: column_box uses a large rect tick (its signature);
  // the others a small round dot.
  if (style === 'column_box') {
    series.push({
      name: centerLabel, type: 'scatter', data: centerVals, symbolSize: 14,
      symbol: 'rect', itemStyle: { color: MEAN_TICK_COLOR },
    });
  } else {
    series.push({
      name: centerLabel, type: 'scatter', data: centerVals, symbolSize: 6,
      itemStyle: { color: COLOR_PRIMARY },
    });
  }

  // Collapse the split ' lo'/' hi' bar names back to the pair label so a
  // single legend entry toggles both halves (ECharts toggles every series
  // sharing a name). The transparent '_base' anchor is dropped from the
  // legend data already (legendData lists only pair labels + center).
  series.forEach((s) => {
    if (typeof s.name === 'string' && (s.name.endsWith(' lo') || s.name.endsWith(' hi'))) {
      s.name = s.name.replace(/ (lo|hi)$/, '');
      s.showInLegend = undefined;
    }
  });

  return baseOption(categories, yMin, yMax, legendPos, {
    tooltip,
    ...(legendBlock ? { legend: legendBlock } : {}),
    series,
  });
}
