// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// pie buildOption — end-state Stage 2 shape. Pie is structurally unlike
// line (one label column + one value column, no x/y axes), so it has its
// own module rather than sharing line.js. ChartShell renders the title;
// this returns only the ECharts option literal.

import {
  COLOR_TEXT_SECONDARY,
  TRANSPARENT_BG,
  toNumber,
  columnIndex,
  makeValueFormatter,
} from '../option-helpers.js';

/**
 * Build the legend block. Pie defaults to a vertical legend on the left
 * (matches legacy). Hidden when show:false.
 */
function buildLegend(legend) {
  if (legend?.show === false) return undefined;
  const pos = legend?.position || 'left';
  const block = { textStyle: { color: COLOR_TEXT_SECONDARY } };
  switch (pos) {
    case 'top':    block.top = 0; break;
    case 'bottom': block.bottom = 0; break;
    case 'right':  block.right = 0; block.orient = 'vertical'; break;
    case 'left':
    default:       block.left = 0; block.orient = 'vertical'; break;
  }
  return block;
}

/**
 * Main entry point. Pure function.
 *
 * @param {Object} values  Form state: { data_mapping, options }
 * @param {Object} data    Query result: { columns: string[], rows: any[][] }
 * @returns {Object} an ECharts `option` literal
 */
export function buildOption(values, data) {
  const dm = values?.data_mapping || {};
  const opts = values?.options || {};

  const labelCol = dm.x_axis || '';
  // Value column binds to y_axis[0] (array) with a legacy flat fallback.
  const valueCol = (Array.isArray(dm.y_axis) ? dm.y_axis[0] : undefined) || dm.value_column || '';

  const rows = data?.rows || [];
  const labelIdx = columnIndex(data, labelCol);
  const valueIdx = columnIndex(data, valueCol);
  const pieData = (labelIdx >= 0 && valueIdx >= 0)
    ? rows.map((r) => ({ name: String(r[labelIdx]), value: toNumber(r[valueIdx], 0) }))
    : [];

  const innerPct = toNumber(opts.pieInnerRadius, 0);
  const radius = innerPct > 0 ? [`${innerPct}%`, '70%'] : '70%';
  const showLabels = opts.pieShowLabels !== false;

  // Tooltip: name + value (decimals/units formatted) + percent. The
  // shared formatter handles decimals + unit suffix; ECharts supplies
  // the percent via params.percent.
  const tt = opts.tooltip || {};
  const formatValue = makeValueFormatter(tt.decimals, tt.units);

  const option = {
    backgroundColor: TRANSPARENT_BG,
    tooltip: {
      trigger: 'item',
      formatter: (p) => `${p.name}: ${formatValue(p.value)} (${p.percent}%)`,
    },
    series: [{
      type: 'pie',
      radius,
      data: pieData,
      label: showLabels ? { show: true, color: COLOR_TEXT_SECONDARY } : { show: false },
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } },
    }],
  };

  const legend = buildLegend(opts.legend || {});
  if (legend) option.legend = legend;

  return option;
}
