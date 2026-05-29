// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { getChartTypeSpec } from '../chart-spec';

// template_id → render(ctx) function.
//
// Currently EMPTY: gauge (the only Stage 1 string-emitter) has migrated
// to the end-state buildOption shape, so no chart type uses this path
// anymore. The registry + lookup are retained as the documented seam for
// any future chart type that needs a string-emitter template before it
// can move to buildOption. With the map empty,
// getCodegenTemplateForChartType always returns null and callers fall
// back to the legacy getDataDrivenChartCode dispatch.
const TEMPLATES = {};

/**
 * Look up the codegen template for a chart type via its spec. Returns
 * null when no spec exists or no template is registered. The legacy
 * getDataDrivenChartCode dispatch is the fallback in both cases.
 *
 * @param {string} chartType
 * @returns {null | { templateFn: function, spec: object }}
 */
export function getCodegenTemplateForChartType(chartType) {
  const spec = getChartTypeSpec(chartType);
  if (!spec || !spec.codegen) return null;
  const templateFn = TEMPLATES[spec.codegen.template_id];
  if (!templateFn) return null;
  return { templateFn, spec };
}
