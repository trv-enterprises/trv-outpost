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

import { columnIndex, toNumber } from '../option-helpers.js';
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
  const raw = idx >= 0 && rows.length > 0 ? rows[0][idx] : null;

  // Which family of options applies: options.valueType is the author's
  // explicit declaration ('number' | 'text'), defaulting to 'auto' —
  // detect from the value itself. The explicit setting exists because
  // detection needs a sample: an empty result, a mixed column, or a
  // stream that hasn't produced a record yet would otherwise leave the
  // author unable to reach the options they need.
  const declaredType = opts.valueType || 'auto';
  const isText = declaredType === 'text'
    || (declaredType === 'auto' && raw != null && !isNumericValue(raw));

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

  return {
    render: 'value',
    props: {
      formatted,
      unit,
      size,
      title: chartName || '',
    },
  };
}
