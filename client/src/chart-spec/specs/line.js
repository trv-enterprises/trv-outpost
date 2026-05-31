// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// line buildOption — the end-state shape for Stage 2. Given current
// form values (keyed by spec field id) + the query result rows, plus
// runtime helpers from the generic shell, returns an ECharts `option`
// object. No string templating. No DynamicComponentLoader eval for
// this path — the shell renders the option directly via ReactECharts.
//
// This file backs **line, area, and bar**. The render path is
// structurally the same (categorical x, numeric y, optional dual axis,
// optional pivot, optional thresholds). Per-type tweaks live inline:
//   - chartType === 'area' → adds areaStyle; type stays 'line'.
//   - chartType === 'bar' → series.type 'bar'; smooth/showSymbol/
//     sampling are skipped (their gates are line/area-only).
// The specs (line.json / bar.json) differ in which fields they expose;
// the buildOption code reads chartType from helpers and branches.
//
// Stage 1's gauge_v1.js was a verbatim port of the legacy gauge codegen
// branch. This file is intentionally not that — it's the end-state
// shape that the rest of Stage 2 will follow. After line lands and
// works, gauge migrates to the same shape (task #168).

import {
  COLOR_PRIMARY,
  COLOR_SECONDARY,
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  categoricalColor,
  makeValueFormatter,
} from '../option-helpers.js';

// Carbon's blue+purple dual-axis palette. Single-y mode forces blue
// (matches legacy). N-series single-axis mode uses the Carbon
// categorical palette (categoricalColor by series index) instead of
// ECharts' off-brand default.
const LEFT_AXIS_COLOR = COLOR_PRIMARY;
const RIGHT_AXIS_COLOR = COLOR_SECONDARY;

// Internal stack-group name. Single string is fine — we only support
// one stack group per chart for now. Multi-group would be a future
// model expansion (see chart-spec-driven-editor design doc).
const STACK_GROUP = 'stack0';

// resolveAutoXFormat turns the special "auto" x-axis format into a
// concrete preset BASED ON THE DATA. It runs ONLY for "auto" — every
// explicit preset (chart, chart_time, chart_time_seconds, …) is honored
// verbatim by returning it unchanged, so a user's deliberate choice is
// never overridden.
//
// Auto's bounded job (it is a smart default, not a cure-all):
//   1. Non-timestamp x-axis → passthrough. If the values don't parse as
//      timestamps, formatting is meaningless; return 'raw' so the caller
//      shows them as-is. (No guessing categories/numbers into dates.)
//   2. Span ≥ ~1 day → date+time ('chart'); else time-only ('chart_time').
//   3. If the chosen minute-resolution labels COLLIDE (several points in
//      one minute) and seconds disambiguates → add seconds.
// What auto does NOT do (by design — pick a fixed preset for these):
// sub-second data (it tops out at seconds), or density-vs-clarity
// tradeoffs (it optimizes disambiguation, not label length).
//
// 'raw' is a sentinel meaning "don't run a timestamp formatter" — the
// caller maps it to no-format passthrough.
function resolveAutoXFormat(xValues, xAxisCol, formatCellValue) {
  if (xValues.length === 0 || !formatCellValue) return 'chart_time';

  // (1) Non-timestamp detection: a timestamp format and a non-format
  // produce DIFFERENT output for real timestamps; for non-timestamps
  // formatCellValue passes the value through unchanged, so the two match.
  // Sample the first non-null value.
  const sample = xValues.find((v) => v != null);
  if (sample == null) return 'chart_time';
  const asTime = formatCellValue(sample, xAxisCol, { timestampFormat: 'chart_time' });
  const asRaw = String(sample);
  if (asTime === asRaw) {
    // Formatter didn't transform it → not a timestamp column. Passthrough.
    return 'raw';
  }

  // (2) Span: parse to epoch ms via Date; ≥ 24h → include the date.
  const times = xValues
    .map((v) => {
      const t = v instanceof Date ? v.getTime() : Date.parse(v) || Number(v);
      return Number.isFinite(t) ? t : null;
    })
    .filter((t) => t != null);
  let base = 'chart_time';
  if (times.length >= 2) {
    const span = Math.max(...times) - Math.min(...times);
    if (span >= 24 * 60 * 60 * 1000) base = 'chart'; // ≥ 1 day → date + time
  }

  // (3) Collision → add seconds, but only if seconds actually resolves it.
  const secondsVariant = base === 'chart' ? 'chart_datetime_seconds' : 'chart_time_seconds';
  const baseLabels = new Set();
  let collides = false;
  for (const v of xValues) {
    const lbl = formatCellValue(v, xAxisCol, { timestampFormat: base });
    if (baseLabels.has(lbl)) { collides = true; break; }
    baseLabels.add(lbl);
  }
  if (!collides) return base;
  const secLabels = new Set(xValues.map((v) => formatCellValue(v, xAxisCol, { timestampFormat: secondsVariant })));
  return secLabels.size > baseLabels.size ? secondsVariant : base;
}

