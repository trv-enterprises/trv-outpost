#!/usr/bin/env node
// Verify gauge.js buildOption returns a well-formed ECharts gauge
// option for representative inputs. Smoke test (not byte-diff) — gauge
// migrated from the gauge_v1 string-emitter to the end-state buildOption
// shape; this replaces verify-gauge-template.mjs (which checked the now-
// bypassed string emitter).

import { buildOption } from '../src/chart-spec/specs/gauge.js';
import {
  newGaugeStyleOptions,
  applyGaugeStyle,
  resolveGaugeStyle,
  CLASSIC_GAUGE_STYLE,
} from '../src/chart-spec/gauge-styles.js';

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

// Center value precision (#159): SI mode (default) + auto decimals →
// 3 significant digits; explicit gaugeDecimals wins; SI off → legacy locale.
const fmtSi = opt.series[0].detail.formatter;
check('SI default: float noise → 3 sig digits', fmtSi(44.69111) === '44.7%', fmtSi(44.69111));
check('SI default: large value abbreviates', fmtSi(1019.46) === '1.02k%', fmtSi(1019.46));
const fmtDec = buildOption(vals({ options: { gaugeDecimals: '2' } }), data).series[0].detail.formatter;
check('explicit gaugeDecimals wins over SI', fmtDec(44.69111) === '44.69%', fmtDec(44.69111));
const fmtOff = buildOption(vals({ options: { chartSiPrefixes: false } }), data).series[0].detail.formatter;
check('SI off → legacy locale format', fmtOff(1019.46) === '1,019.46%', fmtOff(1019.46));

// legacy flat value_column fallback
const legacy = buildOption({ data_mapping: { value_column: 'cpu_percent' }, options: {} }, data);
check('falls back to data_mapping.value_column', legacy.series[0].data[0].value === 42);

// missing column → 0, no throw
const missing = buildOption(vals({ data_mapping: { y_axis: ['nope'] } }), data);
check('missing column → value 0', missing.series[0].data[0].value === 0);

// ── Aggregated value wins over row 0 ─────────────────────────────────
// applyAggregation puts avg/min/max/sum/count in a separate
// `aggregatedValue` and leaves `rows` untouched, so a gauge reading
// rows[0] used to show the first raw sample while claiming an average.
const aggData = { ...data, aggregatedValue: 70.5 };
check('aggregatedValue overrides row 0', buildOption(vals(), aggData).series[0].data[0].value === 70.5);
check('no aggregatedValue → row 0 (unchanged)', buildOption(vals(), data).series[0].data[0].value === 42);
check('null aggregatedValue → row 0', buildOption(vals(), { ...data, aggregatedValue: null }).series[0].data[0].value === 42);
// count returns 0 for an empty set — a legitimate aggregate, not "unset".
check('aggregatedValue 0 is honored, not treated as absent', buildOption(vals(), { ...data, aggregatedValue: 0 }).series[0].data[0].value === 0);
check('non-numeric aggregatedValue ignored', buildOption(vals(), { ...data, aggregatedValue: 'n/a' }).series[0].data[0].value === 42);

// ── Gauge STYLES ─────────────────────────────────────────────────────
// Two defaults by design: a record with NO style keys (every gauge saved
// before styles shipped) must render Classic — the exact pre-style
// output — while a NEW chart is seeded with Modern. See gauge-styles.js.

// Everything above this line passes options WITHOUT style keys, so those
// checks are themselves the backward-compat gate. These pin the specific
// values a legacy record resolves to.
const legacyStyle = buildOption(vals(), data).series[0];
check('legacy: segmented track (3 stops)', legacyStyle.axisLine.lineStyle.color.length === 3);
check('legacy: progress arc off', legacyStyle.progress.show === false);
check('legacy: split lines shown', legacyStyle.splitLine.show !== false && legacyStyle.splitLine.length === 8);
check('legacy: dial numbers shown', legacyStyle.axisLabel.show !== false);
check('legacy: anchor shown', legacyStyle.anchor.show === true);
check('legacy: pointer geometry unset (ECharts default)', legacyStyle.pointer.length === undefined && legacyStyle.pointer.width === undefined);
check('legacy: detail 24px @70%', legacyStyle.detail.fontSize === 24 && legacyStyle.detail.offsetCenter[1] === '70%');
check('legacy: angles/radius = ECharts defaults', legacyStyle.startAngle === 225 && legacyStyle.endAngle === -45 && legacyStyle.radius === '75%');
check('legacy: caption hidden', legacyStyle.title.show === false);
check('legacy record resolves to "classic"', resolveGaugeStyle({ gaugeMin: 0, gaugeMax: 100 }) === 'classic');

