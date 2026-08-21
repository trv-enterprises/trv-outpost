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
      // Band model: entry 0 is the BASE (color only, no line). Lines
      // are drawn for the real thresholds that follow.
      yThresholds: [
        { value: 0, color: '#24a148' },
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
  // The BASE gets no boundary line — a line at the base value would
  // imply a threshold the author never set.
  check('case 6: no markLine at the base value', !opt.series[0].markLine.data.some((d) => d.yAxis === 0));
}

// --- Case 7: thresholds in color_segments mode (visualMap) ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {
      yThresholds: [
        { value: 0, color: '#24a148' },
        { value: 70, color: '#f1c21b' },
        { value: 90, color: '#da1e28' },
      ],
      yThresholdRenderMode: 'color_segments',
    },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 7: visualMap present, piecewise', opt.visualMap?.type === 'piecewise');
  check('case 7: 3 pieces (base, mid, top)', opt.visualMap?.pieces?.length === 3);
  // THE BAND MODEL: each band takes the color of the threshold that
  // STARTS it, not the one that ends it. Getting this backwards shifted
  // every band by one entry — the original bug this test now pins.
  check('case 7: base band is the base color, capped at the first threshold',
    opt.visualMap.pieces[0].color === '#24a148' && opt.visualMap.pieces[0].lte === 70);
  check('case 7: 70-90 band takes the 70 threshold color',
    opt.visualMap.pieces[1].gt === 70 && opt.visualMap.pieces[1].lte === 90 && opt.visualMap.pieces[1].color === '#f1c21b');
  check('case 7: above 90 takes the 90 threshold color, open above',
    opt.visualMap.pieces[2].gt === 90 && opt.visualMap.pieces[2].lte === undefined && opt.visualMap.pieces[2].color === '#da1e28');
  check('case 7: no markLine on series', !opt.series[0]?.markLine);
  // REGRESSION GUARD: every piece must carry a FINITE lower bound.
  // ECharts throws "can't access property 'coord', m[0] is undefined" on
  // the FIRST render when a piecewise entry is open-ended below
  // (`gt: -Infinity`, or an `lte`/`max` with no lower bound), so a chart
  // that gained a threshold simply never draws. Verified against
  // echarts 6.1.0 — a finite `gt` renders, -Infinity does not.
  check(
    'case 7: every piece has a finite lower bound (echarts crashes otherwise)',
    opt.visualMap.pieces.every((p) => p.gt === undefined || Number.isFinite(p.gt)),
  );
  check(
    'case 7: no piece is open-ended below',
    opt.visualMap.pieces.every((p) => Number.isFinite(p.gt) || Number.isFinite(p.min)),
  );
}