/**
 * Normalize a y_axis entry from any of these shapes into the canonical
 * { column, label, stack, axis } shape:
 *   - bare string (legacy):  'cpu' → defaults applied (axis unset)
 *   - partial object:        { column: 'cpu' } → defaults filled in
 *   - full object (current): { column: 'cpu', label: 'CPU %', stack: true, axis: 'right' }
 *
 * `axis` is left unset when the entry didn't specify one, so the
 * dual-axis path can apply the "first left, second right" legacy
 * convention. When an entry DOES specify left/right, that wins.
 *
 * This is the read-path migration shim — legacy line records load
 * cleanly without a Mongo migration.
 */
function normalizeYEntry(e) {
  if (typeof e === 'string') return { column: e, label: '', stack: false, axis: undefined };
  if (!e || typeof e !== 'object') return { column: '', label: '', stack: false, axis: undefined };
  return {
    column: typeof e.column === 'string' ? e.column : '',
    label: typeof e.label === 'string' ? e.label : '',
    stack: Boolean(e.stack),
    axis: e.axis === 'right' ? 'right' : e.axis === 'left' ? 'left' : undefined,
  };
}

function buildSeriesForColumn(entry, idx, ctx) {
  const { columnIndex, rows, dualAxis, stackedCount, smooth, showSymbol, sampling, showDataLabels, chartType, seriesName } = ctx;
  const colIdx = columnIndex(entry.column);
  const data = rows.map((r) => r[colIdx]);
  const series = {
    name: seriesName,
    type: chartType === 'area' ? 'line' : chartType,
    data,
  };
  if (chartType === 'area') series.areaStyle = {};
  if ((chartType === 'line' || chartType === 'area') && smooth) series.smooth = true;
  if (showSymbol === false) series.showSymbol = false;
  if (sampling && sampling !== 'off') series.sampling = sampling;
  if (showDataLabels) series.label = { show: true, position: 'top' };
  if (dualAxis) {
    // Side: explicit `axis` wins; otherwise default first column left,
    // second column right (matches legacy convention).
    const sideRight = entry.axis === 'right' || (entry.axis == null && idx === 1);
    series.yAxisIndex = sideRight ? 1 : 0;
    series.itemStyle = { color: sideRight ? RIGHT_AXIS_COLOR : LEFT_AXIS_COLOR };
  } else if (stackedCount === 1 && idx === 0 && !entry.stack) {
    // Single-axis, single-column, unstacked → force blue for parity
    // with the legacy single-series default.
    series.itemStyle = { color: LEFT_AXIS_COLOR };
  } else {
    // Single-axis, multi-column (or stacked) → walk the Carbon
    // categorical palette by series index so columns stay on-brand and
    // visually distinct. (Previously left unset → ECharts' default
    // off-brand palette.)
    series.itemStyle = { color: categoricalColor(idx) };
  }
  if (entry.stack) series.stack = STACK_GROUP;
  return series;
}

