// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import ComponentPanelWithActions from './ComponentPanelWithActions';
import { ControlRenderer } from './controls';
import FrigateCameraViewer from './frigate/FrigateCameraViewer';
import FrigateAlertsGrid from './frigate/FrigateAlertsGrid';
import WeatherDisplay from './weather/WeatherDisplay';
import PanelText from './PanelText';
import PanelErrorBoundary from './shared/PanelErrorBoundary';
import './DashboardGrid.scss';

const CELL_WIDTH = 32;
const CELL_HEIGHT = 32;
const GAP = 4;             // spacing.$spacing-02
const CONTAINER_PADDING = 4;

/**
 * DashboardGrid — read-only presentational render of a dashboard's panels.
 *
 * Extracted from DashboardViewerPage's view-mode render so it can be reused by
 * the kiosk surface. It owns its container measurement + fit-mode transform and
 * renders each panel's content (text / control / display / chart). It contains
 * NO edit affordances (drag, resize, hover headers) — the editor keeps those in
 * the page and only delegates the view-mode render here.
 *
 * Data is self-contained per panel: charts fetch via ComponentPanelWithActions
 * → DynamicComponentLoader → useData. The caller must wrap this in a
 * RefreshableComponentsProvider (the viewer and kiosk both do).
 *
 * connection resolution: `resolveConnectionId(component)` lets the caller
 * override a panel's connection (dashboard-variable connection-swap). The viewer
 * passes its hook's resolver; the kiosk passes one bound to the active entry's
 * forced connection.
 *
 * component resolution: `resolveComponent(panel)` lets the caller swap which
 * COMPONENT a panel renders based on the active variable (component-swap rules).
 * Returns the effective component_id, which must be present in chartsMap (the
 * caller pre-fetches override components). Optional — when absent, the panel's
 * own component_id is used.
 */
