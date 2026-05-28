// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { getChartTypeSpec } from '../chart-spec';
import { renderGaugeV1 } from './echarts/templates/gauge_v1';

// template_id → render(ctx) function. PR 1: gauge only.
const TEMPLATES = {
  gauge_v1: renderGaugeV1,
};

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
