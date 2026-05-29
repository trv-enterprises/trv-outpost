// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { assertValidChartTypeSpec } from './schema-validator';
import gaugeSpec from './specs/gauge.json';
import lineSpec from './specs/line.json';
import barSpec from './specs/bar.json';
import areaSpec from './specs/area.json';
import pieSpec from './specs/pie.json';
import scatterSpec from './specs/scatter.json';

// Validate every spec at module load so a malformed spec fails fast in
// dev. Stage 1 shipped gauge; Stage 2: line, bar, area, pie, scatter.
// Other chart types follow.
const SPECS = {
  gauge: assertValidChartTypeSpec(gaugeSpec, 'specs/gauge.json'),
  line: assertValidChartTypeSpec(lineSpec, 'specs/line.json'),
  bar: assertValidChartTypeSpec(barSpec, 'specs/bar.json'),
  area: assertValidChartTypeSpec(areaSpec, 'specs/area.json'),
  pie: assertValidChartTypeSpec(pieSpec, 'specs/pie.json'),
  scatter: assertValidChartTypeSpec(scatterSpec, 'specs/scatter.json'),
};

/**
 * Returns the ChartTypeSpec for a given chart type, or null if no spec
 * exists yet. Callers must fall back to the legacy JSX/codegen paths
 * when the result is null.
 *
 * @param {string} chartType
 * @returns {object|null}
 */
export function getChartTypeSpec(chartType) {
  return SPECS[chartType] || null;
}

/**
 * True if a spec exists for this chart type. Used by the editor and
 * codegen feature switches to decide whether to dispatch to the spec
 * path or the legacy path.
 *
 * @param {string} chartType
 * @returns {boolean}
 */
export function hasChartTypeSpec(chartType) {
  return Boolean(SPECS[chartType]);
}

/**
 * Returns all chart types that have a spec.
 *
 * @returns {string[]}
 */
export function listSpecChartTypes() {
  return Object.keys(SPECS);
}
