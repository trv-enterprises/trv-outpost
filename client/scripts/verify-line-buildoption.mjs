#!/usr/bin/env node
// Smoke-test the Stage 2 line buildOption(values, data, helpers)
// across representative configurations. Asserts the returned ECharts
// option literal has the expected top-level shape — not pixel
// equality, since Stage 2 is render-identical (visual), not byte-
// identical to legacy.
//
// Runs as part of `npm run verify:chart-spec` (chained into build).

import { buildOption } from '../src/chart-spec/specs/line.js';
import { paletteForCount } from '../src/chart-spec/option-helpers.js';

// Resolve categorical colors from the active-theme palette (config/theme.js)
// so these assertions follow a theme switch instead of pinning Light-theme hex.
// Count-aware combos: multi-series charts color by the curated Carbon
// combination for the series-count (paletteForCount), NOT raw palette index.
// These resolve through the same code the renderer uses, so they track the
// active theme + the deployment's preferred-option default.
const PAIR2 = paletteForCount(2); // 2-series combo
const PAIR3 = paletteForCount(3); // 3-series combo

const FAILURES = [];

function check(label, cond, detail = '') {
  if (!cond) {
    FAILURES.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    process.stdout.write(`✓ ${label}\n`);
  }
}

// Minimal pass-through formatCellValue so the helper signature works.
const formatCellValue = (val) => String(val ?? '');

// Representative data: 5 rows × 3 columns (ts + cpu + mem).
const data = {
  columns: ['ts', 'cpu', 'mem'],
  rows: [
    [1700000000000, 12, 30],
    [1700000060000, 18, 28],
    [1700000120000, 22, 33],
    [1700000180000, 19, 35],
    [1700000240000, 25, 31],
  ],
};

// --- Case 1: single y, single axis, no extras (baseline) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 1: returns an option object', opt && typeof opt === 'object');
  check('case 1: backgroundColor transparent', opt.backgroundColor === 'transparent');
  check('case 1: xAxis is category', opt.xAxis?.type === 'category');
  check('case 1: yAxis is a single value object (not array)', !Array.isArray(opt.yAxis) && opt.yAxis?.type === 'value');
  check('case 1: one series', opt.series?.length === 1);
  check('case 1: series.type === line', opt.series[0]?.type === 'line');
  check('case 1: single-axis single-column gets Carbon blue', opt.series[0]?.itemStyle?.color === '#0f62fe');
  check('case 1: no stack on series', !opt.series[0]?.stack);
  check('case 1: no zoom slider', !opt.dataZoom);
}

// --- Case 2: dual axis, 2 columns ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      multiple_y_axis: true,
      y_axis: [
        { column: 'cpu', stack: false, axis: 'left' },
        { column: 'mem', stack: false, axis: 'right' },
      ],
    },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 2: yAxis is an array of 2', Array.isArray(opt.yAxis) && opt.yAxis.length === 2);
  check('case 2: left axis blue', opt.yAxis[0]?.axisLabel?.color === '#0f62fe');
  check('case 2: right axis purple', opt.yAxis[1]?.axisLabel?.color === '#8a3ffc');
  check('case 2: two series', opt.series?.length === 2);
  check('case 2: series 0 → yAxisIndex 0', opt.series[0]?.yAxisIndex === 0);
  check('case 2: series 1 → yAxisIndex 1', opt.series[1]?.yAxisIndex === 1);
  check('case 2: series 0 blue', opt.series[0]?.itemStyle?.color === '#0f62fe');
  check('case 2: series 1 purple', opt.series[1]?.itemStyle?.color === '#8a3ffc');
}

// --- Case 3: N-series single axis (3 cols, no dual) ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      y_axis: [
        { column: 'cpu', stack: false, axis: 'left' },
        { column: 'mem', stack: false, axis: 'left' },
        { column: 'cpu', stack: false, axis: 'left' }, // dup just for shape
      ],
    },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 3: yAxis stays single (not array)', !Array.isArray(opt.yAxis));
  check('case 3: three series', opt.series?.length === 3);
  // Multi-series single-axis walks the active-theme Carbon categorical
  // palette by index (config/theme.js) — on-brand and distinct, not the
  // ECharts default and not all-unset.
  check('case 3: series 0 count-aware combo [0]', opt.series[0]?.itemStyle?.color === PAIR3[0]);
  check('case 3: series 1 count-aware combo [1]', opt.series[1]?.itemStyle?.color === PAIR3[1]);
  check('case 3: series 2 count-aware combo [2]', opt.series[2]?.itemStyle?.color === PAIR3[2]);
}

