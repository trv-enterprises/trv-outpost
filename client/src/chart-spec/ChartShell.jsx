// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import ReactECharts from 'echarts-for-react';

/**
 * Generic chart shell — the React/DOM layer shared by every spec-driven
 * chart (line/bar/area/gauge/...) AND, eventually, AI custom-code charts.
 *
 * Owns the cross-chart treatments that are NOT part of the ECharts
 * option literal:
 *   - the HTML title header (rendered outside ECharts so it centers on
 *     the full panel and never collides with option.legend — the
 *     convention legacy line/area/bar codegen established).
 *   - loading / error / no-data placeholders.
 *   - the flex column wrapper that gives ECharts a sized child.
 *   - the carbon-dark theme + onEvents passthrough.
 *
 * Per-chart-type code only produces the `option` literal (via its
 * buildOption) and hands it here. Title rendering is unified by
 * construction — gauge and line get the identical header treatment
 * instead of each drifting (the old gauge string-emitter put the title
 * inside option.title; line put it in an HTML div — ChartShell ends
 * that split).
 *
 * @param {object}   props
 * @param {object}   props.config        Saved component config ({title, name, ...}).
 * @param {object}   props.dataCtx       DataContext value ({data, loading, error}).
 * @param {object}   props.option        The ECharts option literal (null → misconfigured).
 * @param {object}   [props.onEvents]    ECharts event handlers passthrough.
 * @param {string}   [props.misconfiguredMessage]  Shown when option is null.
 */
export default function ChartShell({ config, dataCtx, option, onEvents, misconfiguredMessage }) {
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
        {misconfiguredMessage || 'Chart misconfigured.'}
      </div>
    );
  }

  // Title is suppressible per-component via options.showTitle (default
  // on). Off → don't render the header band at all, so the chart body
  // gets the full panel height (use a Text panel for a custom/giant
  // title). Uniform across every chart type — see the same guard in
  // NumberView / DataViewGrid.
  const showTitle = config?.options?.showTitle !== false;
  const chartName = showTitle ? (config?.title || config?.name || '') : '';
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
