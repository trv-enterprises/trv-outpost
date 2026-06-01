// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// number "buildOption" — a non-ECharts spec-driven type. Instead of an
// ECharts option it returns a tagged view descriptor; SpecDrivenChart
// renders the registered <NumberView> from the view registry. See
// docs/design-notes/spec-driven-non-echarts-views.md.
//
// Same data contract as gauge: read the first y-axis column from the
// first (post-aggregation) row.

import { columnIndex, toNumber } from '../option-helpers.js';
import { formatNumberValue } from './number-formats.js';

/**
 * @param {Object} values   { data_mapping, options }
 * @param {Object} data     { columns: string[], rows: any[][] }
 * @param {Object} helpers  { formatCellValue, chartName }
 * @returns {Object|null}   { render: 'number', props } descriptor, or
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

  // Value formatting: options.numberFormat picks how the raw value is
  // rendered (auto / plain / compact / duration / duration_clock /
  // datetime), with numberDecimals + numberDateFormat as sub-options. The
  // format implies the value's unit (duration→seconds, etc.), so no query
  // math is needed. Defaults to 'auto' (the prior behavior). See
  // number-formats.js.
  const formatted = formatNumberValue(raw, valueColumn, opts, formatCellValue);

  // numberSize is stored as a number on the legacy path but the enum
  // field writes a string; coerce and floor at a sane minimum. >0 guard
  // mirrors the legacy default of 120.
  const size = toNumber(opts.numberSize, 120) > 0 ? toNumber(opts.numberSize, 120) : 120;
  const unit = opts.numberUnit || '';

  return {
    render: 'number',
    props: {
      formatted,
      unit,
      size,
      title: chartName || '',
    },
  };
}