function buildYAxisDefs(dualAxis, range) {
  const fromRange = (side) => {
    const r = (range && range[side]) || {};
    const def = { type: r.scale === 'log' ? 'log' : 'value' };
    if (r.min != null) def.min = Number(r.min);
    if (r.max != null) def.max = Number(r.max);
    return def;
  };
  if (dualAxis) {
    const left = fromRange('left');
    const right = fromRange('right');
    return [
      { ...left, axisLabel: { color: LEFT_AXIS_COLOR }, axisLine: { show: true, lineStyle: { color: LEFT_AXIS_COLOR } } },
      { ...right, axisLabel: { color: RIGHT_AXIS_COLOR }, axisLine: { show: true, lineStyle: { color: RIGHT_AXIS_COLOR } } },
    ];
  }
  return fromRange('left');
}

/**
 * Convert the spec's tooltip config into an ECharts `tooltip` block.
 * Mode 'hidden' → tooltip disabled. Mode 'single' → trigger 'item'.
 * Mode 'multi' (default) → trigger 'axis'.
 */
function buildTooltip(tt) {
  if (!tt || tt.mode === 'hidden') return { show: false };
  const block = { trigger: tt.mode === 'single' ? 'item' : 'axis' };

  // Auto path only — decimals + units. There is no per-knob custom
  // formatter escape hatch on purpose: chart-level use_custom_code
  // is the right answer when a formatter genuinely needs JS, and
  // adding a freeform code field here multiplies the eval surface
  // for marginal benefit. The 80% case (decimals + units) is here.
  const formatValue = makeValueFormatter(tt.decimals, tt.units);
  // Real function on the option literal — Stage 2 buildOption returns
  // a live JS object to React, so we don't need the __raw marker
  // trick the original draft used to keep it JSON-serializable.
  block.formatter = (params) => {
    const arr = Array.isArray(params) ? params : [params];
    const header = arr[0]?.axisValueLabel || arr[0]?.name || '';
    const parts = arr.map((p) => `${p.marker || ''}${p.seriesName ? p.seriesName + ': ' : ''}${formatValue(p.value)}`);
    return [header, ...parts].filter(Boolean).join('<br/>');
  };
  return block;
}

function buildLegend(legend, dualAxis, multipleSeries) {
  // Default-true when there's more than one series; the user can
  // override either way via the toggle.
  const want = legend?.show != null ? Boolean(legend.show) : multipleSeries;
  if (!want) return undefined;
  const pos = legend?.position || 'top';
  const block = {
    type: 'scroll',
    textStyle: { color: COLOR_TEXT_SECONDARY },
  };
  switch (pos) {
    case 'bottom': block.bottom = 0; break;
    case 'left':   block.left = 0; block.orient = 'vertical'; break;
    case 'right':  block.right = 0; block.orient = 'vertical'; break;
    case 'top':
    default:       block.top = 0; break;
  }
  // Default selection mode (ECharts: 'multiple' = clicking a series
  // toggles it independently). No explicit knob exposed — multi-toggle
  // is the universal expectation.
  return block;
}

/**
 * Build the threshold artifacts based on the chosen render mode.
 * Returns `{ markLine, visualMap }` where each is either an object
 * (apply) or undefined (skip).
 *
 * - mode === 'line' → markLine overlay only.
 * - mode === 'color_segments' → visualMap.continuous with pieces only.
 * - mode === 'both' → both.
 *
 * For markLine, every threshold becomes a horizontal reference line
 * at its value, colored as configured, labeled with `label` if set.
 *
 * For visualMap, the thresholds partition the y range. Each piece
 * spans from the previous threshold (or -Infinity) up to the next
 * (or +Infinity), colored as the upper-bound threshold's color.
 */
function buildThresholds(thresholds, mode) {
  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    return { markLine: undefined, visualMap: undefined };
  }
  const sorted = [...thresholds]
    .filter((t) => t && Number.isFinite(Number(t.value)))
    .sort((a, b) => Number(a.value) - Number(b.value));
  if (sorted.length === 0) return { markLine: undefined, visualMap: undefined };

  const renderMode = mode || 'line';
  const out = { markLine: undefined, visualMap: undefined };

  if (renderMode === 'line' || renderMode === 'both') {
    out.markLine = {
      symbol: 'none',
      silent: true,
      data: sorted.map((t) => ({
        yAxis: Number(t.value),
        lineStyle: { color: t.color || '#888', type: 'dashed', width: 1 },
        label: t.label ? { show: true, formatter: t.label, color: t.color || '#888' } : { show: false },
      })),
    };
  }

  if (renderMode === 'color_segments' || renderMode === 'both') {
    // Build pieces between thresholds. Each piece's color comes from
    // the threshold that defines its upper bound; the segment above
    // the last threshold uses that threshold's color too.
    const pieces = [];
    let lower = -Infinity;
    sorted.forEach((t) => {
      pieces.push({ gt: lower, lte: Number(t.value), color: t.color || '#888' });
      lower = Number(t.value);
    });
    pieces.push({ gt: lower, color: sorted[sorted.length - 1].color || '#888' });
    out.visualMap = {
      show: false,
      type: 'piecewise',
      dimension: 1, // y dimension
      pieces,
    };
  }

  return out;
}