// --- Case 4: stacked subset (3 cols, two stacked, one not) ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      y_axis: [
        { column: 'cpu', stack: true, axis: 'left' },
        { column: 'mem', stack: true, axis: 'left' },
        { column: 'cpu', stack: false, axis: 'left' }, // the "high-water" total
      ],
    },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 4: first two series share a stack group', opt.series[0]?.stack && opt.series[0]?.stack === opt.series[1]?.stack);
  check('case 4: third series has no stack', !opt.series[2]?.stack);
}

// --- Case 5: y range, log scale, zoom slider, smooth off ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {
      yAxisRange: { left: { min: 0, max: 100, scale: 'log' } },
      chartShowZoomSlider: true,
      chartSmooth: false,
      showSymbol: false,
    },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 5: yAxis type log', opt.yAxis?.type === 'log');
  check('case 5: yAxis min 0', opt.yAxis?.min === 0);
  check('case 5: yAxis max 100', opt.yAxis?.max === 100);
  check('case 5: dataZoom present', Array.isArray(opt.dataZoom) && opt.dataZoom.length === 2);
  check('case 5: showSymbol off', opt.series[0]?.showSymbol === false);
  check('case 5: smooth off (no smooth key set)', !opt.series[0]?.smooth);
}

// --- Case 6: thresholds in line mode (markLine) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {
      yThresholds: [
        { value: 70, color: '#f1c21b', label: 'Warning' },
        { value: 90, color: '#da1e28' },
      ],
      yThresholdRenderMode: 'line',
    },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 6: markLine on series[0]', opt.series[0]?.markLine?.data?.length === 2);
  check('case 6: no visualMap', !opt.visualMap);
  check('case 6: threshold 70 yellow', opt.series[0].markLine.data[0]?.yAxis === 70 && opt.series[0].markLine.data[0]?.lineStyle?.color === '#f1c21b');
}

// --- Case 7: thresholds in color_segments mode (visualMap) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {
      yThresholds: [{ value: 70, color: '#f1c21b' }, { value: 90, color: '#da1e28' }],
      yThresholdRenderMode: 'color_segments',
    },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 7: visualMap present, piecewise', opt.visualMap?.type === 'piecewise');
  check('case 7: 3 pieces (below first, between, above last)', opt.visualMap?.pieces?.length === 3);
  check('case 7: no markLine on series', !opt.series[0]?.markLine);
}

// --- Case 8: tooltip hidden ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: { tooltip: { mode: 'hidden' } },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 8: tooltip disabled', opt.tooltip?.show === false);
}

// --- Case 8b: tooltip formatter is a real function (decimals + units) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: { tooltip: { decimals: 2, units: '%' } },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 8b: tooltip.formatter is a function', typeof opt.tooltip?.formatter === 'function');
  // Smoke-test the formatter: feed it a single ECharts-like param.
  const out = opt.tooltip.formatter([{ value: 12.345, seriesName: 'cpu', marker: '●', axisValueLabel: 't1' }]);
  check('case 8b: formatter applies decimals + units', typeof out === 'string' && out.includes('12.35') && out.includes('%'));
}

// --- Case 9: tooltip single mode ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: { tooltip: { mode: 'single' } },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 9: tooltip trigger item', opt.tooltip?.trigger === 'item');
}

// --- Case 10: legend off via explicit show=false even with multi-series ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      y_axis: [
        { column: 'cpu', stack: false, axis: 'left' },
        { column: 'mem', stack: false, axis: 'left' },
      ],
    },
    options: { legend: { show: false } },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 10: legend suppressed by show:false', !opt.legend);
}

