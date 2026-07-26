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
import bandedBarSpec from './specs/banded_bar.json';
import valueSpec from './specs/value.json';
import dataviewSpec from './specs/dataview.json';

// Validate every spec at module load so a malformed spec fails fast in
// dev. Stage 1 shipped gauge; Stage 2: line, bar, area, pie, scatter,
// banded_bar, value, dataview. Other chart types follow.
const SPECS = {
  gauge: assertValidChartTypeSpec(gaugeSpec, 'specs/gauge.json'),
  line: assertValidChartTypeSpec(lineSpec, 'specs/line.json'),
  bar: assertValidChartTypeSpec(barSpec, 'specs/bar.json'),
  area: assertValidChartTypeSpec(areaSpec, 'specs/area.json'),
  pie: assertValidChartTypeSpec(pieSpec, 'specs/pie.json'),
  scatter: assertValidChartTypeSpec(scatterSpec, 'specs/scatter.json'),
  banded_bar: assertValidChartTypeSpec(bandedBarSpec, 'specs/banded_bar.json'),
  value: assertValidChartTypeSpec(valueSpec, 'specs/value.json'),
  dataview: assertValidChartTypeSpec(dataviewSpec, 'specs/dataview.json'),
};

// `number` is the retired name of the value type. A record that escaped
// the boot migration must still resolve a spec (the editor gates its
// whole spec-driven form on getChartTypeSpec), so alias it to the value
// spec. Deliberately NOT in SPECS itself — listSpecChartTypes() drives
// UI lists and must not offer the dead name.
const SPEC_ALIASES = {
  number: 'value',
};

function resolveChartType(chartType) {
  return SPEC_ALIASES[chartType] || chartType;
}

/**
 * Returns the ChartTypeSpec for a given chart type, or null if no spec
 * exists yet. Callers must fall back to the legacy JSX/codegen paths
 * when the result is null.
 *
 * @param {string} chartType
 * @returns {object|null}
 */
export function getChartTypeSpec(chartType) {
  return SPECS[resolveChartType(chartType)] || null;
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
  return Boolean(SPECS[resolveChartType(chartType)]);
}

/**
 * Returns all chart types that have a spec.
 *
 * @returns {string[]}
 */
export function listSpecChartTypes() {
  return Object.keys(SPECS);
}
