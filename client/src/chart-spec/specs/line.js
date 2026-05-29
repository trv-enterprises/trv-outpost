// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// line buildOption — the end-state shape for Stage 2. Given current
// form values (keyed by spec field id) + the query result rows, plus
// runtime helpers from the generic shell, returns an ECharts `option`
// object. No string templating. No DynamicComponentLoader eval for
// this path — the shell renders the option directly via ReactECharts.
//
// Stage 1's gauge_v1.js was a verbatim port of the legacy gauge codegen
// branch. This file is intentionally not that — it's the end-state
// shape that the rest of Stage 2 will follow. After line lands and
// works, gauge migrates to the same shape (task #168).

// Carbon's blue+purple dual-axis palette. Single-y mode forces blue
// (matches legacy). N-series single-axis mode uses ECharts' default
// palette by leaving series.itemStyle.color unset.
const LEFT_AXIS_COLOR = '#0f62fe';
const RIGHT_AXIS_COLOR = '#8a3ffc';

// Internal stack-group name. Single string is fine — we only support
// one stack group per chart for now. Multi-group would be a future
// model expansion (see chart-spec-driven-editor design doc).
const STACK_GROUP = 'stack0';

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
    // with the legacy single-series default. With ≥2 columns we let
    // ECharts pick the palette so columns visually distinguish.
    series.itemStyle = { color: LEFT_AXIS_COLOR };
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
  const decimals = tt.decimals == null ? null : Number(tt.decimals);
  const units = tt.units || '';
  const formatValue = (val) => {
    if (val == null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val);
    const str = decimals == null ? String(num) : num.toFixed(decimals);
    return units ? `${str} ${units}` : str;
  };
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
    textStyle: { color: '#c6c6c6' },
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
  const { formatCellValue, chartType = 'line', xAxisFormat: helperXAxisFormat = 'chart', chartName = '', legendSelected } = helpers;

  const rawYAxis = Array.isArray(values?.data_mapping?.y_axis) ? values.data_mapping.y_axis : [];
  const yEntries = rawYAxis.map(normalizeYEntry).filter((e) => e.column);
  // Dual-axis trigger matches the legacy convention: explicit toggle
  // wins; otherwise 2 columns = dual-axis by convention. Same fallback
  // the editor's formState builder uses (ComponentEditor.jsx ~line 3139)
  // so saved charts, AI agent, and the preview all render the same.
  const explicitMultiYAxis = values?.data_mapping?.multiple_y_axis;
  const dualAxis = explicitMultiYAxis === true
    || (explicitMultiYAxis == null && yEntries.length === 2);
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

  // Build categories from the x-axis column, using the editor's
  // chosen formatter (auto-detect timestamps).
  const xColIdx = columnIndex(xAxisCol);
  const xValues = xColIdx >= 0 ? rows.map((r) => r[xColIdx]) : [];
  const categories = xValues.map((v) => formatCellValue ? formatCellValue(v, xAxisCol, { timestampFormat: xAxisFormat }) : v);

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
      series = seriesValues.map((sv) => {
        const seriesRows = rows.filter((r) => r[seriesIdx] === sv);
        return buildSeriesForColumn(
          { column: yCol, stack: yEntries[0]?.stack || false, axis: 'left' },
          0,
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
  const xAxis = { type: 'category', data: categories };
  if (xAxisLabel) {
    xAxis.name = xAxisLabel;
    xAxis.nameLocation = 'middle';
    xAxis.nameGap = 30;
  }

  // Grid top budget. Legend at top: 8 (line spec default), legend
  // text + marker ~14px tall, plus ~14px breathing room before the
  // plot starts → grid.top: 36. Earlier 24 caused the top series
  // line to brush against the legend text at narrow panel heights.
  const gridTop = legend?.top != null ? 36 : 10;
  const option = {
    backgroundColor: 'transparent',
    tooltip,
    grid: { top: gridTop, left: 50, right: 20, bottom: opts.chartShowZoomSlider ? 50 : 30, containLabel: true },
    xAxis,
    yAxis,
    series,
  };

  if (legend) option.legend = legend;
  if (visualMap) option.visualMap = visualMap;

  if (opts.chartShowZoomSlider) {
    option.dataZoom = [
      {
        type: 'slider', show: true, xAxisIndex: [0], start: 70, end: 100,
        bottom: 8, height: 24,
        backgroundColor: '#262626',
        dataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.3 } },
        selectedDataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.6 } },
        handleStyle: { color: '#0f62fe' },
        textStyle: { color: '#c6c6c6' },
      },
      { type: 'inside', xAxisIndex: [0], start: 70, end: 100 },
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
