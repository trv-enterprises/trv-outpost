// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// gauge buildOption — end-state Stage 2 shape (replaces the Stage 1
// gauge_v1.js string-emitter port). Given current form values (keyed by
// spec binds path) + the query result rows, returns an ECharts `option`.
// ChartShell renders it; the title is the shell's HTML header (unified
// with line/bar/area), NOT option.title.

import {
  COLOR_OK,
  COLOR_WARN,
  COLOR_DANGER,
  COLOR_PRIMARY,
  COLOR_TEXT,
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  toNumber,
  singleDisplayValue,
  makeSIAxisFormatter,
  formatSI,
} from '../option-helpers.js';
import { CLASSIC_GAUGE_STYLE } from '../gauge-styles.js';

// The flat track a 'progress' gauge sweeps its colored arc over. Neutral
// by design — the arc carries the threshold color, so a track with any
// hue of its own would read as a second signal.
const PROGRESS_TRACK_COLOR = '#3d3d3d';

/**
 * Read an appearance option, falling back to the CLASSIC value when the
 * key is absent.
 *
 * This single line is what keeps every already-saved gauge rendering
 * exactly as it did before styles existed: those records have none of
 * the style keys, so each one resolves to its legacy literal. New charts
 * are seeded with the Modern preset at create time, so they carry
 * explicit values and never reach the fallback. See gauge-styles.js.
 */
function styleOpt(opts, key) {
  const v = opts?.[key];
  return v === undefined ? CLASSIC_GAUGE_STYLE[key] : v;
}

/**
 * Build the gauge axisLine color-segment stops. The spec stores the
 * warning/danger thresholds as PERCENTAGES of the min→max span (0-100),
 * matching the legacy gauge_v1 codegen (`warning/100`, `danger/100`).
 * Returns ECharts `[[fraction, color], ...]` stops.
 */
function buildSegments(warningPct, dangerPct) {
  const w = toNumber(warningPct, 70) / 100;
  const d = toNumber(dangerPct, 90) / 100;
  return [[w, COLOR_OK], [d, COLOR_WARN], [1, COLOR_DANGER]];
}

/**
 * The single arc color for 'progress' mode: the threshold band the value
 * currently sits in.
 *
 * Same thresholds, same meaning as segmented mode — the two modes differ
 * only in WHERE the color is painted. Segmented bands the whole track so
 * every zone is visible at once; progress colors just the swept arc, so
 * the dial reads as one status color. Thresholds are percentages of the
 * min→max span, so the value is converted to its position in that span
 * before comparing (a 0-80 gauge at 60 is at 75%, not 60%).
 */
function progressColor(value, min, max, warningPct, dangerPct) {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return COLOR_OK;
  const pct = ((value - min) / span) * 100;
  if (pct >= toNumber(dangerPct, 90)) return COLOR_DANGER;
  if (pct >= toNumber(warningPct, 70)) return COLOR_WARN;
  return COLOR_OK;
}

