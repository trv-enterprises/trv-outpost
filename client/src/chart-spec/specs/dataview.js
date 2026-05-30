// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// dataview "buildOption" — a non-ECharts spec-driven type. Returns a
// tagged view descriptor; SpecDrivenChart renders the registered
// <DataViewGrid> (AG Grid) from the view registry. See
// docs/design-notes/spec-driven-non-echarts-views.md.
//
// dataview reads the whole result set (not a single value / xy series),
// so buildOption does no data crunching — it just forwards the column
// config to the grid view, which owns rows / streaming / layout. The
// `data` arg is unused here for that reason.

/**
 * @param {Object} values   { data_mapping, options }
 * @param {Object} _data     unused — the grid view reads dataCtx.data itself
 * @param {Object} helpers  { xAxisFormat }
 * @returns {Object}        { render: 'dataview', props } descriptor
 */
export function buildOption(values, _data, helpers = {}) {
  const dm = values?.data_mapping || {};
  // visible_columns: null/undefined = show all (back-compat). An explicit
  // array (even empty = hide all) is an ordered whitelist.
  const visibleColumnsConfig = Array.isArray(dm.visible_columns) ? dm.visible_columns : null;
  const columnAliases = dm.column_aliases && typeof dm.column_aliases === 'object' ? dm.column_aliases : {};
  const xAxisFormat = dm.x_axis_format || helpers.xAxisFormat || 'short';

  return {
    render: 'dataview',
    props: {
      columnAliases,
      visibleColumnsConfig,
      xAxisFormat,
    },
  };
}