// --- Case 11: pivot column (series partitioning) ---
{
  const pivotData = {
    columns: ['ts', 'site', 'value'],
    rows: [
      [1, 'A', 10],
      [1, 'B', 20],
      [2, 'A', 12],
      [2, 'B', 22],
    ],
  };
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'value', stack: false, axis: 'left' }], series: 'site' },
    options: {},
  };
  const opt = buildOption(values, pivotData, { formatCellValue, chartType: 'line' });
  check('case 11: pivot creates one series per distinct value', opt.series?.length === 2);
  check('case 11: series named after pivot values', opt.series[0]?.name === 'A' && opt.series[1]?.name === 'B');
  // Pivot series get colors from the count-aware combo assigned by PROMINENCE
  // (magnitude rank), not array order — the largest-magnitude series gets
  // combo[0], etc. Here site B (20,22) outweighs A (10,12), so B→combo[0] and
  // A→combo[1]. Regression guard: they previously all shared idx 0 (same
  // color), and they must be DISTINCT colors.
  check('case 11: pivot series A (lesser) count-aware combo [1]', opt.series[0]?.itemStyle?.color === PAIR2[1]);
  check('case 11: pivot series B (greater) count-aware combo [0]', opt.series[1]?.itemStyle?.color === PAIR2[0]);
}

// --- Case 12: area chart type ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'area' });
  check('case 12: area uses ECharts type "line"', opt.series[0]?.type === 'line');
  check('case 12: area has areaStyle', !!opt.series[0]?.areaStyle);
}

// --- Case 13: title is NOT in the option (ChartShell owns it) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line', chartName: 'CPU' });
  // Title renders as an HTML header in ChartShell, outside ECharts —
  // unified across line/bar/area/gauge. buildOption must leave
  // option.title unset so it can't collide with the top legend.
  check('case 13: buildOption does NOT set option.title (ChartShell owns it)', opt.title === undefined);
}

// --- Case 14: per-column label overrides series name ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      y_axis: [
        { column: 'cpu', label: 'CPU %', stack: false, axis: 'left' },
        { column: 'mem', label: '',      stack: false, axis: 'left' },
      ],
    },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 14: series with explicit label uses it', opt.series[0]?.name === 'CPU %');
  check('case 14: series with empty label falls back to column name', opt.series[1]?.name === 'mem');
}

// --- Case 15: x-axis label emits xAxis.name ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      x_axis_label: 'Time',
      y_axis: [{ column: 'cpu', stack: false, axis: 'left' }],
    },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 15: xAxis.name set when x_axis_label provided', opt.xAxis?.name === 'Time');
  check('case 15: xAxis.nameLocation is middle (under-axis placement)', opt.xAxis?.nameLocation === 'middle');
}

// --- Case 16: x_axis_format from values overrides helper default ---
{
  const values = {
    data_mapping: {
      x_axis: 'ts',
      x_axis_format: 'chart_time_seconds',
      y_axis: [{ column: 'cpu', stack: false, axis: 'left' }],
    },
    options: {},
  };
  // Use a formatCellValue that records the format it received.
  let observed = null;
  const recording = (val, col, opts) => { observed = opts?.timestampFormat; return String(val ?? ''); };
  buildOption(values, data, { formatCellValue: recording, chartType: 'line', xAxisFormat: 'chart' /* helper says 'chart' */ });
  check('case 16: values.data_mapping.x_axis_format wins over helper', observed === 'chart_time_seconds');
}

