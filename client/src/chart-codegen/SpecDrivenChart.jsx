// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useContext, useMemo, useState } from 'react';
import { DataContext, ComponentConfigContext } from '../components/DynamicComponentLoader';
import { formatCellValue } from '../utils/dataTransforms';
import { getBuildOptionForChartType, hasBuildOption } from '../chart-spec/build-options';
import ChartShell from '../chart-spec/ChartShell';

/**
 * Thin adapter between the dynamic loader's contexts and a chart-type's
 * `buildOption(values, data, helpers)`. It:
 *   - reads DataContext (data) + ComponentConfigContext (saved config),
 *   - picks the right buildOption for `specName`,
 *   - tracks legend visibility (for dual-axis dead-axis hiding),
 *   - hands the resulting option to <ChartShell>, which owns all the
 *     shared React/DOM treatment (title, loading/error/no-data, theme).
 *
 * Wired into the codegen dispatch (`getDataDrivenChartCode`): when a
 * chart_type has a buildOption module, the emitted code is essentially
 * `const Component = () => <SpecDrivenChart specName="line" />;`.
 */
export default function SpecDrivenChart({ specName }) {
  const dataCtx = useContext(DataContext);
  const config = useContext(ComponentConfigContext);

  // Mirror ECharts' legend selection so buildOption can react to it
  // (line's dual-axis dead-axis hide). Null until the first toggle.
  const [legendSelected, setLegendSelected] = useState(null);

  const handleLegendSelectChanged = useCallback((params) => {
    if (params && params.selected) {
      setLegendSelected({ ...params.selected });
    }
  }, []);

  const onEvents = useMemo(() => ({
    legendselectchanged: handleLegendSelectChanged,
  }), [handleLegendSelectChanged]);

  const option = useMemo(() => {
    const build = getBuildOptionForChartType(specName);
    if (!build) {
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
      legendSelected,
    });
  }, [specName, config, dataCtx?.data, legendSelected]);

  return (
    <ChartShell
      config={config}
      dataCtx={dataCtx}
      option={option}
      onEvents={onEvents}
      misconfiguredMessage={`Spec-driven chart misconfigured: no buildOption for chart_type "${specName}"`}
    />
  );
}

/**
 * Re-export the predicate so the codegen dispatch can ask "does this
 * chart_type have a Stage-2 build path?" without importing two modules.
 */
export { hasBuildOption };
