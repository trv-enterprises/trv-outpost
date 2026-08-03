// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// value "buildOption" — a non-ECharts spec-driven type. Instead of an
// ECharts option it returns a tagged view descriptor; SpecDrivenChart
// renders the registered <ValueView> from the view registry. See
// docs/design-notes/spec-driven-non-echarts-views.md.
//
// Same data contract as gauge: read the first y-axis column from the
// first (post-aggregation) row. Unlike gauge the value may be a STRING —
// a non-numeric cell renders as text (see number-formats.js).
//
// This type supersedes the retired `number` chart type. Stored option
// keys were renamed number* → value*; the `opts.valueX ?? opts.numberX`
// reads below are the accept-old fallback for any record that escaped
// the migrateNumberChartToValue boot migration.

import {
  columnIndex,
  toNumber,
  resolveTextThresholdColor,
  resolveNumericThresholdColor,
  contrastPartnerFor,
} from '../option-helpers.js';
import { formatNumberValue, applyTextCase, isNumericValue } from './number-formats.js';

/**
 * @param {Object} values   { data_mapping, options }
 * @param {Object} data     { columns: string[], rows: any[][] }
 * @param {Object} helpers  { formatCellValue, chartName }
 * @returns {Object|null}   { render: 'value', props } descriptor, or
 *                          null when no value column is configured
 */