// --- Case 18: x_axis_format "auto" resolves granularity from the data ---
{
  // Realistic formatter: chart_time → HH:MM, *_seconds → HH:MM:SS,
  // chart → M/D HH:MM; non-timestamp values pass through unchanged.
  const p = (n) => String(n).padStart(2, '0');
  const fmt = (val, _col, opts) => {
    const t = typeof val === 'number' ? val : Date.parse(val);
    if (!Number.isFinite(t)) return String(val ?? ''); // passthrough (non-timestamp)
    const d = new Date(t);
    const f = opts?.timestampFormat;
    if (f === 'chart_time_seconds') return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    if (f === 'chart_time') return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (f === 'chart' || f === 'chart_datetime') return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (f === 'chart_datetime_seconds') return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
    return String(val);
  };
  const mk = (rows) => ({ columns: ['ts', 'cpu'], rows });
  const run = (rows) => buildOption(
    { data_mapping: { x_axis: 'ts', x_axis_format: 'auto', y_axis: [{ column: 'cpu' }] }, options: {} },
    mk(rows), { formatCellValue: fmt, chartType: 'line' },
  ).xAxis.data;

  // TODAY's date — the "same-day, recent" path collapses to time-only (the date
  // is obvious in context). resolveAutoXFormat compares LOCAL date components, so
  // build these from the LOCAL calendar day anchored at noon — noon can't cross a
  // day boundary into yesterday/tomorrow in any timezone, so this stays "today"
  // regardless of where/when the test runs. (Building via Date.UTC of the UTC day
  // was the bug: near midnight UTC the UTC day differs from the local day → the
  // "today" timestamp read as not-today and got a date.) Fixed past dates below
  // still correctly read as not-today and get the date.
  const now = new Date();
  const todayLocal = (h, m, s) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, s).getTime();

  // Same-minute (today) → auto adds seconds (HH:MM:SS, all distinct).
  const sameMin = run([
    [todayLocal(12, 6, 5), 1],
    [todayLocal(12, 6, 25), 2],
    [todayLocal(12, 6, 50), 3],
  ]);
  check('case 18: auto + same-minute → seconds', new Set(sameMin).size === 3 && sameMin[0].split(':').length === 3);

  // Minutes apart, same day (today) → time-only (HH:MM), no date, no seconds.
  const minutesApart = run([
    [todayLocal(12, 6, 0), 1],
    [todayLocal(12, 8, 0), 2],
    [todayLocal(12, 10, 0), 3],
  ]);
  check('case 18: auto + minutes-apart → time-only', minutesApart.every((l) => /^\d{1,2}:\d{2}$/.test(l)));

  // Minutes apart but NOT today (old data) → includes the date so it's not
  // ambiguous which day. This is the recency rule the range feature added.
  const oldMinutesApart = run([
    [Date.UTC(2026, 0, 1, 14, 6, 0), 1],
    [Date.UTC(2026, 0, 1, 14, 8, 0), 2],
  ]);
  check('case 18: auto + old minutes-apart → includes date', oldMinutesApart.every((l) => l.includes('/')));

  // Spanning >1 day → includes the date.
  const daysApart = run([
    [Date.UTC(2026, 0, 1, 14, 0, 0), 1],
    [Date.UTC(2026, 0, 3, 14, 0, 0), 2],
  ]);
  check('case 18: auto + multi-day → includes date', daysApart.every((l) => l.includes('/')));

  // Non-timestamp x-axis → passthrough (values shown as-is, untouched).
  const catData = buildOption(
    { data_mapping: { x_axis: 'region', x_axis_format: 'auto', y_axis: [{ column: 'cpu' }] }, options: {} },
    { columns: ['region', 'cpu'], rows: [['us-east', 1], ['us-west', 2]] },
    { formatCellValue: fmt, chartType: 'line' },
  ).xAxis.data;
  check('case 18: auto + non-timestamp → passthrough', catData[0] === 'us-east' && catData[1] === 'us-west');
}

