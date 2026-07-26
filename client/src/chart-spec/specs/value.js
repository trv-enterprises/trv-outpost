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
import { formatNumberValue } from './number-formats.js';

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

  // Value formatting: options.valueFormat picks how the raw value is
  // rendered (auto / plain / compact / duration / duration_clock /
  // datetime), with valueDecimals + valueDateFormat as sub-options. The
  // format implies the value's unit (duration→seconds, etc.), so no query
  // math is needed. Defaults to 'auto'. A non-numeric raw value renders
  // as its own string regardless of the numeric format. See
  // number-formats.js.
  //
  // formatNumberValue keeps its numberX parameter names — it is the
  // shared cell formatter used by the data grids too, so only the STORED
  // option keys renamed. Map value* → the formatter's param names here.
  const formatted = formatNumberValue(raw, valueColumn, {
    numberFormat: opts.valueFormat ?? opts.numberFormat,
    numberDecimals: opts.valueDecimals ?? opts.numberDecimals,
    numberDateFormat: opts.valueDateFormat ?? opts.numberDateFormat,
  }, formatCellValue);

  // valueSize is stored as a number on the legacy path but the enum
  // field writes a string; coerce and floor at a sane minimum. >0 guard
  // mirrors the default of 56.
  const rawSize = opts.valueSize ?? opts.numberSize;
  const size = toNumber(rawSize, 56) > 0 ? toNumber(rawSize, 56) : 56;
  const unit = opts.valueUnit ?? opts.numberUnit ?? '';

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