// --- Case 7b: 'both' mode emits markLine AND a finite-bounded visualMap ---
// The failing prod config (#271): a single threshold with renderMode 'both'.
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {
      yThresholds: [
        { value: 0, color: '#24a148' },
        { value: 24.3, color: '#f1c21b', label: '' },
      ],
      yThresholdRenderMode: 'both',
    },
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line' });
  check('case 7b: markLine present', !!opt.series[0]?.markLine);
  check('case 7b: visualMap present', opt.visualMap?.type === 'piecewise');
  check(
    'case 7b: lowest piece lower bound is finite',
    Number.isFinite(opt.visualMap.pieces[0].gt),
  );
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

  // Tooltip values abbreviate too (the hover readout follows the toggle);
  // small values keep raw precision.
  const ttFmt = opt.tooltip?.formatter;
  check('case 20: tooltip formatter exists', typeof ttFmt === 'function');
  const ttLine = ttFmt && ttFmt([{ axisValueLabel: '7/7, 5:00 AM', seriesName: 'avg', value: 49791.98888888889 }]);
  check('case 20: tooltip 49791.988… → 49.8k', typeof ttLine === 'string' && ttLine.includes('49.8k'));
  const ttSmall = ttFmt && ttFmt([{ axisValueLabel: 'x', seriesName: 's', value: 42.5 }]);
  check('case 20: tooltip small value passes through', typeof ttSmall === 'string' && ttSmall.includes('42.5'));
  // Sub-1k float noise → 3 significant digits (43.96111111111125 → 44),
  // unless the user pinned explicit tooltip decimals, which win below 1k.
  const ttNoise = ttFmt && ttFmt([{ axisValueLabel: 'x', seriesName: 'avg', value: 43.96111111111125 }]);
  check('case 20: tooltip sub-1k noise → 3 sig digits (44)', typeof ttNoise === 'string' && /avg: 44(<|$)/.test(ttNoise));
  const withDecimals = buildOption(
    { ...values, options: { tooltip: { decimals: 2 } } },
    bigData,
    { formatCellValue: fmt, chartType: 'line' },
  ).tooltip.formatter([{ axisValueLabel: 'x', seriesName: 'avg', value: 43.96111111111125 }]);
  check('case 20: explicit decimals win below 1k (43.96)', withDecimals.includes('43.96'));

  // Toggle OFF → no formatters, ticks untouched.
  const off = buildOption(
    { ...values, options: { chartShowDataLabels: true, chartSiPrefixes: false } },
    bigData,
    { formatCellValue: fmt, chartType: 'line' },
  );
  check('case 20: chartSiPrefixes:false → no y-axis formatter', off.yAxis?.axisLabel?.formatter === undefined);
  check('case 20: chartSiPrefixes:false → no data-label formatter', off.series?.[0]?.label?.formatter === undefined);
  const offTt = off.tooltip?.formatter?.([{ axisValueLabel: 'x', seriesName: 's', value: 49791.98888888889 }]);
  check('case 20: chartSiPrefixes:false → tooltip raw value', typeof offTt === 'string' && offTt.includes('49791.98888888889'));

  // Small-valued axis → no formatter even with SI on (nothing to abbreviate).
  const small = buildOption(
    { data_mapping: { x_axis: 'ts', y_axis: [{ column: 'bytes' }] }, options: {} },
    { columns: ['ts', 'bytes'], rows: [[1, 12], [2, 900]] },
    { formatCellValue: fmt, chartType: 'line' },
  );
  check('case 20: values under 1k → no formatter attached', small.yAxis?.axisLabel?.formatter === undefined);
}