// --- Case 19: per-column accumulator delta transform (#8) ---
{
  const fmt = (v) => String(v ?? '');
  // Monotonic counter with a reset: 10,13,18,30 then resets to 5,9.
  const counterData = {
    columns: ['ts', 'count'],
    rows: [
      [1, 10],
      [2, 13],
      [3, 18],
      [4, 30],
      [5, 5],
      [6, 9],
    ],
  };
  const run = (policy) => buildOption(
    {
      data_mapping: {
        x_axis: 'ts',
        y_axis: [{ column: 'count' }],
        accumulator_columns: [true],
        ...(policy ? { accumulator_reset_policy: policy } : {}),
      },
      options: {},
    },
    counterData,
    { formatCellValue: fmt, chartType: 'line' },
  ).series[0].data;

  // Off: raw values pass through untouched.
  const off = buildOption(
    { data_mapping: { x_axis: 'ts', y_axis: [{ column: 'count' }] }, options: {} },
    counterData,
    { formatCellValue: fmt, chartType: 'line' },
  ).series[0].data;
  check('case 19: accumulator off → raw values', JSON.stringify(off) === JSON.stringify([10, 13, 18, 30, 5, 9]));

  // drop_negative (default): first point null, deltas, reset → null.
  const drop = run();
  check('case 19: drop_negative first point is null', drop[0] === null);
  check('case 19: drop_negative deltas', drop[1] === 3 && drop[2] === 5 && drop[3] === 12);
  check('case 19: drop_negative breaks the line at reset', drop[4] === null);
  check('case 19: drop_negative resumes after reset', drop[5] === 4);

  // clamp_zero: reset emits 0 instead of breaking.
  const clamp = run('clamp_zero');
  check('case 19: clamp_zero emits 0 at reset', clamp[4] === 0);
  check('case 19: clamp_zero keeps normal deltas', clamp[1] === 3 && clamp[5] === 4);

  // keep_negative: reset surfaces the raw negative delta (5 - 30 = -25).
  const keep = run('keep_negative');
  check('case 19: keep_negative surfaces the negative delta', keep[4] === -25);

  // PER-COLUMN: counter + raw on the same chart. Only the flagged column deltas.
  const mixedData = {
    columns: ['ts', 'counter', 'gauge'],
    rows: [
      [1, 100, 50],
      [2, 110, 55],
      [3, 130, 40],
    ],
  };
  const mixed = buildOption(
    {
      data_mapping: {
        x_axis: 'ts',
        y_axis: [{ column: 'counter' }, { column: 'gauge' }],
        accumulator_columns: [true, false],
      },
      options: {},
    },
    mixedData,
    { formatCellValue: fmt, chartType: 'line' },
  ).series;
  check('case 19: per-column — flagged counter deltas', JSON.stringify(mixed[0].data) === JSON.stringify([null, 10, 20]));
  check('case 19: per-column — unflagged gauge stays raw', JSON.stringify(mixed[1].data) === JSON.stringify([50, 55, 40]));

  // Legacy chart-wide accumulator_mode:true → all columns delta (back-compat).
  const legacy = buildOption(
    {
      data_mapping: {
        x_axis: 'ts',
        y_axis: [{ column: 'counter' }, { column: 'gauge' }],
        accumulator_mode: true,
      },
      options: {},
    },
    mixedData,
    { formatCellValue: fmt, chartType: 'line' },
  ).series;
  check('case 19: legacy accumulator_mode → both columns delta', mixed && legacy[0].data[1] === 10 && legacy[1].data[1] === 5);
}

// --- Case 20: SI-prefix axis + data labels (#159) ---
{
  const fmt = (val) => String(val ?? '');
  const bigData = {
    columns: ['ts', 'bytes'],
    rows: [
      [1700000000000, 14340393939],
      [1700000060000, 9200000000],
      [1700000120000, 500000000],
    ],
  };
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'bytes' }] },
    options: { chartShowDataLabels: true },
  };
  const opt = buildOption(values, bigData, { formatCellValue: fmt, chartType: 'line' });
  const axisFmt = opt.yAxis?.axisLabel?.formatter;
  check('case 20: SI default ON → y-axis gets a formatter', typeof axisFmt === 'function');
  check('case 20: 14,340,393,939 → 14.3G', axisFmt && axisFmt(14340393939) === '14.3G');
  check('case 20: shared prefix — 500M renders as 0.5G on the same axis', axisFmt && axisFmt(500000000) === '0.5G');
  check('case 20: round ticks trim zeros (5e9 → 5G)', axisFmt && axisFmt(5000000000) === '5G');
  const lblFmt = opt.series?.[0]?.label?.formatter;
  check('case 20: data labels get per-point SI formatter', typeof lblFmt === 'function');
  check('case 20: data label 14,340,393,939 → 14.3G', lblFmt && lblFmt({ value: 14340393939 }) === '14.3G');
  check('case 20: data label small value passes through', lblFmt && lblFmt({ value: 42.5 }) === '42.5');

  // Toggle OFF → no formatters, ticks untouched.
  const off = buildOption(
    { ...values, options: { chartShowDataLabels: true, chartSiPrefixes: false } },
    bigData,
    { formatCellValue: fmt, chartType: 'line' },
  );
  check('case 20: chartSiPrefixes:false → no y-axis formatter', off.yAxis?.axisLabel?.formatter === undefined);
  check('case 20: chartSiPrefixes:false → no data-label formatter', off.series?.[0]?.label?.formatter === undefined);

  // Small-valued axis → no formatter even with SI on (nothing to abbreviate).
  const small = buildOption(
    { data_mapping: { x_axis: 'ts', y_axis: [{ column: 'bytes' }] }, options: {} },
    { columns: ['ts', 'bytes'], rows: [[1, 12], [2, 900]] },
    { formatCellValue: fmt, chartType: 'line' },
  );
  check('case 20: values under 1k → no formatter attached', small.yAxis?.axisLabel?.formatter === undefined);
}

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll line buildOption checks passed.\n`);
