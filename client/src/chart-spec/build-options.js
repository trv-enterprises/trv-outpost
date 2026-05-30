// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Stage 2 end-state shape: per-chart-type `buildOption(values, data, helpers)`
// pure functions. The generic shell (SpecDrivenChart) imports and calls
// these. Co-located with the JSON specs under specs/<chart_type>.{json,js}
// — the registry IS the filesystem: a chart type is "spec-driven for
// render" iff `specs/<chart_type>.js` exports `buildOption`.
//
// We use an explicit map rather than dynamic import() so the renderer
// stays synchronous and Vite tree-shakes unused chart types out of
// any future per-route bundles.

import { buildOption as buildLineOption } from './specs/line';
import { buildOption as buildGaugeOption } from './specs/gauge';
import { buildOption as buildPieOption } from './specs/pie';
import { buildOption as buildScatterOption } from './specs/scatter';
import { buildOption as buildBandedBarOption } from './specs/banded_bar';
import { buildOption as buildNumberOption } from './specs/number';

const BUILD_OPTIONS = {
  line: buildLineOption,
  // gauge migrated from the Stage 1 string-emitter (gauge_v1.js) to the
  // end-state buildOption shape. Its own module — gauge is structurally
  // unlike line (single dial value, no axes), so it doesn't share the
  // line dispatch.
  gauge: buildGaugeOption,
  // bar shares line.js's render — line.js dispatches on chartType.
  // The form spec (bar.json) differs from line.json (no smoothing /
  // symbol / sampling controls), so the editor still gets bar-specific
  // sections; only the render is shared.
  bar: buildLineOption,
  // area is line + fill — line.js sets areaStyle and boundaryGap:false
  // when chartType==='area'. Keeps the full chart-options set (smooth,
  // showSymbol, sampling), unlike bar.
  area: buildLineOption,
  // pie has its own module — one label column + one value column, no
  // x/y axes, so it doesn't share the line dispatch.
  pie: buildPieOption,
  // scatter has its own module — numeric [x,y] points on value axes,
  // optional bubble sizing + color-by-category. Doesn't share line.
  scatter: buildScatterOption,
  // banded_bar has its own module — Levey-Jennings per-row mean + SD
  // envelope across four visual styles. Doesn't share line.
  banded_bar: buildBandedBarOption,
  // number is non-ECharts: its buildOption returns a { render: 'number' }
  // descriptor that SpecDrivenChart renders via the view registry (not
  // ChartShell/ReactECharts). See docs/design-notes/spec-driven-non-echarts-views.md.
  number: buildNumberOption,
  // dataview — added when its DataViewGrid view + column_manager field land.
};

/**
 * Look up the buildOption function for a chart type. Returns null
 * when the chart type has no JS module yet (caller falls back to
 * Stage 1 string-template codegen or legacy).
 *
 * @param {string} chartType
 * @returns {Function|null}
 */
export function getBuildOptionForChartType(chartType) {
  return BUILD_OPTIONS[chartType] || null;
}

/**
 * True if this chart type has a buildOption module (Stage 2 path)
 * rather than a string-template (Stage 1 path) or no spec at all.
 *
 * @param {string} chartType
 * @returns {boolean}
 */
export function hasBuildOption(chartType) {
  return Boolean(BUILD_OPTIONS[chartType]);
}
