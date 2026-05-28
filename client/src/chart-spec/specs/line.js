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
 * Normalize a y_axis entry from any of three shapes into the
 * canonical { column, stack, axis } shape:
 *   - bare string (legacy):  'cpu'        → { column: 'cpu', stack: false, axis: 'left' }
 *   - partial object:        { column: 'cpu' } → same with defaults
 *   - full object (current): { column: 'cpu', stack: true, axis: 'right' }
 *
 * This is the read-path migration shim — legacy line records load
 * cleanly without a Mongo migration.
 */
function normalizeYEntry(e) {
  if (typeof e === 'string') return { column: e, stack: false, axis: 'left' };
  if (!e || typeof e !== 'object') return { column: '', stack: false, axis: 'left' };
  return {
    column: typeof e.column === 'string' ? e.column : '',
    stack: Boolean(e.stack),
    axis: e.axis === 'right' ? 'right' : 'left',
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
    series.yAxisIndex = entry.axis === 'right' ? 1 : 0;
    series.itemStyle = { color: entry.axis === 'right' ? RIGHT_AXIS_COLOR : LEFT_AXIS_COLOR };
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
function buildTooltip(tt, ctx) {
  if (!tt || tt.mode === 'hidden') return { show: false };
  const block = { trigger: tt.mode === 'single' ? 'item' : 'axis' };

  if (tt.format === 'custom' && tt.customFormatter && tt.customFormatter.trim()) {
    // Custom formatter: a JS expression body. The shell evaluates
    // it via new Function('params', body) → string. Returned as a
    // string here so the option literal stays JSON-serializable;
    // the shell post-processes it into a real function before
    // handing the option to ECharts.
    block.formatter = { __raw: 'custom', body: tt.customFormatter };
    return block;
  }

  // Auto / units / decimals path. Build a stable formatter helper.
  const decimals = tt.decimals == null ? null : Number(tt.decimals);
  const units = tt.units || '';
  const fmt = (val) => {
    if (val == null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val);
    const str = decimals == null ? String(num) : num.toFixed(decimals);
    return units ? `${str} ${units}` : str;
  };
  block.formatter = { __raw: 'auto', decimals, units };
  // Stash the resolved auto-formatter on the block so the shell can
  // attach it without re-deriving. The shell sees __raw and replaces.
  ctx.tooltipAutoFormatter = fmt;
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
    case 'bottom': block.bottom = 8; break;
    case 'left':   block.left = 8; block.orient = 'vertical'; break;
    case 'right':  block.right = 8; block.orient = 'vertical'; break;
    case 'top':
    default:       block.top = 8; break;
  }
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
  const { formatCellValue, chartType = 'line', xAxisFormat = 'chart', chartName = '' } = helpers;
  const ctx = {};

  const rawYAxis = Array.isArray(values?.data_mapping?.y_axis) ? values.data_mapping.y_axis : [];
  const yEntries = rawYAxis.map(normalizeYEntry).filter((e) => e.column);
  const dualAxis = Boolean(values?.data_mapping?.multiple_y_axis);
  const xAxisCol = values?.data_mapping?.x_axis || '';
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
      seriesName: entry.column,
    }));
  }

  const tooltip = buildTooltip(opts.tooltip || {}, ctx);
  const legend = buildLegend(opts.legend || {}, dualAxis, series.length > 1);

  const { markLine, visualMap } = buildThresholds(opts.yThresholds, opts.yThresholdRenderMode);
  if (markLine) {
    // Attach to the first series so the marker overlays exist exactly once.
    if (series[0]) series[0] = { ...series[0], markLine };
  }

  const yAxis = buildYAxisDefs(dualAxis, opts.yAxisRange);

  const option = {
    backgroundColor: 'transparent',
    tooltip,
    grid: { top: legend?.top != null ? 35 : 10, left: 50, right: 20, bottom: opts.chartShowZoomSlider ? 50 : 30, containLabel: true },
    xAxis: { type: 'category', data: categories },
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

  if (chartName) {
    option.title = {
      text: chartName,
      left: 'center',
      top: 0,
      textStyle: { color: '#f4f4f4', fontSize: 16 },
    };
    // Push grid down to make room.
    option.grid.top = (option.grid.top || 10) + 28;
  }

  // Stash the resolved tooltip auto-formatter so the shell can hook
  // it into the option (the {__raw:'auto'} marker tells the shell to
  // replace `tooltip.formatter` with the function form).
  if (ctx.tooltipAutoFormatter && option.tooltip && option.tooltip.formatter && option.tooltip.formatter.__raw === 'auto') {
    option.tooltip.formatter = (params) => {
      const arr = Array.isArray(params) ? params : [params];
      const parts = arr.map((p) => `${p.marker || ''}${p.seriesName ? p.seriesName + ': ' : ''}${ctx.tooltipAutoFormatter(p.value)}`);
      const header = arr[0]?.axisValueLabel || arr[0]?.name || '';
      return [header, ...parts].filter(Boolean).join('<br/>');
    };
  }

  return option;
}