export function buildOption(values, data, helpers = {}) {
  const { formatCellValue, chartName = '' } = helpers;
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};

  // Value column: spec binds to data_mapping.y_axis[0]. The entry may be
  // a bare string (saved record) or a { column, ... } object (the editor
  // preview passes objects, like line.js's normalizeYEntry handles).
  // Fall back to a legacy flat value_column field for old records.
  const firstY = Array.isArray(dm.y_axis) ? dm.y_axis[0] : undefined;
  const valueColumn = (typeof firstY === 'object' && firstY ? firstY.column : firstY) || dm.value_column || '';
  if (!valueColumn) return null;

  const rows = data?.rows || [];
  const idx = columnIndex(data, valueColumn);
  const rawCell = idx >= 0 && rows.length > 0 ? rows[0][idx] : null;

  // Which family of options applies: options.valueType is the author's
  // explicit declaration ('number' | 'text'), defaulting to 'auto' —
  // detect from the value itself. The explicit setting exists because
  // detection needs a sample: an empty result, a mixed column, or a
  // stream that hasn't produced a record yet would otherwise leave the
  // author unable to reach the options they need.
  //
  // Detection reads the RAW CELL, never the aggregate below: an
  // aggregate is always numeric, so deciding from it would flip a text
  // column ("online"/"offline" with a count configured) onto the numeric
  // path and render the row count in place of the status.
  const declaredType = opts.valueType || 'auto';
  const isText = declaredType === 'text'
    || (declaredType === 'auto' && rawCell != null && !isNumericValue(rawCell));

  // A configured aggregation (avg/min/max/sum/count) computes its scalar
  // into data.aggregatedValue and leaves `rows` UNTOUCHED — so reading
  // row 0 alone showed the first raw sample while the author had asked
  // for an average. Prefer the aggregate on the NUMERIC path only; a
  // text tile keeps its string. (first/last leave aggregatedValue null
  // unless an explicit field is chosen, and they already slice rows to
  // one, so both paths agree for them.)
  const aggValue = data?.aggregatedValue;
  const hasAgg = !isText && aggValue != null && Number.isFinite(Number(aggValue));
  const raw = hasAgg ? Number(aggValue) : rawCell;

  // Text path: render the string, optionally re-cased. The numeric
  // formats and decimals are meaningless here and the editor doesn't
  // offer them. Unit is NOT applied to text — the editor hides it for
  // this type, so honoring a stale stored value would render a suffix
  // the author can no longer see or remove.
  //
  // Numeric path: options.valueFormat picks how the raw value is
  // rendered (auto / plain / compact / duration / duration_clock /
  // datetime), with valueDecimals + valueDateFormat as sub-options. The
  // format implies the value's unit (duration→seconds, etc.), so no
  // query math is needed.
  //
  // formatNumberValue keeps its numberX parameter names — it is the
  // shared cell formatter used by the data grids too, so only the STORED
  // option keys renamed. Map value* → the formatter's param names here.
  let formatted;
  if (isText) {
    formatted = applyTextCase(raw == null ? '' : String(raw), opts.valueTextCase);
  } else {
    formatted = formatNumberValue(raw, valueColumn, {
      numberFormat: opts.valueFormat ?? opts.numberFormat,
      numberDecimals: opts.valueDecimals ?? opts.numberDecimals,
      numberDateFormat: opts.valueDateFormat ?? opts.numberDateFormat,
      numberSourceUnit: opts.valueSourceUnit ?? opts.numberSourceUnit,
    }, formatCellValue);
  }

  // valueSize is stored as a number on the legacy path but the enum
  // field writes a string; coerce and floor at a sane minimum. >0 guard
  // mirrors the default of 56.
  const rawSize = opts.valueSize ?? opts.numberSize;
  const size = toNumber(rawSize, 56) > 0 ? toNumber(rawSize, 56) : 56;
  // Unit is a numeric-only option (the editor hides it for text), so a
  // text value never renders one even if an old record still carries it.
  const unit = isText ? '' : (opts.valueUnit ?? opts.numberUnit ?? '');

  // Threshold coloring (#36). Text and numeric use different rule
  // shapes, matching the two option families: text matches on the string
  // (first rule wins), numeric bands by magnitude (highest reached
  // wins). null = no rule matched → the view keeps the default text
  // color, which is why "no thresholds configured" costs nothing.
  const thresholdColor = isText
    ? resolveTextThresholdColor(raw, opts.valueTextThresholds)
    : resolveNumericThresholdColor(toNumber(raw, NaN), opts.valueThresholds);

  // Static background fill (#214) — the author picks only the fill and the
  // readable partner is looked up from Carbon's aligned light/dark sets.
  // This is the tile's baseline: it applies whenever no threshold matched.
  const staticBackground = typeof opts.valueBackground === 'string' ? opts.valueBackground : '';

  // Where a MATCHED threshold's color lands. 'text' (default) is the
  // historical behavior — recolor the value and leave the fill alone.
  // 'background' fills the tile with the threshold color and derives a
  // readable text color from it, which is what makes a status tile read
  // green/red at a glance instead of needing the viewer to read the number.
  // 'both' fills AND uses the threshold color for the text; only legible on
  // a light fill, so the editor steers toward 'background'.
  //
  // Unmatched is deliberately NOT the same as 'text': with no rule matched
  // there is no threshold color to place anywhere, so every mode falls back
  // to the static fill. That keeps "no data yet"/"nothing exceptional" from
  // rendering as an un-filled tile in one mode and a filled one in another.
  const thresholdTarget = opts.valueThresholdTarget || 'text';
  const fillsBackground = thresholdColor && (thresholdTarget === 'background' || thresholdTarget === 'both');
  const background = fillsBackground ? thresholdColor : staticBackground;

  // Text color, in precedence order:
  //   1. 'background' mode with a match → derive from the threshold fill, so
  //      the value stays readable on it (the author never picks this).
  //   2. 'text'/'both' with a match → the threshold color itself.
  //   3. No match → the static fill's paired partner, or null to let the
  //      view use its default token when there's no fill either.
  let color;
  if (thresholdColor && thresholdTarget === 'background') {
    color = contrastPartnerFor(thresholdColor);
  } else if (thresholdColor) {
    color = thresholdColor;
  } else {
    color = staticBackground ? contrastPartnerFor(staticBackground) : null;
  }

  return {
    render: 'value',
    props: {
      formatted,
      unit,
      size,
      color,
      background,
      title: chartName || '',
    },
  };
}