function DashboardGrid({
  panels,
  chartsMap,
  dashboard,
  resolveConnectionId,
  resolveComponent,
  dashboardVariableText = '',
  variableValues = {},
  dashboardVariableValue = null,
  rangeValue = null,
  dashboardCommand = null,
  canControl = false,
  refreshTick = 0,
  fitMode = 'window',
  scalePercent = 100,
  isFullscreen = false,
  onExpandPanel = null,
}) {
  const containerRef = useRef(null);
  const gridRef = useRef(null);
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const scaleFactor = (Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100) / 100;

  const hasPanels = panels && panels.length > 0;

  // View-mode grid bounds: tight around the panel extent (fall back to 60 when
  // there are no panels, matching the viewer).
  const maxGridCol = useMemo(() => {
    if (!hasPanels) return 60;
    return panels.reduce((max, p) => Math.max(max, p.x + p.w), 0) || 60;
  }, [panels, hasPanels]);
  const maxGridRow = useMemo(() => {
    if (!hasPanels) return 60;
    return panels.reduce((max, p) => Math.max(max, p.y + p.h), 0) || 60;
  }, [panels, hasPanels]);

  // Measure the container so fit-mode can scale to it. Double-rAF lets CSS class
  // changes (overflow) paint before measuring; ResizeObserver catches
  // size changes that don't fire a window resize.
  useEffect(() => {
    if (!hasPanels) return undefined;
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w !== lastSizeRef.current.width || h !== lastSizeRef.current.height) {
        lastSizeRef.current = { width: w, height: h };
        setContainerSize({ width: w, height: h });
      }
    };
    let raf1, raf2;
    raf1 = requestAnimationFrame(() => { raf2 = requestAnimationFrame(measure); });
    window.addEventListener('resize', measure);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined' && containerRef.current) {
      ro = new ResizeObserver(() => measure());
      ro.observe(containerRef.current);
    }
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
  }, [hasPanels, isFullscreen, fitMode]);

  // Fit-to-screen transform (view-mode only — no edit branch here).
  //   actual  → native target size (scale only when scaleFactor != 1)
  //   window  → scale(min(sx,sy)) uniform, nothing clipped
  //   width   → scale(sx) fill width, vertical scroll if needed
  //   stretch → scale(sx, sy) fill both axes
  const fitTransform = useMemo(() => {
    const gridNativeW = maxGridCol * CELL_WIDTH + (maxGridCol - 1) * GAP;
    const gridNativeH = maxGridRow * CELL_HEIGHT + (maxGridRow - 1) * GAP;
    const targetW = gridNativeW * scaleFactor;
    const targetH = gridNativeH * scaleFactor;

    if (fitMode === 'actual') {
      if (scaleFactor === 1) return { transform: '', scaledW: 0, scaledH: 0 };
      return { transform: `scale(${scaleFactor})`, scaledW: targetW, scaledH: targetH };
    }
    if (!containerSize.width || !containerSize.height) {
      return { transform: '', scaledW: 0, scaledH: 0 };
    }
    const availW = containerSize.width - 2 * CONTAINER_PADDING;
    const availH = containerSize.height - 2 * CONTAINER_PADDING;
    const sx = availW / targetW;
    const sy = availH / targetH;
    if (fitMode === 'stretch') {
      return { transform: `scale(${sx * scaleFactor}, ${sy * scaleFactor})`, scaledW: targetW * sx, scaledH: targetH * sy };
    }
    if (fitMode === 'width') {
      return { transform: `scale(${sx * scaleFactor})`, scaledW: targetW * sx, scaledH: targetH * sx };
    }
    const s = Math.min(sx, sy);
    return { transform: `scale(${s * scaleFactor})`, scaledW: targetW * s, scaledH: targetH * s };
  }, [fitMode, containerSize.width, containerSize.height, maxGridCol, maxGridRow, scaleFactor]);

  if (!hasPanels) return null;

  return (
    <div ref={containerRef} className={`dashboard-grid-container fit-mode-${fitMode}`}>
      <div
        className="dashboard-grid-scale-wrapper"
        style={fitTransform.scaledW > 0 ? { width: fitTransform.scaledW, height: fitTransform.scaledH } : {}}
      >
        <div
          ref={gridRef}
          className="dashboard-grid"
          style={{
            gridTemplateColumns: `repeat(${maxGridCol}, ${CELL_WIDTH}px)`,
            gridTemplateRows: `repeat(${maxGridRow}, ${CELL_HEIGHT}px)`,
            ...(fitTransform.transform ? { transform: fitTransform.transform, transformOrigin: 'top left' } : {}),
          }}
        >
          {panels.map((panel) => {
            // Effective component for this panel: a component-swap rule may pick
            // an alternate component_id based on the active variable; otherwise
            // the panel's own component_id. The resolved id must be in chartsMap
            // (override components are pre-fetched by the caller).
            const effectiveComponentId = resolveComponent
              ? resolveComponent(panel)
              : panel.component_id;
            const chart = effectiveComponentId ? chartsMap[effectiveComponentId] : null;
            const hasText = !!panel.text_config;
            const hasChart = !hasText && (!!chart?.component_code || chart?.component_type === 'control' || chart?.component_type === 'display');
            const hasContent = hasText || hasChart;

            const expandableDisplayTypes = new Set(['weather', 'frigate_camera']);
            const isLegacyChart = !!chart?.component_code
              && chart?.component_type !== 'control'
              && chart?.component_type !== 'display';
            const canExpand = !!onExpandPanel && hasChart && (
              chart?.component_type === 'chart'
              || isLegacyChart
              || (chart?.component_type === 'display' && expandableDisplayTypes.has(chart?.display_config?.display_type))
            );

            return (
              <div
                key={panel.id}
                data-panel-id={panel.id}
                // Native hover tooltip shows the component NAME (the internal
                // identifier) when a component is involved — the canvas shows the
                // display TITLE, so the hover surfaces the name behind it. Text
                // panels have no component, so no tooltip.
                title={hasChart ? (chart?.name || undefined) : undefined}
                className={`panel-container ${hasContent ? 'has-component' : 'empty-panel'} ${hasText ? 'text-panel' : ''} ${chart?.control_config?.control_type === 'text_label' ? 'text-label-panel' : ''}`}
                style={{
                  gridColumn: `${panel.x + 1} / span ${panel.w}`,
                  gridRow: `${panel.y + 1} / span ${panel.h}`,
                  cursor: hasChart && onExpandPanel ? 'pointer' : 'default',
                }}
                onDoubleClick={canExpand ? () => onExpandPanel(panel.id) : undefined}
              >
                <PanelErrorBoundary
                  resetKey={`${effectiveComponentId || panel.id}-${chart?.updated || ''}`}
                  label={chart?.title || chart?.name || (hasText ? 'Text panel' : 'Component')}
                >
                {hasText ? (
                  <div className="component-wrapper text-wrapper">
                    <PanelText config={panel.text_config} dashboardVariableText={dashboardVariableText} variableValues={variableValues} />
                  </div>
                ) : hasChart ? (
                  <>
                    {chart.component_type === 'control' ? (
                      <div className="component-wrapper control-wrapper" onDoubleClick={(e) => e.stopPropagation()}>
                        <ControlRenderer control={chart} canControl={canControl} />
                      </div>
                    ) : chart.component_type === 'display' ? (
                      <div className="component-wrapper display-wrapper">
                        {chart.display_config?.display_type === 'weather' ? (
                          <WeatherDisplay config={chart.display_config} />
                        ) : chart.display_config?.display_type === 'frigate_camera' ? (
                          <FrigateCameraViewer config={chart.display_config} dashboardCommand={dashboardCommand} />
                        ) : chart.display_config?.display_type === 'frigate_alerts' ? (
                          <FrigateAlertsGrid config={chart.display_config} dashboardCommand={dashboardCommand} canControl={canControl} refreshTick={refreshTick} />
                        ) : (
                          <div className="display-empty">Unknown display type</div>
                        )}
                      </div>
                    ) : (
                      <>
                        {chart.chart_type === 'datatable' && (
                          <div className="chart-header">
                            <span className="chart-name">{chart.title || chart.name || 'Untitled Chart'}</span>
                          </div>
                        )}
                        <div className={`component-wrapper ${chart.chart_type === 'datatable' ? 'with-header' : ''} ${chart.chart_type === 'dataview' ? 'dataview-wrapper' : ''} ${(chart.chart_type === 'datatable' || (chart.options?.showTitle !== false && (chart.title || chart.name))) ? 'has-title' : ''}`}>
                          <ComponentPanelWithActions
                            key={`${effectiveComponentId}-${chart.updated || ''}`}
                            chart={chart}
                            loaderProps={{
                              code: chart.component_code,
                              props: {},
                              componentMeta: chart,
                              dataMapping: chart.data_mapping,
                              connectionId: resolveConnectionId ? resolveConnectionId(chart) : chart.connection_id,
                              queryConfig: chart.query_config,
                              dataRefreshInterval: dashboard?.settings?.refresh_interval > 0 ? dashboard.settings.refresh_interval * 1000 : null,
                              refreshTick,
                              dashboardVariableValue,
                              rangeValue,
                            }}
                          />
                        </div>
                      </>
                    )}
                  </>
                ) : (
                  <div className="empty-panel-placeholder">
                    <span>No chart</span>
                  </div>
                )}
                </PanelErrorBoundary>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

DashboardGrid.propTypes = {
  panels: PropTypes.array,
  chartsMap: PropTypes.object,
  dashboard: PropTypes.object,
  resolveConnectionId: PropTypes.func,
  resolveComponent: PropTypes.func,
  dashboardVariableText: PropTypes.string,
  variableValues: PropTypes.object,
  dashboardVariableValue: PropTypes.string,
  rangeValue: PropTypes.object,
  dashboardCommand: PropTypes.object,
  canControl: PropTypes.bool,
  refreshTick: PropTypes.number,
  fitMode: PropTypes.string,
  scalePercent: PropTypes.number,
  isFullscreen: PropTypes.bool,
  onExpandPanel: PropTypes.func,
};

export default DashboardGrid;
