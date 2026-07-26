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
// Unit is a NUMERIC-only option: the editor hides it on the text Display
// row, so a stale stored unit must not render where the author can no
// longer see or clear it. (Asserted again under valueType below.)
check('unit NOT applied to a text value', textFormatted.props.unit === '', textFormatted.props.unit);

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

// --- valueType override + text case --------------------------------------
// A numeric-looking value forced to text must NOT be number-formatted.
const forcedText = buildOption(
  vals({ valueType: 'text', valueFormat: 'compact' }, ['code']),
  data(['code'], [[1234567]]),
);
check('valueType=text forces the string path', forcedText.props.formatted === '1234567', forcedText.props.formatted);

// A text value forced to number falls back to the auto formatter (no NaN).
const forcedNum = buildOption(vals({ valueType: 'number' }, ['s']), data(['s'], [['abc']]));
check('valueType=number on text → no NaN', forcedNum.props.formatted === 'abc', forcedNum.props.formatted);

// Numeric STRINGS are numeric under auto-detection (JSON/MQTT/CSV deliver these).
check('numeric string auto-detects as number',
  buildOption(vals({ valueFormat: 'compact' }, ['n']), data(['n'], [['1234567']])).props.formatted === '1.2M');
check('empty string is NOT numeric',
  buildOption(vals({}, ['s']), data(['s'], [['']])).props.formatted === '');
check('boolean is treated as text',
  buildOption(vals({ valueTextCase: 'upper' }, ['b']), data(['b'], [[false]])).props.formatted === 'FALSE');

var caseCases = [['none','device offline'],['upper','DEVICE OFFLINE'],['lower','device offline'],
                 ['capitalize','Device offline'],['title','Device Offline']];
caseCases.forEach(function ([mode, want]) {
  check('text case ' + mode,
    buildOption(vals({ valueTextCase: mode }, ['s']), data(['s'], [['device offline']])).props.formatted === want,
    buildOption(vals({ valueTextCase: mode }, ['s']), data(['s'], [['device offline']])).props.formatted);
});
check('text case never applies to a numeric value',
  buildOption(vals({ valueTextCase: 'upper', valueFormat: 'compact' }, ['n']), data(['n'], [[1234567]])).props.formatted === '1.2M');

// Unit is numeric-only: a stale stored unit must not render on text.
check('unit suppressed for a text value',
  buildOption(vals({ valueUnit: '°C' }, ['s']), data(['s'], [['ONLINE']])).props.unit === '');
check('unit still renders for a numeric value',
  buildOption(vals({ valueUnit: '°C' }), numeric).props.unit === '°C');

// --- threshold coloring (#36) --------------------------------------------
// Numeric: each color applies from its value UPWARD; highest reached wins.
const NUM_T = [
  { value: 0, color: '#24a148' },
  { value: 80, color: '#f1c21b' },
  { value: 90, color: '#da1e28' },
];
var numThreshCases = [[50,'#24a148'],[80,'#f1c21b'],[85,'#f1c21b'],[90,'#da1e28'],[999,'#da1e28']];
numThreshCases.forEach(function ([v, want]) {
  const got = buildOption(vals({ valueThresholds: NUM_T }, ['n']), data(['n'], [[v]])).props.color;
  check('numeric threshold ' + v + ' → ' + want, got === want, String(got));
});
check('numeric below every threshold → null',
  buildOption(vals({ valueThresholds: [{ value: 10, color: '#da1e28' }] }, ['n']), data(['n'], [[5]])).props.color === null);
check('no thresholds → null color (theme default)',
  buildOption(vals({}), numeric).props.color === null);
check('thresholds added out of order still band correctly',
  buildOption(vals({ valueThresholds: [{value:90,color:'#da1e28'},{value:0,color:'#24a148'},{value:80,color:'#f1c21b'}] }, ['n']),
    data(['n'], [[85]])).props.color === '#f1c21b');

// Text: first match wins, case-insensitive.
const TXT_T = [
  { operator: 'eq', match: 'ONLINE', color: '#24a148' },
  { operator: 'contains', match: 'fail', color: '#da1e28' },
  { operator: 'contains', match: 'warn', color: '#f1c21b' },
];
var txtCases = [['ONLINE','#24a148'],['online','#24a148'],['OFFLINE - FAILED','#da1e28'],
                ['warning: disk','#f1c21b'],['Idle',null]];
txtCases.forEach(function ([v, want]) {
  const got = buildOption(vals({ valueTextThresholds: TXT_T }, ['s']), data(['s'], [[v]])).props.color;
  check('text rule "' + v + '" → ' + want, got === want, String(got));
});
check('first matching rule wins over a later one',
  buildOption(vals({ valueTextThresholds: [
    { operator: 'contains', match: 'e', color: '#0f62fe' },
    { operator: 'eq', match: 'ONLINE', color: '#24a148' }] }, ['s']),
    data(['s'], [['ONLINE']])).props.color === '#0f62fe');
check('empty match string is skipped, not match-all',
  buildOption(vals({ valueTextThresholds: [{ operator: 'contains', match: '   ', color: '#da1e28' }] }, ['s']),
    data(['s'], [['anything']])).props.color === null);
check('text rules ignored on a numeric value',
  buildOption(vals({ valueTextThresholds: TXT_T }, ['n']), data(['n'], [[42]])).props.color === null);
check('text case + threshold compose',
  (() => {
    const p = buildOption(vals({ valueTextCase: 'upper', valueTextThresholds: TXT_T }, ['s']),
      data(['s'], [['online']])).props;
    return p.formatted === 'ONLINE' && p.color === '#24a148';
  })());

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