// Modern preset — the target design.
const modern = buildOption(vals({ options: { ...newGaugeStyleOptions(), gaugeLabel: 'RAM %' } }), data).series[0];
check('modern: angles 200/-20', modern.startAngle === 200 && modern.endAngle === -20);
check('modern: radius 85%', modern.radius === '85%');
check('modern: progress arc on, width 14', modern.progress.show === true && modern.progress.width === 14);
check('modern: flat track', JSON.stringify(modern.axisLine.lineStyle.color) === '[[1,"#3d3d3d"]]');
check('modern: split lines hidden', modern.splitLine.show === false);
check('modern: dial numbers hidden', modern.axisLabel.show === false);
check('modern: needle 65%/5px', modern.pointer.length === '65%' && modern.pointer.width === 5);
check('modern: anchor hidden', modern.anchor.show === false);
check('modern: detail 22px @30%', modern.detail.fontSize === 22 && modern.detail.offsetCenter[1] === '30%');
check('modern: caption shown @60%', modern.title.show === true && modern.title.offsetCenter[1] === '60%');
check('modern: caption becomes the series name', modern.data[0].name === 'RAM %');
check('new chart resolves to "modern"', resolveGaugeStyle(newGaugeStyleOptions()) === 'modern');

// Blank caption must not reserve dial space.
const noCaption = buildOption(vals({ options: newGaugeStyleOptions() }), data).series[0];
check('modern: blank caption → title hidden', noCaption.title.show === false && noCaption.data[0].name === undefined);

// Progress arc takes the color of the threshold band the value is in.
// Thresholds are PERCENTAGES OF THE SPAN, not raw values.
const arcAt = (v, extra = {}) => buildOption(
  { data_mapping: { y_axis: ['cpu_percent'] }, options: { ...newGaugeStyleOptions(), gaugeMin: 0, gaugeMax: 100, gaugeWarningThreshold: 70, gaugeDangerThreshold: 90, ...extra } },
  { columns: ['cpu_percent'], rows: [[v]] },
).series[0].progress.itemStyle.color;
check('arc 50 → ok', arcAt(50) === '#24a148', arcAt(50));
check('arc 70 → warn (inclusive)', arcAt(70) === '#f1c21b', arcAt(70));
check('arc 90 → danger (inclusive)', arcAt(90) === '#da1e28', arcAt(90));
check('arc thresholds are % of span (0-80 @60 = 75% → warn)', arcAt(60, { gaugeMax: 80 }) === '#f1c21b', arcAt(60, { gaugeMax: 80 }));
check('arc zero span → ok, no NaN', arcAt(5, { gaugeMin: 5, gaugeMax: 5 }) === '#24a148');

// Style tuning flips the dropdown to Custom (so re-picking a style reads
// as the overwrite it is), and a stale marker never wins over the values.
check('tuned modern → custom', resolveGaugeStyle({ ...newGaugeStyleOptions(), gaugeStartAngle: 180 }) === 'custom');
check('tuned classic → custom', resolveGaugeStyle({ ...CLASSIC_GAUGE_STYLE, gaugeShowSplitLine: false }) === 'custom');
check('stale gaugeStyle marker ignored', resolveGaugeStyle({ gaugeStyle: 'modern', gaugeMin: 0 }) === 'classic');

// Applying a style must not disturb data semantics.
const semantics = { gaugeMin: 0, gaugeMax: 250, gaugeUnit: ' psi', gaugeDecimals: '2', gaugeWarningThreshold: 60, gaugeDangerThreshold: 80, chartSiPrefixes: false };
const restyled = { ...semantics, ...applyGaugeStyle('modern') };
check('style change preserves min/max/unit/decimals', restyled.gaugeMin === 0 && restyled.gaugeMax === 250 && restyled.gaugeUnit === ' psi' && restyled.gaugeDecimals === '2');
check('style change preserves thresholds + SI toggle', restyled.gaugeWarningThreshold === 60 && restyled.gaugeDangerThreshold === 80 && restyled.chartSiPrefixes === false);
check('style change applies appearance', restyled.gaugeArcMode === 'progress' && restyled.gaugeRadius === 85);
check('"custom" is a no-op, not a reset', Object.keys(applyGaugeStyle('custom')).length === 0);

// Switching back to Classic must reproduce the legacy render exactly.
const roundTrip = buildOption(vals({ options: { ...newGaugeStyleOptions(), ...applyGaugeStyle('classic') } }), data).series[0];
check('modern→classic restores segmented track', JSON.stringify(roundTrip.axisLine.lineStyle.color) === JSON.stringify(legacyStyle.axisLine.lineStyle.color));
check('modern→classic restores arc width', roundTrip.axisLine.lineStyle.width === legacyStyle.axisLine.lineStyle.width);
check('modern→classic restores detail size', roundTrip.detail.fontSize === legacyStyle.detail.fontSize);
check('modern→classic turns the progress arc off', roundTrip.progress.show === false);
check('modern→classic restores split lines + anchor', roundTrip.splitLine.length === 8 && roundTrip.anchor.show === true);

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nAll checks passed.\n');
