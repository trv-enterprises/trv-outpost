// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import { Tooltip } from '@carbon/react';
import { WarningAltFilled } from '@carbon/icons-react';
import ComponentPanelWithActions from './ComponentPanelWithActions';
import { ControlRenderer } from './controls';
import FrigateCameraViewer from './frigate/FrigateCameraViewer';
import FrigateAlertsGrid from './frigate/FrigateAlertsGrid';
import WeatherDisplay from './weather/WeatherDisplay';
import PanelText from './PanelText';
import PanelErrorBoundary from './shared/PanelErrorBoundary';

/**
 * Shared per-panel CONTENT subtree — the text / control / display / chart
 * render, including the streaming-capable <ComponentPanelWithActions>.
 *
 * Why this is its own component (the streaming-safe edit↔view fix): the
 * dashboard viewer and editor are one page; the edit↔view toggle is an
 * in-place `isEditMode` flip, NOT a remount. For a streaming chart to keep
 * its live subscription across that flip, its element must keep the SAME
 * component-type path from root to panel in both modes — otherwise React
 * unmounts and remounts it (charts blank then re-fetch). The view path
 * (<DashboardGrid>) and the editor's inline grid render DIFFERENT outer
 * chrome, but both render THIS component for the panel body. Because
 * PanelContent is the same type at the same relative position with the
 * same key, React reconciles it across the flip instead of remounting —
 * so the subscription survives. Keep the rendered structure here identical
 * for both callers; per-mode differences go through props (e.g.
 * dataRefreshInterval is null in edit mode).
 *
 * This regressed at v0.26.0 when the kiosk refactor split the single grid
 * tree into <DashboardGrid> (view) + an inline edit grid; sharing the panel
 * body restores the v0.13.3 streaming-safe guarantee without merging the
 * two outer trees. See docs + project memory `dashboard-editor-two-trees`.
 */
function PanelContent({
  panel,
  chart,
  effectiveComponentId,
  hasText,
  hasChart,
  // #4: "component" | "connection" when this panel's component (or the
  // connection it reads) is in a namespace the viewer can't see. The
  // dashboard still mounts; only the affected panels show this error.
  unauthorizedReason = null,
  swapIssue = null,
  resolveConnectionId,
  dashboardVariableText = '',
  variableValues = {},
  dashboardVariableValue = null,
  rangeValue = null,
  dashboardCommand = null,
  canControl = false,
  refreshTick = 0,
  dataRefreshInterval = null,
}) {
  return (
    <PanelErrorBoundary
      resetKey={`${effectiveComponentId || panel.id}-${chart?.updated || ''}`}
      label={chart?.title || chart?.name || (hasText ? 'Text panel' : 'Component')}
    >
      {/* Connection-swap column mismatch badge (detection only). Shown when the
          active swap connection is missing columns this component needs, so the
          user knows WHY the panel looks degraded instead of silently seeing a
          collapsed table. */}
      {swapIssue && Array.isArray(swapIssue.missing) && swapIssue.missing.length > 0 && (
        <div className="swap-issue-badge">
          <Tooltip
            align="left"
            autoAlign
            label={`${swapIssue.missing.length} column${swapIssue.missing.length === 1 ? '' : 's'} unavailable on this connection: ${swapIssue.missing.join(', ')}`}
          >
            <button type="button" className="swap-issue-badge__trigger" aria-label="Columns unavailable on this connection">
              <WarningAltFilled size={16} />
            </button>
          </Tooltip>
        </div>
      )}
      {unauthorizedReason ? (
        // #4: no name/namespace is available here by design — the server
        // sends only the component id + a reason, so nothing about the
        // ungranted entity can leak into the panel.
        <div className="panel-unauthorized">
          <WarningAltFilled size={20} className="panel-unauthorized__icon" />
          <div className="panel-unauthorized__title">Unauthorized</div>
          <div className="panel-unauthorized__detail">
            {unauthorizedReason === 'connection'
              ? 'This component reads from a connection in a namespace you don\'t have access to.'
              : 'This component is in a namespace you don\'t have access to.'}
          </div>
        </div>
      ) : hasText ? (
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
              {/* has-title → a title band actually renders at the top
                  (datatable's external header, or the ChartShell/DataViewGrid
                  title when showTitle isn't disabled AND there's a
                  title/name). When set, the SCSS drops the wrapper's TOP
                  padding so the band sits flush. */}
              <div className={`component-wrapper ${chart.chart_type === 'datatable' ? 'with-header' : ''} ${chart.chart_type === 'dataview' ? 'dataview-wrapper' : ''} ${(chart.chart_type === 'datatable' || (chart.options?.showTitle !== false && (chart.title || chart.name))) ? 'has-title' : ''}`}>
                <ComponentPanelWithActions
                  // Key includes chart.updated so a config-refresh poll that
                  // picks up a server-side chart edit forces a remount and the
                  // DynamicComponentLoader re-evals the new component_code.
                  // refreshTick is intentionally NOT in the key — it triggers
                  // an out-of-band refetch via useData WITHOUT remounting
                  // (preserves streaming buffers + dynamic state).
                  key={`${effectiveComponentId}-${chart.updated || ''}`}
                  chart={chart}
                  loaderProps={{
                    code: chart.component_code,
                    props: {},
                    componentMeta: chart,
                    dataMapping: chart.data_mapping,
                    // Dashboard-variable connection-swap: override the
                    // component's design-time connection when active.
                    connectionId: resolveConnectionId ? resolveConnectionId(chart) : chart.connection_id,
                    // Execute-by-reference (#23): view mode sends runtime
                    // values only; the server runs this component's stored
                    // query. `chart` is already the post-override effective
                    // component, so its id is the one to reference.
                    componentId: chart.id,
                    queryConfig: chart.query_config,
                    dashboardVariableValue,
                    rangeValue,
                    dataRefreshInterval,
                    refreshTick,
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
  );
}

PanelContent.propTypes = {
  panel: PropTypes.object.isRequired,
  chart: PropTypes.object,
  effectiveComponentId: PropTypes.string,
  hasText: PropTypes.bool,
  hasChart: PropTypes.bool,
  unauthorizedReason: PropTypes.oneOf(['component', 'connection', null]),
  swapIssue: PropTypes.shape({
    missing: PropTypes.arrayOf(PropTypes.string),
    componentName: PropTypes.string,
  }),
  resolveConnectionId: PropTypes.func,
  dashboardVariableText: PropTypes.string,
  variableValues: PropTypes.object,
  dashboardVariableValue: PropTypes.string,
  rangeValue: PropTypes.string,
  dashboardCommand: PropTypes.object,
  canControl: PropTypes.bool,
  refreshTick: PropTypes.number,
  dataRefreshInterval: PropTypes.number,
};

export default PanelContent;
