// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useContext, useMemo, useState } from 'react';
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

  // Tracks which legend entries are currently visible. ECharts owns
  // the canonical visibility state internally; we mirror it here so
  // buildOption can react to it (e.g. dual-axis line hides the dead
  // axis when its sole series is toggled off). Null = "no toggle has
  // happened yet, assume everything visible." A {name: bool} map
  // appears on the first legendselectchanged event.
  const [legendSelected, setLegendSelected] = useState(null);

  const handleLegendSelectChanged = useCallback((params) => {
    // params.selected is `{seriesName: boolean}` — ECharts' authoritative
    // snapshot of which legend entries are currently selected. Store as
    // a fresh object so React picks up the change.
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
      // Map of seriesName → visible. Undefined when no toggle has
      // happened yet — buildOption treats undefined as "all visible."
      legendSelected,
    });
  }, [specName, config, dataCtx?.data, legendSelected]);

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

  // Title is rendered as an HTML div above the ECharts canvas — same
  // convention legacy line/area/bar codegen uses (see
  // ComponentEditor.jsx getDataDrivenChartCode `titleHeader`). Keeps
  // the title centered on the full panel regardless of y-axis label
  // width or legend, and avoids the option.title vs option.legend
  // top-of-canvas collision.
  const chartName = config?.title || config?.name || '';
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      {chartName ? (
        <div style={{
          display: 'block',
          height: '2.5rem',
          lineHeight: '2.5rem',
          flexShrink: 0,
          padding: '0 0.75rem',
          fontSize: '1rem',
          fontWeight: 600,
          color: 'var(--cds-text-primary)',
          textAlign: 'center',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {chartName}
        </div>
      ) : null}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts
          option={option}
          style={{ height: '100%', width: '100%' }}
          theme="carbon-dark"
          onEvents={onEvents}
        />
      </div>
    </div>
  );
}

/**
 * Re-export the predicate so the codegen dispatch can ask "does this
 * chart_type have a Stage-2 build path?" without importing two
 * modules.
 */
export { hasBuildOption };
