#!/usr/bin/env node
// Verify value.js buildOption returns a well-formed view descriptor for
// representative inputs. `value` is a non-ECharts spec-driven type: its
// buildOption returns { render: 'value', props } which SpecDrivenChart
// renders via the view registry.
//
// Three things here are easy to break and worth pinning:
//   1. TEXT values render as their own string (the capability that
//      motivated renaming `number` → `value`) — never "NaN".
//   2. The accept-old fallback: a component record that escaped the
//      migrateNumberChartToValue boot migration still carries
//      options.number* keys and must keep rendering.
//   3. The numeric formats, which the rename must not have disturbed.

import { buildOption } from '../src/chart-spec/specs/value.js';

const FAILURES = [];
function check(label, cond, detail = '') {
  if (!cond) FAILURES.push(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  else process.stdout.write(`✓ ${label}\n`);
}

const data = (columns, rows) => ({ columns, rows });
const numeric = data(['ts', 'cpu_percent'], [['2026-01-01T00:00:00Z', 21.456]]);

function vals(options, yAxis = ['cpu_percent']) {
  return { data_mapping: { y_axis: yAxis }, options: options || {} };
}

// --- shape ---------------------------------------------------------------
const base = buildOption(vals({}), numeric, { chartName: 'CPU' });
check('returns a tagged descriptor', base && base.render === 'value', JSON.stringify(base));
check('carries the chart name as title', base.props.title === 'CPU');
check('defaults size to 56', base.props.size === 56);

// --- numeric formats -----------------------------------------------------
check('plain + decimals',
  buildOption(vals({ valueFormat: 'plain', valueDecimals: '1' }), numeric).props.formatted === '21.5');
check('compact SI',
  buildOption(vals({ valueFormat: 'compact' }, ['n']), data(['n'], [[1234567]])).props.formatted === '1.2M');
check('duration from seconds',
  buildOption(vals({ valueFormat: 'duration' }, ['up']), data(['up'], [[183840]])).props.formatted === '2d 3h 4m');
check('duration clock',
  buildOption(vals({ valueFormat: 'duration_clock' }, ['up']), data(['up'], [[3661]])).props.formatted === '01:01:01');
check('unit + size pass through',
  (() => {
    const p = buildOption(vals({ valueUnit: '°C', valueSize: '80' }), numeric).props;
    return p.unit === '°C' && p.size === 80;
  })());

// --- text values (the capability the rename introduced) ------------------
const text = buildOption(vals({}, ['status']), data(['status'], [['ONLINE']]));
check('text value renders as its own string', text.props.formatted === 'ONLINE', text.props.formatted);

const textFormatted = buildOption(
  vals({ valueFormat: 'compact', valueDecimals: '2', valueUnit: '!' }, ['state']),
  data(['state'], [['degraded']]),
);
check('numeric format on text → no NaN, string preserved', textFormatted.props.formatted === 'degraded', textFormatted.props.formatted);
check('unit still applies to a text value', textFormatted.props.unit === '!');

// --- accept-old: un-migrated records still render -------------------------
const legacyKeys = buildOption(
  vals({ numberFormat: 'plain', numberDecimals: '1', numberUnit: '°C', numberSize: 80 }),
  numeric,
);
check('legacy number* option keys still honored',
  legacyKeys.props.formatted === '21.5' && legacyKeys.props.unit === '°C' && legacyKeys.props.size === 80,
  JSON.stringify(legacyKeys.props));

const bothKeys = buildOption(vals({ valueUnit: 'NEW', numberUnit: 'OLD', valueSize: 24, numberSize: 400 }), numeric);
check('value* wins when both spellings present',
  bothKeys.props.unit === 'NEW' && bothKeys.props.size === 24,
  JSON.stringify(bothKeys.props));

// --- edges ---------------------------------------------------------------
check('no value column → null', buildOption({ data_mapping: {}, options: {} }, data([], [])) === null);
check('object y_axis entry (editor preview shape)',
  buildOption({ data_mapping: { y_axis: [{ column: 'cpu_percent' }] }, options: { valueFormat: 'plain', valueDecimals: '0' } }, numeric).props.formatted === '21');
check('legacy data_mapping.value_column fallback',
  buildOption({ data_mapping: { value_column: 'cpu_percent' }, options: { valueFormat: 'plain', valueDecimals: '0' } }, numeric).props.formatted === '21');
check('null cell → empty string, not "null"',
  buildOption(vals({}, ['v']), data(['v'], [[null]])).props.formatted === '');
check('no rows → empty string',
  buildOption(vals({}, ['cpu_percent']), data(['ts', 'cpu_percent'], [])).props.formatted === '');

if (FAILURES.length > 0) {
  process.stderr.write(`\n${FAILURES.length} failure(s):\n${FAILURES.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('\nAll value buildOption checks passed.\n');
