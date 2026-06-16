#!/usr/bin/env node
// Smoke-test banded_bar buildOption(values, data, helpers) — focuses on
// the Display / Performance / Y-axis-range / Tooltip options that were
// added so the editor's "Chart Options" subpanel actually drives the
// render (previously the renderer ignored everything but bandedBarStyle
// + legend). Asserts each option reaches the ECharts option literal.
//
// Runs as part of `npm run verify:chart-spec` (chained into build).

import { buildOption } from '../src/chart-spec/specs/banded_bar.js';

const FAILURES = [];
function check(label, cond, detail = '') {
  if (!cond) FAILURES.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  else process.stdout.write(`✓ ${label}\n`);
}

const fmt = (val) => String(val ?? '');

// Representative minmaxmean data: ts + mean/min/max columns, 5 rows.
const data = {
  columns: ['ts', 'avg', 'lo', 'hi'],
  rows: [
    [1700000000000, 20, 10, 30],
    [1700000060000, 22, 12, 31],
    [1700000120000, 24, 14, 33],
    [1700000180000, 21, 11, 32],
    [1700000240000, 25, 15, 35],
  ],
};

const baseDM = {
  x_axis: 'ts',
  x_axis_format: 'raw',
  band_columns: { scheme: 'minmaxmean', mean: 'avg', min: 'lo', max: 'hi' },
};

const build = (options) =>
  buildOption({ data_mapping: baseDM, options }, data, { formatCellValue: fmt });

// ── Baseline: renders without the new options ──────────────────────────
const base = build({});
check('baseline: returns an option with series', !!base && Array.isArray(base.series) && base.series.length > 0);
check('baseline: no dataZoom by default', base.dataZoom === undefined);

// ── Zoom slider (the reported missing option) ──────────────────────────
const zoom = build({ chartShowZoomSlider: true });
check('zoom slider: dataZoom added', Array.isArray(zoom.dataZoom) && zoom.dataZoom.length === 2);
check('zoom slider: has a slider entry', zoom.dataZoom?.some((z) => z.type === 'slider'));
check('zoom slider: has an inside entry', zoom.dataZoom?.some((z) => z.type === 'inside'));

// ── Y-axis range override ──────────────────────────────────────────────
const ranged = build({ yAxisRange: { left: { min: 0, max: 100, scale: 'log' } } });
check('y-range: min override applied', ranged.yAxis.min === 0);
check('y-range: max override applied', ranged.yAxis.max === 100);
check('y-range: log scale applied', ranged.yAxis.type === 'log');
check('y-range: auto bounds when unset', typeof base.yAxis.min === 'number' && base.yAxis.min !== 0);

// ── Tooltip config ─────────────────────────────────────────────────────
const ttHidden = build({ tooltip: { mode: 'hidden' } });
check('tooltip: hidden mode disables tooltip', ttHidden.tooltip && ttHidden.tooltip.show === false);
const ttShown = build({ tooltip: { mode: 'multi', decimals: 1, units: '%' } });
check('tooltip: shown mode has a formatter', typeof ttShown.tooltip?.formatter === 'function');
const line = ttShown.tooltip.formatter([{ dataIndex: 0 }]);
check('tooltip: decimals + units applied', line.includes('20.0') && line.includes('%'), line);

// ── Display: smooth / markers / sampling on the center line ────────────
const centerOf = (opt) => opt.series.find((s) => s.type === 'line' && s.lineStyle?.width === 2);
const smoothOn = centerOf(build({ chartSmooth: true }));
check('display: smooth on by default-style', smoothOn?.smooth === true);
const smoothOff = centerOf(build({ chartSmooth: false }));
check('display: smooth can be turned off', smoothOff?.smooth === false);
const noMarkers = centerOf(build({ showSymbol: false }));
check('display: markers off → symbol none', noMarkers?.symbol === 'none');
const sampled = centerOf(build({ sampling: 'lttb' }));
check('display: sampling reaches center series', sampled?.sampling === 'lttb');

// ── X-axis label rotate ────────────────────────────────────────────────
const rotated = build({ xAxisLabelRotate: 45 });
check('x-rotate: applied to axisLabel', rotated.xAxis.axisLabel?.rotate === 45);
check('x-rotate: absent when 0', build({ xAxisLabelRotate: 0 }).xAxis.axisLabel?.rotate === undefined);

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll banded_bar buildOption checks passed.\n`);
