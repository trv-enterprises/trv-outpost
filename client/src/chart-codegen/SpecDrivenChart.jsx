// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useContext, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import { DataContext, ComponentConfigContext } from '../components/DynamicComponentLoader';
import { formatCellValue } from '../utils/dataTransforms';
import { getBuildOptionForChartType, hasBuildOption } from '../chart-spec/build-options';

/**
 * Generic shell that turns a spec-driven chart into a rendered
 * React + ECharts element. One copy for every spec-driven chart
 * type. The chart-type's `buildOption(values, data, helpers)` does
 * all the per-chart-type work.
 *
 * Wired into the codegen dispatch (`getDataDrivenChartCode`) so that
 * when `chart_codegen_spec_driven` is on AND the chart_type has a
 * Stage-2 buildOption module, the emitted code string is essentially
 * `const Component = () => <SpecDrivenChart specName="line" />;`.
 *
 * The shell reads its inputs from the contexts the loader already
 * provides — DataContext for the data, ComponentConfigContext for
 * the saved chart config. So the eval'd component code doesn't need
 * to pass anything through props; it just mounts the shell with the
 * chart-type name.
 */
export default function SpecDrivenChart({ specName }) {
  const dataCtx = useContext(DataContext);
  const config = useContext(ComponentConfigContext);

  const option = useMemo(() => {
    const build = getBuildOptionForChartType(specName);
    if (!build) {
      // Chart type doesn't have a buildOption module yet. Render a
      // visible placeholder rather than crashing — the editor's
      // codegen flag should have routed elsewhere, so seeing this in
      // production is a wiring bug.
      // eslint-disable-next-line no-console
      console.warn(`[SpecDrivenChart] no buildOption for chart_type="${specName}"`);
      return null;
    }
    const values = {
      data_mapping: config?.data_mapping || {},
      options: config?.options || {},
    };
    return build(values, dataCtx?.data || { columns: [], rows: [] }, {
      formatCellValue,
      chartType: specName,
      xAxisFormat: config?.transforms?.x_axis_format || config?.data_mapping?.x_axis_format || 'chart',
      chartName: config?.title || config?.name || '',
    });
  }, [specName, config, dataCtx?.data]);

  if (dataCtx?.loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        Loading...
      </div>
    );
  }
  if (dataCtx?.error) {
    return (
      <div style={{ color: '#da1e28', padding: '1rem' }}>
        Error: {dataCtx.error.message || String(dataCtx.error)}
      </div>
    );
  }
  if (!dataCtx?.data?.rows?.length) {
    return (
      <div style={{ color: '#6f6f6f', padding: '1rem' }}>
        No data
      </div>
    );
  }
  if (!option) {
    return (
      <div style={{ color: '#da1e28', padding: '1rem' }}>
        Spec-driven chart misconfigured: no buildOption for chart_type &quot;{specName}&quot;
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
    </div>
  );
}

/**
 * Re-export the predicate so the codegen dispatch can ask "does this
 * chart_type have a Stage-2 build path?" without importing two
 * modules.
 */
export { hasBuildOption };
