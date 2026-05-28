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

const BUILD_OPTIONS = {
  line: buildLineOption,
  // bar, area, pie, scatter, number, dataview, banded_bar — added as
  // each chart type's <type>.js lands during Stage 2.
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