/**
 * Main entry point. Pure function.
 *
 * Gauge consumes a single value — the first row of the (already
 * transformed: filtered / aggregated / sliding-windowed) result set.
 *
 * @param {Object} values  Form state: { data_mapping, options }
 * @param {Object} data    Query result: { columns: string[], rows: any[][] }
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data) {
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};

  // Value column: spec binds to data_mapping.y_axis[0]. Fall back to a
  // legacy flat value_column field for old records.
  const valueColumn = (Array.isArray(dm.y_axis) ? dm.y_axis[0] : undefined) || dm.value_column || '';
  // Honors a configured aggregation (avg/min/max/sum/count) when one
  // produced a scalar; otherwise row 0. See singleDisplayValue.
  const value = singleDisplayValue(data, valueColumn, 0);

  const gaugeMin = toNumber(opts.gaugeMin, 0);
  const gaugeMax = toNumber(opts.gaugeMax, 100);
  const unit = opts.gaugeUnit || '';

  // ── Appearance (style-governed) ────────────────────────────────────
  // Each of these resolves to its CLASSIC value when the key is absent,
  // which is every gauge saved before styles shipped.
  const arcMode = styleOpt(opts, 'gaugeArcMode');
  const isProgress = arcMode === 'progress';
  const startAngle = toNumber(styleOpt(opts, 'gaugeStartAngle'), CLASSIC_GAUGE_STYLE.gaugeStartAngle);
  const endAngle = toNumber(styleOpt(opts, 'gaugeEndAngle'), CLASSIC_GAUGE_STYLE.gaugeEndAngle);
  const radiusPct = toNumber(styleOpt(opts, 'gaugeRadius'), CLASSIC_GAUGE_STYLE.gaugeRadius);

  // Nudge the dial down to reclaim part of the empty wedge beneath it.
  //
  // A gauge sweeps startAngle→endAngle and leaves the rest of the circle empty
  // — 90° on Classic (225→-45), 140° on Modern (200→-20). ECharts reserves the
  // whole circle and centres THAT, so the unused wedge becomes dead space under
  // the dial: ~15% of the diameter on Classic, ~33% on Modern, which is why the
  // Modern preset in particular reads as floating high in its panel.
  //
  // Geometrically, centring the INK means shifting down by (cos(gap/2) − 1)/2
  // of the radius — 57.3% / 66.4%. That is mathematically right and visually
  // WRONG: a gauge's visual mass is its upper arc, so true bounding-box
  // centring drops the dial too low. Tried it; it looked worse than the dead
  // space it fixed.
  //
  // So apply 40% of that correction (Classic 52.9%, Modern 56.6%): enough to
  // take the edge off the gap on wide-gap arcs, small enough that Classic
  // barely moves and existing dashboards aren't disturbed. Tuned by eye —
  // 100% sat far too low, 33% was very slightly under.
  //
  // Self-correcting: a full 360° gauge has gap 0, cos(0) = 1, and the offset
  // collapses to 0 — the expression returns the default 50%, so an arc this
  // doesn't apply to can never be misplaced.
  const ARC_CENTER_CORRECTION = 0.4;
  const arcGapDeg = 360 - Math.abs(startAngle - endAngle);
  const centerYPct = arcGapDeg > 0 && arcGapDeg < 360
    ? 50 - ((Math.cos((arcGapDeg / 2) * (Math.PI / 180)) - 1) / 2) * 50 * ARC_CENTER_CORRECTION
    : 50;
  const showSplitLine = styleOpt(opts, 'gaugeShowSplitLine') !== false;
  const showAxisLabel = styleOpt(opts, 'gaugeShowAxisLabel') !== false;
  const showPointer = styleOpt(opts, 'gaugeShowPointer') !== false;
  const pointerLength = styleOpt(opts, 'gaugePointerLength');
  const pointerWidth = styleOpt(opts, 'gaugePointerWidth');
  const showAnchor = styleOpt(opts, 'gaugeShowAnchor') !== false;
  const valueFontSize = toNumber(styleOpt(opts, 'gaugeValueFontSize'), CLASSIC_GAUGE_STYLE.gaugeValueFontSize);
  const valueOffset = toNumber(styleOpt(opts, 'gaugeValueOffset'), CLASSIC_GAUGE_STYLE.gaugeValueOffset);
  const label = styleOpt(opts, 'gaugeLabel') || '';
  const labelFontSize = toNumber(styleOpt(opts, 'gaugeLabelFontSize'), CLASSIC_GAUGE_STYLE.gaugeLabelFontSize);
  const labelOffset = toNumber(styleOpt(opts, 'gaugeLabelOffset'), CLASSIC_GAUGE_STYLE.gaugeLabelOffset);

  // Arc thickness. Legacy (segmented) stores a 1-16 "percentage" that was
  // applied against the gauge's pixel radius; a pure buildOption can't
  // measure pixels, so that range maps onto a px width via *1.5 — kept
  // exactly as-is so existing dials don't change weight. The Modern
  // preset instead stores a direct px width (14, per the target design),
  // which would become a 21px slab under the legacy scaling, so progress
  // mode takes the value literally.
  const thickness = toNumber(styleOpt(opts, 'gaugeLineThickness'), CLASSIC_GAUGE_STYLE.gaugeLineThickness);
  const axisWidth = isProgress
    ? Math.max(1, Math.round(thickness))
    : Math.max(6, Math.round(thickness * 1.5));

  // Decimal places for the center value. Matches the number chart's
  // semantics (number-formats.js formatPlain): 'auto' (default) = up to 2
  // places, a number = exactly that many. Without this the raw float
  // prints in full (e.g. 11.390740740742459).
  const decimals = opts.gaugeDecimals;
  const siPrefixes = opts.chartSiPrefixes !== false;
  const formatValue = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return `${v}`;
    if (decimals != null && decimals !== 'auto') {
      const places = Number(decimals);
      if (Number.isFinite(places)) {
        return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
      }
    }
    // SI mode + auto decimals → 3 significant digits, same precedence as
    // tooltips/data labels (#159): explicit decimals above win; the SI
    // toggle is the off switch back to the locale format below.
    if (siPrefixes) return formatSI(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  };
  const detailFormatter = (v) => `${formatValue(v)}${unit ? unit : ''}`;

  // SI-prefix dial tick labels (#159): min/max bound every tick, so a
  // shared prefix from them covers the whole dial. The center detail
  // value keeps its own decimals/unit formatting (full precision).
  const siAxisFormatter = opts.chartSiPrefixes !== false
    ? makeSIAxisFormatter([gaugeMin, gaugeMax])
    : null;

  // In progress mode the threshold colors move OFF the track (which goes
  // flat) and ONTO the swept arc, so exactly one of these two carries them.
  const arcColor = isProgress
    ? progressColor(value, gaugeMin, gaugeMax, opts.gaugeWarningThreshold, opts.gaugeDangerThreshold)
    : null;

  return {
    backgroundColor: TRANSPARENT_BG,
    series: [{
      type: 'gauge',
      min: gaugeMin,
      max: gaugeMax,
      startAngle,
      endAngle,
      radius: `${radiusPct}%`,
      // See centerYPct above — a partial shift down so a wide-gap arc doesn't
      // sit high with dead space beneath it.
      center: ['50%', `${centerYPct.toFixed(1)}%`],
      progress: isProgress
        ? { show: true, width: axisWidth, itemStyle: { color: arcColor } }
        : { show: false },
      axisLine: {
        lineStyle: {
          width: axisWidth,
          color: isProgress
            ? [[1, PROGRESS_TRACK_COLOR]]
            : buildSegments(opts.gaugeWarningThreshold, opts.gaugeDangerThreshold),
        },
      },
      axisTick: { show: false },
      splitLine: showSplitLine
        ? { length: 8, lineStyle: { width: 2, color: '#999' } }
        : { show: false },
      axisLabel: showAxisLabel
        ? { color: '#999', ...(siAxisFormatter ? { formatter: siAxisFormatter } : {}) }
        : { show: false },
      pointer: {
        show: showPointer,
        // null length/width mean "leave ECharts' default alone" — the
        // Classic dial never specified either, and inventing values here
        // would change how existing gauges draw.
        ...(pointerLength != null ? { length: `${toNumber(pointerLength, 65)}%` } : {}),
        ...(pointerWidth != null ? { width: toNumber(pointerWidth, 5) } : {}),
        itemStyle: { color: COLOR_PRIMARY },
      },
      anchor: showAnchor
        ? { show: true, showAbove: true, size: 14, itemStyle: { borderWidth: 6 } }
        : { show: false },
      // The series `name` renders as the gauge's built-in title. Shown
      // only when the author supplies a caption — an empty title would
      // otherwise reserve dial space for nothing.
      title: label
        ? { show: true, offsetCenter: [0, `${labelOffset}%`], fontSize: labelFontSize, color: COLOR_TEXT_SECONDARY }
        : { show: false },
      detail: {
        valueAnimation: true,
        formatter: detailFormatter,
        color: COLOR_TEXT,
        fontSize: valueFontSize,
        offsetCenter: [0, `${valueOffset}%`],
      },
      data: [{ value, ...(label ? { name: label } : {}) }],
    }],
  };
}
