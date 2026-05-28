// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { assertValidChartTypeSpec } from './schema-validator';
import gaugeSpec from './specs/gauge.json';

// Validate every spec at module load so a malformed spec fails fast in
// dev. PR 1 only ships gauge; PR 2 adds the remaining 8 chart types.
const SPECS = {
  gauge: assertValidChartTypeSpec(gaugeSpec, 'specs/gauge.json'),
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
 * Returns all chart types that have a spec. PR 1: ['gauge'].
 *
 * @returns {string[]}
 */
export function listSpecChartTypes() {
  return Object.keys(SPECS);
}
