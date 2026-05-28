#!/usr/bin/env node
// Smoke-test the Stage 2 line buildOption(values, data, helpers)
// across representative configurations. Asserts the returned ECharts
// option literal has the expected top-level shape — not pixel
// equality, since Stage 2 is render-identical (visual), not byte-
// identical to legacy.
//
// Runs as part of `npm run verify:chart-spec` (chained into build).

import { buildOption } from '../src/chart-spec/specs/line.js';

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
  check('case 3: no forced color on series (uses palette)', opt.series.every((s) => !s?.itemStyle?.color));
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

// --- Case 13: chart title ---
{
  const values = {
    data_mapping: { x_axis: 'ts', y_axis: [{ column: 'cpu', stack: false, axis: 'left' }] },
    options: {},
  };
  const opt = buildOption(values, data, { formatCellValue, chartType: 'line', chartName: 'CPU' });
  check('case 13: title text set when chartName provided', opt.title?.text === 'CPU');
}

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll line buildOption checks passed.\n`);
