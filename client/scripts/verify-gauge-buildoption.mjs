#!/usr/bin/env node
// Verify gauge.js buildOption returns a well-formed ECharts gauge
// option for representative inputs. Smoke test (not byte-diff) — gauge
// migrated from the gauge_v1 string-emitter to the end-state buildOption
// shape; this replaces verify-gauge-template.mjs (which checked the now-
// bypassed string emitter).

import { buildOption } from '../src/chart-spec/specs/gauge.js';

const FAILURES = [];
function check(label, cond, detail = '') {
  if (!cond) FAILURES.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  else process.stdout.write(`✓ ${label}\n`);
}

const data = {
  columns: ['ts', 'cpu_percent'],
  rows: [
    ['2026-01-01T00:00:00Z', 42],
    ['2026-01-01T00:01:00Z', 99],
  ],
};

function vals(extra) {
  return {
    data_mapping: { y_axis: ['cpu_percent'], ...(extra?.data_mapping || {}) },
    options: { gaugeMin: 0, gaugeMax: 100, gaugeWarningThreshold: 70, gaugeDangerThreshold: 90, gaugeUnit: '%', ...(extra?.options || {}) },
  };
}

const opt = buildOption(vals(), data);
check('returns an object', opt && typeof opt === 'object');
check('backgroundColor transparent', opt.backgroundColor === 'transparent');
check('has one gauge series', Array.isArray(opt.series) && opt.series.length === 1 && opt.series[0].type === 'gauge');
check('min/max from options', opt.series[0].min === 0 && opt.series[0].max === 100);
check('reads first row value', opt.series[0].data[0].value === 42);
check('three color segments (warn/danger/ceiling)', Array.isArray(opt.series[0].axisLine.lineStyle.color) && opt.series[0].axisLine.lineStyle.color.length === 3);
check('warn stop fraction = 0.7', opt.series[0].axisLine.lineStyle.color[0][0] === 0.7);
check('danger stop fraction = 0.9', opt.series[0].axisLine.lineStyle.color[1][0] === 0.9);
check('ceiling stop fraction = 1', opt.series[0].axisLine.lineStyle.color[2][0] === 1);
check('detail formatter appends unit', opt.series[0].detail.formatter(42) === '42%');
check('NO option.title (ChartShell owns the title)', opt.title === undefined);

// legacy flat value_column fallback
const legacy = buildOption({ data_mapping: { value_column: 'cpu_percent' }, options: {} }, data);
check('falls back to data_mapping.value_column', legacy.series[0].data[0].value === 42);

// missing column → 0, no throw
const missing = buildOption(vals({ data_mapping: { y_axis: ['nope'] } }), data);
check('missing column → value 0', missing.series[0].data[0].value === 0);

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nAll checks passed.\n');
