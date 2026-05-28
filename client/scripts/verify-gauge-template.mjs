#!/usr/bin/env node
// Verify the gauge_v1 spec-driven template emits the same code shape
// as the legacy gauge branch of getDataDrivenChartCode. Runs as a
// fast regression check — does NOT replace the manual four-quadrant
// test in docs/TEST_PLAN.md Section Q, but catches obvious drift.
//
// Usage: node client/scripts/verify-gauge-template.mjs
//
// Exits 0 on success, 1 on any assertion failure.

import { renderGaugeV1 } from '../src/chart-codegen/echarts/templates/gauge_v1.js';

const FAILURES = [];

function check(label, cond, detail = '') {
  if (!cond) {
    FAILURES.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    process.stdout.write(`✓ ${label}\n`);
  }
}

// Representative input matching a typical gauge config.
const ctx = {
  connectionId: 'conn-123',
  queryRaw: 'newest',
  queryType: 'stream_filter',
  queryParams: { limit: 1 },
  extraOptionsLine: ',\n    backfill: { raw: \'newest\', type: \'stream_filter\', params: { limit: 1 } }',
  useDataFields: '{ data, loading, error, isStreaming, connected }',
  noDataLine: "if (!data?.rows?.length) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6f6f6f' }}>{connected ? 'Waiting for data...' : 'Connecting...'}</div>;",
  transformsConfig: '\n  const rows = data.rows;',
  hasTransforms: false,
  yAxisStr: "'cpu_percent'",
  chartName: '',
  chartOptions: {
    gaugeMin: 0,
    gaugeMax: 100,
    gaugeWarningThreshold: 70,
    gaugeDangerThreshold: 90,
    gaugeUnit: '%',
    gaugeLineThickness: 8,
  },
  bindings: {},
};

const out = renderGaugeV1(ctx);

// Structural checks — every shape the legacy branch emits must
// appear identically in the template output.
check('emits Component arrow declaration', out.startsWith('const Component = () => {'));
check('opens with containerRef', out.includes('const containerRef = useRef(null);'));
check('declares ResizeObserver guard for sub-px resize loops', out.includes('Math.abs(prev.width - width) > 1'));
check('emits useData connectionId from ctx', out.includes("connectionId: 'conn-123'"));
check('emits queryRaw inside backtick literal', out.includes('raw: `newest`'));
check('emits queryType', out.includes("type: 'stream_filter'"));
check('emits queryParams via JSON.stringify', out.includes('params: {"limit":1}'));
check('emits extraOptionsLine verbatim', out.includes('backfill:'));
check('emits useDataFields destructure', out.includes('const { data, loading, error, isStreaming, connected } = useData'));
check('emits noDataLine verbatim', out.includes('Waiting for data...'));
check('emits transformsConfig verbatim (no transforms)', out.includes('const rows = data.rows;'));
check('emits yCol from yAxisStr', out.includes("const yCol = 'cpu_percent';"));
check('uses data.columns (not transformed) when hasTransforms=false', out.includes('data.columns.indexOf(yCol)'));
check('emits responsive container math', out.includes('const minDim = Math.min(containerSize.width, containerSize.height);'));
check('emits axisLineWidth from line thickness (8/100=0.08)', out.includes('Math.floor(minDim * 0.08)'));
check('emits min from chartOptions.gaugeMin', out.includes('min: 0,'));
check('emits max from chartOptions.gaugeMax', out.includes('max: 100,'));
check('emits warning threshold color stop (70/100=0.7)', out.includes('[0.7, \'#24a148\']'));
check('emits danger threshold color stop (90/100=0.9)', out.includes('[0.9, \'#f1c21b\']'));
check('emits ceiling color stop [1, red]', out.includes("[1, '#da1e28']"));
check('emits unit-aware detail formatter', out.includes("formatter: '{value}%'"));
check('uses single-formatter when no unit (default branch)', renderGaugeV1({ ...ctx, chartOptions: { ...ctx.chartOptions, gaugeUnit: '' } }).includes("formatter: '{value}'"));
check('omits chart title block when chartName is empty', !out.includes('title: { text:'));

// With chartName + transforms set
const withTitle = renderGaugeV1({
  ...ctx,
  chartName: "Tom's CPU",
  hasTransforms: true,
  transformsConfig: '\n  // transforms\n  const transforms = {};\n  const transformed = transformData(data, transforms);\n  const rows = transformed.rows;',
});
check('emits title block when chartName is set', withTitle.includes("title: { text: 'Tom\\'s CPU'"));
check('uses transformed.columns when hasTransforms=true', withTitle.includes('transformed.columns.indexOf(yCol)'));

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`\nAll checks passed.\n`);