/**
 * Main entry point. Pure function (no globals beyond constants).
 *
 * @param {Object} values    Form state from the spec, keyed by field id
 * @param {Object} data      Query result: { columns: string[], rows: any[][] }
 * @param {Object} helpers
 * @param {Function} helpers.formatCellValue   formatter from utils/dataTransforms
 * @param {string} helpers.chartType           'line' | 'bar' | 'area' (when bar/area migrate, they share this function with their own values)
 * @param {string} [helpers.xAxisFormat]       'chart' (default), 'chart_time', etc. — passed through from the editor's xAxisFormat field
 * @param {string} [helpers.chartName]         optional title
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data, helpers = {}) {
  // x-axis format default is 'auto' (resolves granularity from the data;
  // see resolveAutoXFormat). An explicit stored x_axis_format wins.
  const { formatCellValue, chartType = 'line', xAxisFormat: helperXAxisFormat = 'auto', chartName = '', legendSelected } = helpers;

  const rawYAxis = Array.isArray(values?.data_mapping?.y_axis) ? values.data_mapping.y_axis : [];
  // Legacy save shape parks per-column labels in a parallel array
  // `data_mapping.y_axis_labels` instead of inline on each y_axis
  // entry. Merge the parallel array onto the normalized entries here
  // so buildSeriesForColumn sees a single `entry.label` regardless of
  // which shape the record was saved in. When the entry already
  // carries a label, the inline one wins.
  const rawYLabels = Array.isArray(values?.data_mapping?.y_axis_labels) ? values.data_mapping.y_axis_labels : [];
  const yEntries = rawYAxis
    .map((e, i) => {
      const norm = normalizeYEntry(e);
      if (!norm.label && typeof rawYLabels[i] === 'string') {
        norm.label = rawYLabels[i];
      }
      return norm;
    })
    .filter((e) => e.column);
  // Dual-axis is purely the user's explicit choice. Adding a second
  // column does NOT auto-engage it; the toggle defaults off. (We dropped
  // the old "2 columns ⇒ dual-axis by convention" fallback — it made the
  // editor toggle and the preview disagree, and silently flipped on for
  // any new 2-column chart. Matches the editor formState builder in
  // ComponentEditor.jsx.) A pre-existing 2-column chart that relied on
  // the convention now renders single-axis until the toggle is flipped.
  //
  // Read from BOTH locations because the two render paths carry the flag
  // differently: the editor preview injects it on data_mapping
  // (multiple_y_axis), while a saved record persists it on
  // options.multipleYAxis (the data_mapping written to disk has no such
  // field). Either being true means dual-axis. Without the options read,
  // a saved chart with the toggle on would silently fall back to
  // single-axis now that the column-count convention is gone.
  const dualAxis = values?.data_mapping?.multiple_y_axis === true
    || values?.options?.multipleYAxis === true;
  const xAxisCol = values?.data_mapping?.x_axis || '';
  const xAxisLabel = values?.data_mapping?.x_axis_label || '';
  // Prefer the spec-bound x_axis_format when present (Stage 2 line),
  // fall back to the helper for callers that pre-Stage-2 passed it
  // alongside the data.
  const xAxisFormat = values?.data_mapping?.x_axis_format || helperXAxisFormat;
  const seriesCol = values?.data_mapping?.series || '';

  const columns = data?.columns || [];
  const rows = data?.rows || [];
  const columnIndex = (name) => columns.indexOf(name);

  // Build categories from the x-axis column. The 'auto' format resolves
  // to a concrete preset from the data (span → time-only/date+time,
  // collision → add seconds, non-timestamp → 'raw' passthrough); every
  // explicit preset is honored unchanged.
  const xColIdx = columnIndex(xAxisCol);
  const xValues = xColIdx >= 0 ? rows.map((r) => r[xColIdx]) : [];
  const resolvedXFormat = xAxisFormat === 'auto'
    ? resolveAutoXFormat(xValues, xAxisCol, formatCellValue)
    : xAxisFormat;
  const categories = xValues.map((v) => {
    if (!formatCellValue) return v;
    // 'raw' (auto-detected non-timestamp) → show the value as-is.
    if (resolvedXFormat === 'raw') return v;
    return formatCellValue(v, xAxisCol, { timestampFormat: resolvedXFormat });
  });

  // Compose series. When seriesCol is set, partition rows by that
  // column's values; the first y entry's column supplies the value.
  // When seriesCol is empty, one series per y entry.
  const opts = values?.options || {};
  const smooth = opts.chartSmooth !== false;
  const showSymbol = opts.showSymbol !== false;
  const showDataLabels = Boolean(opts.chartShowDataLabels);
  const sampling = opts.sampling || 'off';

  let series = [];
  if (seriesCol) {
    const seriesIdx = columnIndex(seriesCol);
    const yCol = yEntries[0]?.column;
    const yIdx = yCol ? columnIndex(yCol) : -1;
    if (seriesIdx >= 0 && yIdx >= 0) {
      const seen = new Set();
      const seriesValues = [];
      rows.forEach((r) => {
        const v = r[seriesIdx];
        if (v != null && !seen.has(v)) { seen.add(v); seriesValues.push(v); }
      });
      series = seriesValues.map((sv, svIdx) => {
        const seriesRows = rows.filter((r) => r[seriesIdx] === sv);
        return buildSeriesForColumn(
          { column: yCol, stack: yEntries[0]?.stack || false, axis: 'left' },
          // Pass the pivot index so each split series walks the
          // categorical palette (svIdx), not all sharing idx 0.
          svIdx,
          {
            columnIndex,
            rows: seriesRows,
            dualAxis: false,
            stackedCount: seriesValues.length,
            smooth,
            showSymbol,
            sampling,
            showDataLabels,
            chartType,
            seriesName: String(sv),
          },
        );
      });
    }
  } else {
    series = yEntries.map((entry, i) => buildSeriesForColumn(entry, i, {
      columnIndex,
      rows,
      dualAxis,
      stackedCount: yEntries.length,
      smooth,
      showSymbol,
      sampling,
      showDataLabels,
      chartType,
      seriesName: entry.label || entry.column,
    }));
  }

  const tooltip = buildTooltip(opts.tooltip || {});
  const legend = buildLegend(opts.legend || {}, dualAxis, series.length > 1);

  const { markLine, visualMap } = buildThresholds(opts.yThresholds, opts.yThresholdRenderMode);
  if (markLine) {
    // Attach to the first series so the marker overlays exist exactly once.
    if (series[0]) series[0] = { ...series[0], markLine };
  }

  const yAxis = buildYAxisDefs(dualAxis, opts.yAxisRange);

  // Dual-axis dead-axis hide. When the user toggles off the only series
  // bound to one of the two y-axes via the legend, ECharts hides the
  // series itself but leaves the orphan axis line + labels on screen.
  // We mirror the visibility map ECharts exposed via legendselectchanged
  // (helpers.legendSelected) and set show:false on any yAxisIndex that
  // has no visible series. The surviving axis keeps its scale —
  // ECharts does NOT promote the survivor to span the full plot, but
  // the orphan line/labels vanish, which is the cleanup we wanted.
  // legendSelected is undefined on the very first render (no toggle
  // has fired yet) — treat that as "everything visible."
  if (dualAxis && Array.isArray(yAxis) && legendSelected) {
    const axisHasVisibleSeries = [false, false];
    series.forEach((s) => {
      const visible = legendSelected[s.name] !== false;
      if (!visible) return;
      const idx = s.yAxisIndex === 1 ? 1 : 0;
      axisHasVisibleSeries[idx] = true;
    });
    // Write `show` explicitly on every axis (true OR false). ECharts'
    // option merge keeps the previous render's `show: false` sticky if
    // we only set it conditionally — the toggled-back-on axis would
    // never re-appear because nothing wrote `show: true`.
    yAxis.forEach((ax, i) => {
      ax.show = axisHasVisibleSeries[i];
    });
  }

  // X-axis literal. Name renders below the axis when xAxisLabel is set;
  // empty label means no name (axis is silent — matches "leave empty
  // to hide" helper text in the spec).
  // boundaryGap:false for area so the fill starts flush against the
  // y-axis (matches legacy area codegen); line/bar keep the default
  // (true) so category ticks sit centered under their gridlines.
  const xAxis = { type: 'category', data: categories };
  if (chartType === 'area') xAxis.boundaryGap = false;
  if (xAxisLabel) {
    xAxis.name = xAxisLabel;
    xAxis.nameLocation = 'middle';
    xAxis.nameGap = 30;
  }

  // Grid edge budget. ECharts doesn't auto-reserve plot space for
  // legends — they overlay the canvas. We bump the grid edge on the
  // legend's side so the plot doesn't run under it. Side legends get
  // a generous ~180px column on the assumption that users who pick
  // left/right will widen the panel to accommodate; long series
  // names still get plenty of room without truncating. Top is the
  // default and the recommended position; the AI agent prompt should
  // steer toward top unless the user explicitly asks otherwise.
  const legendPos = legend ? (opts?.legend?.position || 'top') : null;
  const gridTop = legendPos === 'top' ? 36 : 10;
  // grid.bottom is the gap BELOW the x-axis labels (containLabel:true
  // auto-reserves the label height on top of this). Without a slider,
  // only a small flush gap (8px) so the labels sit at the bottom of the
  // panel. With a slider: the slider occupies bottom:8 → 8+24=32px from
  // the floor; grid.bottom 43 puts the x-axis labels ~11px above the
  // slider top (a little breathing room). 50 left an ~18px dead band.
  const gridBottomBase = opts.chartShowZoomSlider ? 43 : 8;
  const gridBottom = legendPos === 'bottom' ? gridBottomBase + 26 : gridBottomBase;
  const gridLeft = legendPos === 'left' ? 135 : 50;
  const gridRight = legendPos === 'right' ? 135 : 20;
  const option = {
    backgroundColor: TRANSPARENT_BG,
    tooltip,
    grid: { top: gridTop, left: gridLeft, right: gridRight, bottom: gridBottom, containLabel: true },
    xAxis,
    yAxis,
    series,
  };

  if (legend) option.legend = legend;
  if (visualMap) option.visualMap = visualMap;

  if (opts.chartShowZoomSlider) {
    // Default to the FULL range (start 0 → end 100), not the last 30%.
    // NOTE: ChartShell must merge (notMerge:false) on data updates so a
    // user's pan/zoom isn't snapped back to these defaults every time a
    // streaming point arrives — see ChartShell's setOption call.
    option.dataZoom = [
      {
        type: 'slider', show: true, xAxisIndex: [0], start: 0, end: 100,
        bottom: 8, height: 24,
        backgroundColor: '#262626',
        dataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.3 } },
        selectedDataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.6 } },
        handleStyle: { color: COLOR_PRIMARY },
        textStyle: { color: COLOR_TEXT_SECONDARY },
      },
      { type: 'inside', xAxisIndex: [0], start: 0, end: 100 },
    ];
  }

  // Title is rendered OUTSIDE ECharts (HTML div in SpecDrivenChart)
  // — same convention legacy line/area/bar codegen uses. Putting it
  // inside `option.title` collides with the top-positioned legend
  // and steals layout from `containLabel` math. `chartName` is
  // intentionally unread here; the shell uses it.
  // eslint-disable-next-line no-unused-expressions
  chartName;

  // tooltip.formatter is already a real function (assigned in
  // buildTooltip). The earlier draft used a __raw marker pattern to
  // keep the option JSON-serializable for legacy string codegen; the
  // Stage 2 shell takes a live JS object so we just assign functions
  // directly.

  return option;
}
