// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Gauge STYLE PRESETS — named bundles of the gauge's appearance options.
//
// Why presets and not just a pile of fields: the gauge's look is a dozen
// interdependent ECharts knobs (angles, radius, arc mode, split lines,
// pointer geometry, label offsets). Setting them one at a time to reach a
// coherent look is tedious and easy to get half-right, so a style writes
// the whole coherent set at once. The individual fields remain editable
// afterwards — a preset is a STARTING POINT, not a mode.
//
// ── The two-defaults rule (important) ────────────────────────────────
// Existing saved gauges predate every key in here. They must keep
// rendering EXACTLY as they always have. That's why:
//
//   1. CLASSIC holds the legacy values, and gauge.js reads every
//      appearance key as `opts.foo ?? CLASSIC.foo`. A record with the key
//      absent therefore renders byte-identical to before this file existed.
//   2. These keys are deliberately NOT in ComponentEditor's
//      DEFAULT_CHART_OPTIONS. That object is merged over EVERY chart on
//      load, so putting the Modern values there would restyle every
//      existing gauge on open. New charts get Modern by an explicit
//      seed at create time instead (newGaugeStyleOptions).
//
// So: absent key → Classic. New chart → Modern. Both by construction,
// with no migration and nothing to back out.

// The appearance keys a style governs. Data-semantics options — min, max,
// warning/danger thresholds, unit, decimals, SI prefixes — are NOT here:
// they describe what the number MEANS, and switching a visual style must
// not silently rescale or reformat the reading.
export const GAUGE_STYLE_KEYS = [
  'gaugeStartAngle',
  'gaugeEndAngle',
  'gaugeRadius',
  'gaugeArcMode',
  'gaugeLineThickness',
  'gaugeShowSplitLine',
  'gaugeShowAxisLabel',
  'gaugeShowPointer',
  'gaugePointerLength',
  'gaugePointerWidth',
  'gaugeShowAnchor',
  'gaugeValueFontSize',
  'gaugeValueOffset',
  'gaugeLabel',
  'gaugeLabelFontSize',
  'gaugeLabelOffset',
];

// ── Classic ──────────────────────────────────────────────────────────
// The pre-existing look, captured exactly: a wide dial whose TRACK is
// painted in green/yellow/red threshold bands, numbered ticks, split
// lines, and a fat pointer over a visible anchor.
//
// Every value here is the literal that gauge.js used before styles
// existed. Changing one changes how already-saved gauges render — don't,
// unless that's the explicit intent.
export const CLASSIC_GAUGE_STYLE = {
  // ECharts' own gauge defaults; the legacy option literal never set them.
  gaugeStartAngle: 225,
  gaugeEndAngle: -45,
  gaugeRadius: 75,
  // 'segmented' = threshold colors band the TRACK (axisLine.lineStyle.color).
  gaugeArcMode: 'segmented',
  gaugeLineThickness: 8,
  gaugeShowSplitLine: true,
  gaugeShowAxisLabel: true,
  gaugeShowPointer: true,
  // null = "ECharts default" for the two pointer dimensions. The legacy
  // literal set neither, and hardcoding ECharts' internal defaults here
  // would freeze values we don't own.
  gaugePointerLength: null,
  gaugePointerWidth: null,
  gaugeShowAnchor: true,
  gaugeValueFontSize: 24,
  gaugeValueOffset: 70,
  gaugeLabel: '',
  gaugeLabelFontSize: 13,
  gaugeLabelOffset: 60,
};

// ── Modern ───────────────────────────────────────────────────────────
// A single threshold-colored PROGRESS arc sweeping over a flat dark
// track, no ticks or split lines, a slim needle, and the value sitting
// high in the dial with an optional caption beneath it.
export const MODERN_GAUGE_STYLE = {
  gaugeStartAngle: 200,
  gaugeEndAngle: -20,
  gaugeRadius: 85,
  // 'progress' = ONE threshold-derived color on the progress arc, flat track.
  gaugeArcMode: 'progress',
  gaugeLineThickness: 14,
  gaugeShowSplitLine: false,
  gaugeShowAxisLabel: false,
  gaugeShowPointer: true,
  gaugePointerLength: 65,
  gaugePointerWidth: 5,
  gaugeShowAnchor: false,
  gaugeValueFontSize: 22,
  gaugeValueOffset: 30,
  gaugeLabel: '',
  gaugeLabelFontSize: 13,
  gaugeLabelOffset: 60,
};

export const GAUGE_STYLE_PRESETS = {
  classic: CLASSIC_GAUGE_STYLE,
  modern: MODERN_GAUGE_STYLE,
};

// Order + labels for the style dropdown. 'custom' is never SELECTABLE —
// it's what the dropdown reports once the author has tuned a governed
// field away from its preset value. Offering it as a choice would be
// meaningless ("apply my own edits"?), so it's filtered out of the
// options list and only ever appears as the current value.
export const GAUGE_STYLE_OPTIONS = [
  { value: 'modern', label: 'Modern' },
  { value: 'classic', label: 'Classic' },
];

export const GAUGE_STYLE_CUSTOM = 'custom';

/**
 * The options a NEWLY-CREATED gauge starts with: the Modern preset,
 * plus the explicit gaugeStyle marker so the dropdown reads "Modern".
 *
 * Callers spread this into chartOptions at create time ONLY. It must
 * never be merged into a loaded record — see the header note.
 */
export function newGaugeStyleOptions() {
  return { gaugeStyle: 'modern', ...MODERN_GAUGE_STYLE };
}

/** True when two governed values are equivalent for style-matching. */
function sameValue(a, b) {
  // null and undefined both mean "unset / ECharts default" — a record
  // that omits gaugePointerLength must still match Classic, which
  // declares it as null.
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return a === b;
}

/**
 * Does `options` match `styleName`'s preset on every governed key?
 *
 * An ABSENT key counts as its Classic value, because that is exactly how
 * gauge.js resolves it at render time. This is what makes a legacy record
 * — which has none of these keys — correctly report as Classic.
 */
export function matchesGaugeStyle(options, styleName) {
  const preset = GAUGE_STYLE_PRESETS[styleName];
  if (!preset) return false;
  const opts = options || {};
  return GAUGE_STYLE_KEYS.every((key) => {
    const actual = opts[key] === undefined ? CLASSIC_GAUGE_STYLE[key] : opts[key];
    return sameValue(actual, preset[key]);
  });
}

/**
 * The style name to DISPLAY for a set of options.
 *
 * Derived from the values themselves rather than trusted from the stored
 * `gaugeStyle` marker, so tuning any governed field flips the dropdown to
 * "Custom" on its own. That honesty matters: re-selecting a style
 * OVERWRITES the author's tuning, and the label reading "Custom" is the
 * signal that there is tuning to lose.
 *
 * Checked in GAUGE_STYLE_OPTIONS order, so a set of values satisfying two
 * presets resolves deterministically to the first (only reachable if the
 * presets are ever made identical).
 */
export function resolveGaugeStyle(options) {
  for (const { value } of GAUGE_STYLE_OPTIONS) {
    if (matchesGaugeStyle(options, value)) return value;
  }
  return GAUGE_STYLE_CUSTOM;
}

/**
 * Apply a style: the preset's governed keys plus the marker. Returns ONLY
 * the changed keys — callers merge this over existing chartOptions, so
 * ungoverned options (min/max/thresholds/unit/decimals) survive untouched.
 */
export function applyGaugeStyle(styleName) {
  const preset = GAUGE_STYLE_PRESETS[styleName];
  if (!preset) return {};
  return { gaugeStyle: styleName, ...preset };
}