// --- Case 21: Y-axis names (Series/axis-label split) ---
{
  // Single-axis: explicit data_mapping.y_axis_label renders as yAxis.name.
  const single = buildOption(
    { data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu' }], y_axis_label: 'Utilization (%)' }, options: {} },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 21: single-axis yAxis.name from y_axis_label', single.yAxis?.name === 'Utilization (%)');
  check('case 21: single-axis nameLocation middle', single.yAxis?.nameLocation === 'middle');

  // Single-axis, no label → no name key forced on.
  const bare = buildOption(
    { data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu' }] }, options: {} },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 21: no y_axis_label → no yAxis.name', bare.yAxis?.name === undefined);

  // Dual-axis: NO axis names at all — the legend + axis colors identify
  // each side; a name would duplicate the series label. The explicit
  // y_axis_label is ignored too.
  const dual = buildOption(
    {
      data_mapping: {
        x_axis: 'ts',
        multiple_y_axis: true,
        y_axis: [{ column: 'cpu', label: 'CPU %', axis: 'left' }, { column: 'mem', axis: 'right' }],
        y_axis_label: 'SHOULD NOT RENDER',
      },
      options: {},
    },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 21: dual left axis has no name', dual.yAxis?.[0]?.name === undefined);
  check('case 21: dual right axis has no name', dual.yAxis?.[1]?.name === undefined);
}

// --- Case 22: bar orientation + bar width (bar shares this buildOption) ---
{
  const barData = { columns: ['region', 'sales'], rows: [['NA', 10], ['EU', 20]] };
  const dm = { x_axis: 'region', y_axis: [{ column: 'sales' }] };

  const vertical = buildOption({ data_mapping: dm, options: {} }, barData, { formatCellValue, chartType: 'bar' });
  check('case 22: vertical bar keeps category x-axis', vertical.xAxis?.type === 'category');
  check('case 22: no barWidth without barWidthPct', vertical.series?.[0]?.barWidth === undefined);

  const horizontal = buildOption(
    { data_mapping: dm, options: { barOrientation: 'horizontal', barWidthPct: 60 } },
    barData,
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: horizontal swaps category axis to y', horizontal.yAxis?.type === 'category');
  check('case 22: horizontal value axis on x', horizontal.xAxis?.type !== 'category');
  check('case 22: barWidthPct → series barWidth percent', horizontal.series?.[0]?.barWidth === '60%');
  check('case 22: horizontal categories read top-down', horizontal.yAxis?.inverse === true);

  // Force EVERY category label (interval:0) so no container name is ever
  // silently dropped — ECharts' default thins category labels it predicts
  // would collide. Fixed font (ECharts default); a too-short panel crowds,
  // the user makes it taller. Must NOT pin lineHeight (mis-centers labels,
  // drift walks down the axis).
  const dense = buildOption(
    {
      data_mapping: { x_axis: 'name', y_axis: [{ column: 'v' }] },
      options: { barOrientation: 'horizontal' },
    },
    { columns: ['name', 'v'], rows: Array.from({ length: 9 }, (_, i) => [`container-${i}`, i]) },
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: horizontal forces every label (interval:0)', dense.yAxis?.axisLabel?.interval === 0);
  check('case 22: horizontal uses default label font (no override)', dense.yAxis?.axisLabel?.fontSize === undefined);
  check('case 22: horizontal never pins lineHeight', dense.yAxis?.axisLabel?.lineHeight === undefined);

  // An authored x-label rotation must NOT ride to the side axis — rotated
  // side labels overlap and read worse than plain horizontal ones.
  const rotated = buildOption(
    { data_mapping: dm, options: { barOrientation: 'horizontal', xAxisLabelRotate: 45 } },
    barData,
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: horizontal drops x-label rotation on side axis', rotated.yAxis?.axisLabel?.rotate === undefined);

  // Thresholds ride the value axis: markLine yAxis→xAxis under horizontal.
  const thresholds = buildOption(
    // Needs a base + a real threshold: under the band model a lone entry
    // IS the base, which has no boundary line to re-key.
    { data_mapping: dm, options: { barOrientation: 'horizontal', yThresholds: [{ value: 0, color: '#0f0' }, { value: 15, color: '#f00' }] } },
    barData,
    { formatCellValue, chartType: 'bar' },
  );
  const ml = thresholds.series?.[0]?.markLine?.data?.[0];
  check('case 22: horizontal threshold markLine keys on xAxis', ml?.xAxis === 15 && ml?.yAxis === undefined);

  // Zoom slider pans categories — vertical strip on the right.
  const zoomed = buildOption(
    { data_mapping: dm, options: { barOrientation: 'horizontal', chartShowZoomSlider: true } },
    barData,
    { formatCellValue, chartType: 'bar' },
  );
  const slider = (zoomed.dataZoom || []).find((z) => z.type === 'slider');
  check('case 22: horizontal slider keys on yAxisIndex', Array.isArray(slider?.yAxisIndex));
  check('case 22: horizontal slider stands on the right', slider?.right === 8 && slider?.xAxisIndex === undefined);

  // Dual-axis bars ignore the horizontal request (no horizontal analog).
  const dualBar = buildOption(
    {
      data_mapping: { x_axis: 'region', multiple_y_axis: true, y_axis: [{ column: 'sales', axis: 'left' }, { column: 'sales', axis: 'right' }] },
      options: { barOrientation: 'horizontal' },
    },
    barData,
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: dual-axis bar stays vertical', dualBar.xAxis?.type === 'category');

  // Blank/null category rows on a non-pivot bar chart coalesce into ONE
  // "BLANK" category (values summed) rather than leaving empty axis slots
  // (the "dead space at the bottom" bug). Real categories are untouched.
  const withBlanks = {
    columns: ['name', 'cpu'],
    rows: [['a', 1], ['b', 2], [null, 3], ['', 4], ['c', 5]],
  };
  const barBlanks = buildOption(
    { data_mapping: { x_axis: 'name', y_axis: [{ column: 'cpu' }] }, options: {} },
    withBlanks,
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: bar coalesces blanks to one BLANK slot', barBlanks.xAxis?.data?.length === 4);
  check('case 22: bar BLANK category labeled', JSON.stringify(barBlanks.xAxis?.data) === JSON.stringify(['a', 'b', 'BLANK', 'c']));
  check('case 22: bar sums BLANK values, keeps reals', JSON.stringify(barBlanks.series?.[0]?.data) === JSON.stringify([1, 2, 7, 5]));

  // Duplicate real categories collapse and sum too.
  const dupCats = buildOption(
    { data_mapping: { x_axis: 'name', y_axis: [{ column: 'cpu' }] }, options: {} },
    { columns: ['name', 'cpu'], rows: [['a', 1], ['a', 4], ['b', 2]] },
    { formatCellValue, chartType: 'bar' },
  );
  check('case 22: bar collapses duplicate categories', JSON.stringify(dupCats.xAxis?.data) === JSON.stringify(['a', 'b']));
  check('case 22: bar sums duplicate category values', JSON.stringify(dupCats.series?.[0]?.data) === JSON.stringify([5, 2]));

  // A line chart is untouched (its x is a continuum; a gap is meaningful).
  const lineBlanks = buildOption(
    { data_mapping: { x_axis: 'name', y_axis: [{ column: 'cpu' }] }, options: {} },
    withBlanks,
    { formatCellValue, chartType: 'line' },
  );
  check('case 22: line keeps blank-category rows', lineBlanks.xAxis?.data?.length === 5);

  // Line charts never react to the bar-only options.
  const lineChart = buildOption(
    { data_mapping: dm, options: { barOrientation: 'horizontal', barWidthPct: 60 } },
    barData,
    { formatCellValue, chartType: 'line' },
  );
  check('case 22: line ignores bar orientation', lineChart.xAxis?.type === 'category');
  check('case 22: line ignores barWidthPct', lineChart.series?.[0]?.barWidth === undefined);
}

// --- Case 7c: the band model, pinned ---
// Regression guard for the off-by-one that shipped before: bands took the
// color of the threshold that ENDED them, so base=green/24=yellow/30=red
// painted 0-24 yellow and 24-30 red — every band shifted one entry, and a
// stray boundary line was drawn at the base value.
{
  const dm = { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] };
  const thr = [
    { value: 0, color: '#24a148' },   // base
    { value: 24, color: '#f1c21b' },  // warn
    { value: 30, color: '#da1e28' },  // crit
  ];
  const opt = buildOption(
    { data_mapping: dm, options: { yThresholds: thr, yThresholdRenderMode: 'both' } },
    data,
    { formatCellValue, chartType: 'line' },
  );
  const p = opt.visualMap.pieces;
  check('case 7c: base band green, capped at the first threshold', p[0].color === '#24a148' && p[0].lte === 24);
  check('case 7c: 24-30 is the 24 threshold color', p[1].gt === 24 && p[1].lte === 30 && p[1].color === '#f1c21b');
  check('case 7c: above 30 is the 30 threshold color', p[2].gt === 30 && p[2].color === '#da1e28');
  const lines = opt.series[0].markLine.data.map((d) => d.yAxis);
  check('case 7c: boundary lines only at real thresholds', lines.length === 2 && lines.includes(24) && lines.includes(30));
  check('case 7c: no boundary line at the base', !lines.includes(0));

  // The base's VALUE is meaningless — only its color is used. The editor
  // hides the input for this reason; the renderer must agree.
  const nonsenseBase = buildOption(
    { data_mapping: dm, options: { yThresholds: [{ value: 9999, color: '#24a148' }, { value: 24, color: '#f1c21b' }], yThresholdRenderMode: 'both' } },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 7c: base value is ignored, not sorted on',
    nonsenseBase.visualMap.pieces[0].color === '#24a148' && nonsenseBase.visualMap.pieces[0].lte === 24);

  // Degenerate: a lone base is a uniform color with nothing to divide.
  const baseOnly = buildOption(
    { data_mapping: dm, options: { yThresholds: [{ value: 0, color: '#24a148' }], yThresholdRenderMode: 'both' } },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 7c: lone base = one uniform band', baseOnly.visualMap.pieces.length === 1 && baseOnly.visualMap.pieces[0].lte === undefined);
  check('case 7c: lone base draws no lines', !baseOnly.series[0]?.markLine);

  // Out-of-order input must still produce ascending bands.
  const unsorted = buildOption(
    { data_mapping: dm, options: { yThresholds: [{ value: 0, color: '#24a148' }, { value: 30, color: '#da1e28' }, { value: 24, color: '#f1c21b' }], yThresholdRenderMode: 'color_segments' } },
    data,
    { formatCellValue, chartType: 'line' },
  );
  check('case 7c: unsorted input sorts into ascending bands',
    unsorted.visualMap.pieces[1].gt === 24 && unsorted.visualMap.pieces[2].gt === 30);
}

// --- Case 7d: thresholds are single-axis only ---
// On a dual-axis chart a threshold value has no unambiguous meaning. The
// boundary line can only attach to ONE axis (it lands on series 0's), and
// the visualMap carries no seriesIndex, so it recolors EVERY series by the
// same y-values — a right-axis series in a different magnitude (bytes
// against a 0-100 percentage) gets painted one permanent color. The editor
// hides the fields; the renderer drops them too, so a chart already SAVED
// with both stops rendering wrong bands without waiting to be re-saved.
{
  const thr = [
    { value: 0, color: '#24a148' },
    { value: 24, color: '#f1c21b' },
  ];
  const dm = (dual) => ({
    x_axis: 'ts',
    y_axis: [
      { column: 'cpu', stack: false, axis: 'left' },
      { column: 'mem', stack: false, axis: dual ? 'right' : 'left' },
    ],
    multiple_y_axis: dual,
  });
  const opts = { yThresholds: thr, yThresholdRenderMode: 'both' };

  const single = buildOption({ data_mapping: dm(false), options: opts }, data, { formatCellValue, chartType: 'line' });
  check('case 7d: single axis still gets threshold lines', !!single.series[0]?.markLine);
  check('case 7d: single axis still gets colour bands', !!single.visualMap);

  const dual = buildOption({ data_mapping: dm(true), options: opts }, data, { formatCellValue, chartType: 'line' });
  check('case 7d: dual axis drops threshold lines', !dual.series[0]?.markLine);
  check('case 7d: dual axis drops the visualMap (would recolour BOTH series)', !dual.visualMap);
  check('case 7d: dual axis still renders its series', dual.series?.length === 2 && dual.series[1]?.yAxisIndex === 1);
}

// --- Case 8: per-series unit conversion (#265) ---
// The load-bearing claim of the feature is that conversion happens on the
// DATA, not at format time — so the plotted geometry, the axis, thresholds
// and the tooltip all agree. These checks pin that: if someone ever moves
// the conversion into a formatter, series.data stays in Celsius and the
// first assertion fails.
{
  const dm = (convert) => ({
    x_axis: 'ts',
    y_axis: [{ column: 'cpu', stack: false, axis: 'left', convert }],
  });
  const c2f = { dimension: 'temperature', from: 'c', to: 'f' };

  const converted = buildOption({ data_mapping: dm(c2f), options: {} }, data, { formatCellValue, chartType: 'line' });
  // cpu column is [12, 18, 22, 19, 25] → °F
  check('case 8: series DATA is converted, not just the label',
    JSON.stringify(converted.series[0].data.map((v) => Math.round(v * 100) / 100))
      === JSON.stringify([53.6, 64.4, 71.6, 66.2, 77]),
    JSON.stringify(converted.series[0].data));

  // No conversion → untouched, byte-for-byte the raw column.
  const plain = buildOption({ data_mapping: dm(null), options: {} }, data, { formatCellValue, chartType: 'line' });
  check('case 8: absent conversion leaves data untouched',
    JSON.stringify(plain.series[0].data) === JSON.stringify([12, 18, 22, 19, 25]));

  // An identity pair (from === to) must be treated as unconfigured.
  const ident = buildOption(
    { data_mapping: dm({ dimension: 'temperature', from: 'c', to: 'c' }), options: {} },
    data, { formatCellValue, chartType: 'line' });
  check('case 8: identity conversion is a no-op',
    JSON.stringify(ident.series[0].data) === JSON.stringify([12, 18, 22, 19, 25]));

  // Parallel-array wire shape (y_axis is a string array, per-column
  // settings ride alongside) must behave identically to the inline form.
  const viaArray = buildOption({
    data_mapping: { x_axis: 'ts', y_axis: ['cpu'], y_axis_conversions: [c2f] },
    options: {},
  }, data, { formatCellValue, chartType: 'line' });
  check('case 8: y_axis_conversions parallel array matches the inline shape',
    JSON.stringify(viaArray.series[0].data) === JSON.stringify(converted.series[0].data));

  // Auto unit label: one shared target symbol and no author-set unit →
  // the tooltip adopts it.
  check('case 8: single shared target unit auto-labels the tooltip',
    typeof converted.tooltip?.formatter === 'function'
      && converted.tooltip.formatter([{ value: 53.6, seriesName: 'cpu', axisValueLabel: 'x' }]).includes('°F'));

  // An explicit author unit always wins — never overwrite typed text.
  const authored = buildOption(
    { data_mapping: dm(c2f), options: { tooltip: { units: 'degrees' } } },
    data, { formatCellValue, chartType: 'line' });
  check('case 8: an explicit tooltip unit is not overwritten',
    authored.tooltip.formatter([{ value: 53.6, seriesName: 'cpu', axisValueLabel: 'x' }]).includes('degrees'));

  // MIXED target units (legit on a dual axis) → no single honest label,
  // so the tooltip must be left alone rather than guessing one of them.
  const mixed = buildOption({
    data_mapping: {
      x_axis: 'ts',
      y_axis: [
        { column: 'cpu', axis: 'left', convert: c2f },
        { column: 'mem', axis: 'right', convert: { dimension: 'pressure', from: 'pa', to: 'psi' } },
      ],
      multiple_y_axis: true,
    },
    options: {},
  }, data, { formatCellValue, chartType: 'line' });
  const mixedOut = mixed.tooltip.formatter([{ value: 1, seriesName: 'cpu', axisValueLabel: 'x' }]);
  check('case 8: mixed target units leave the tooltip unlabelled',
    !mixedOut.includes('°F') && !mixedOut.includes('psi'), mixedOut);

  // Convert BEFORE accumulate: for an affine unit the delta must be taken
  // in the DISPLAY unit. The first cpu delta is 18-12 = 6 °C, which is a
  // 10.8 °F change — NOT 6*1.8+32. Getting the order wrong (delta first,
  // then convert) would yield 42.8 here, so this pins the ordering.
  const deltaF = buildOption({
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', axis: 'left', convert: c2f, accumulate: true }] },
    options: {},
  }, data, { formatCellValue, chartType: 'line' });
  const d1 = deltaF.series[0].data[1];
  check('case 8: conversion runs BEFORE the accumulator (affine-safe delta)',
    Math.abs(d1 - 10.8) < 1e-9, `got ${d1}`);
}

// --- Case 9: inline per-entry accumulate (#8 regression guard) ---
// normalizeYEntry used to drop `e.accumulate`, so the parallel-array merge
// always overwrote it. Object-form entries are exactly what the EDITOR
// PREVIEW emits, so ticking Δ Delta appeared to do nothing until the chart
// was saved and reloaded in the parallel-array shape. Both shapes must agree.
{
  const f = (v) => String(v ?? '');
  const inline = buildOption({
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', axis: 'left', accumulate: true }] },
    options: {},
  }, data, { formatCellValue: f, chartType: 'line' });
  const viaArray = buildOption({
    data_mapping: { x_axis: 'ts', y_axis: ['cpu'], accumulator_columns: [true] },
    options: {},
  }, data, { formatCellValue: f, chartType: 'line' });
  check('case 9: inline accumulate matches the parallel-array shape',
    JSON.stringify(inline.series[0].data) === JSON.stringify(viaArray.series[0].data),
    `inline=${JSON.stringify(inline.series[0].data)} array=${JSON.stringify(viaArray.series[0].data)}`);
  check('case 9: inline accumulate actually deltas',
    JSON.stringify(inline.series[0].data) !== JSON.stringify([12, 18, 22, 19, 25]));
  // An explicit `accumulate: false` must WIN over the parallel array, not
  // be treated as "unset" and silently overridden.
  const off = buildOption({
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', axis: 'left', accumulate: false }], accumulator_columns: [true] },
    options: {},
  }, data, { formatCellValue: f, chartType: 'line' });
  check('case 9: explicit inline accumulate:false overrides the parallel array',
    JSON.stringify(off.series[0].data) === JSON.stringify([12, 18, 22, 19, 25]));
}

// --- Case 10: time-series gaps break the line (#281 interim) ---
// A missing collection interval has NO ROW, so on a category axis ECharts
// joins the neighbours and a multi-hour outage renders as continuous data.
// buildOption splices a null row at each detected gap so the line breaks.
{
  const T0 = Date.parse('2026-08-21T00:00:00Z');
  const at = (min) => new Date(T0 + min * 60000).toISOString();
  const f = (v) => String(v ?? '');
  const dm = { x_axis: 'ts', y_axis: [{ column: 'temp', axis: 'left' }] };
  const mk = (mins, options = {}) => buildOption(
    { data_mapping: dm, options },
    { columns: ['ts', 'temp'], rows: mins.map((m, i) => [at(m), 20 + i]) },
    { formatCellValue: f, chartType: 'line' },
  );

  // 6-minute cadence with a 2-hour hole after the 3rd point.
  const gapped = mk([0, 6, 12, 132, 138, 144]);
  check('case 10: a gap becomes a null, breaking the line',
    JSON.stringify(gapped.series[0].data) === JSON.stringify([20, 21, 22, null, 23, 24, 25]),
    JSON.stringify(gapped.series[0].data));
  check('case 10: the x-axis grows a slot for the gap',
    gapped.xAxis.data.length === 7, String(gapped.xAxis.data.length));

  // Evenly-sampled data must be untouched — no phantom breaks.
  const even = mk([0, 6, 12, 18, 24]);
  check('case 10: an even series is left alone',
    JSON.stringify(even.series[0].data) === JSON.stringify([20, 21, 22, 23, 24]));

  // Jitter must not shred the line.
  const jitter = mk([0, 6.1, 11.9, 18.05, 24]);
  check('case 10: collector jitter does not create gaps',
    !jitter.series[0].data.includes(null));

  // Opt-out.
  const off = mk([0, 6, 12, 132, 138, 144], { showGaps: false });
  check('case 10: showGaps:false disables it',
    !off.series[0].data.includes(null));

  // Explicit interval overrides the inferred median: declaring a 2-hour
  // cadence means the 2-hour hole is NORMAL and must not break.
  const override = mk([0, 6, 12, 132, 138, 144], { gapIntervalSeconds: 7200 });
  check('case 10: gapIntervalSeconds overrides the inferred cadence',
    !override.series[0].data.includes(null),
    JSON.stringify(override.series[0].data));

  // A non-timestamp x-axis has no cadence to infer — must not break.
  const cats = buildOption(
    { data_mapping: dm, options: {} },
    { columns: ['ts', 'temp'], rows: [['alpha', 1], ['bravo', 2], ['charlie', 3]] },
    { formatCellValue: f, chartType: 'line' },
  );
  check('case 10: a categorical x-axis is unaffected',
    !cats.series[0].data.includes(null));
}

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll line buildOption checks passed.\n`);
