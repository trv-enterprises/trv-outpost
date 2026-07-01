// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import PanelContent from './PanelContent';
import './DashboardGrid.scss';

const CELL_WIDTH = 32;
const CELL_HEIGHT = 32;
const GAP = 4;             // spacing.$spacing-02
const CONTAINER_PADDING = 4;

/**
 * DashboardGrid — the single panel-render path for a dashboard, in BOTH
 * view and edit modes.
 *
 * Originally the read-only view render (extracted for the kiosk surface).
 * It is now also the editor's render, so that the in-place edit↔view
 * toggle does NOT remount the panel subtree. The viewer page renders
 * <DashboardGrid> at one stable slot in both modes and flips `editMode`;
 * because the panel-bearing subtree keeps the same component-type path
 * across the flip, React reconciles it instead of unmounting — so a
 * streaming chart keeps its live subscription (the v0.13.3 streaming-safe
 * guarantee, regressed at v0.26.0 when this was split into two trees).
 *
 * Edit affordances stay OUT of this component: the editor passes a
 * `renderPanelChrome(panel, ctx)` render-prop that returns the hover
 * header / drag overlay / resize handle / add-button JSX, which this
 * component layers inside each `.panel-container`. All editor closures
 * (drag, resize, delete, open-editor, …) remain in DashboardViewerPage —
 * the grid stays view/kiosk-clean and never imports editor internals.
 * View and kiosk callers pass no edit props and get the read-only render.
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
  swapIssuesByPanel = {},
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
  dataRefreshInterval = null,
  // --- edit-mode props (all optional; absent = read-only view/kiosk render) ---
  editMode = false,
  // Editor uses the dimension BUDGET for grid bounds, not the panel extent,
  // so the canvas shows empty cells out to the dashboard edge.
  editGridCols = null,
  editGridRows = null,
  // Edit transforms: manual view zoom (wrapper level) + build/display
  // scaleFactor (grid level). View mode derives its own fit transform.
  editZoom = 100,
  editScaleFactor = 1,
  onGridMouseDown = null,
  // Per-panel edit overlay JSX (hover header, drag/resize, add). Receives
  // (panel, { chart, hasText, hasChart, hasContent }).
  renderPanelChrome = null,
  // Extra edit-only grid children rendered after the panels (drawing
  // preview + canvas boundary lines).
  gridExtras = null,
  // Optional external refs so the editor can attach its drag/resize and
  // measurement logic to this component's container + grid DOM nodes. When
  // omitted, the grid uses its own internal refs (view/kiosk).
  containerRef: externalContainerRef = null,
  gridRef: externalGridRef = null,
}) {
  const internalContainerRef = useRef(null);
  const internalGridRef = useRef(null);
  const containerRef = externalContainerRef || internalContainerRef;
  const gridRef = externalGridRef || internalGridRef;
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

  const scaleFactor = (Number.isFinite(scalePercent) && scalePercent > 0 ? scalePercent : 100) / 100;

  const hasPanels = panels && panels.length > 0;

  // Grid bounds. Edit mode uses the dimension budget (editGridCols/Rows) so
  // the canvas extends to the dashboard edge; view mode fits tight around
  // the panel extent (fall back to 60 when empty, matching the viewer).
  const maxGridCol = useMemo(() => {
    if (editMode && editGridCols) return editGridCols;
    if (!hasPanels) return 60;
    return panels.reduce((max, p) => Math.max(max, p.x + p.w), 0) || 60;
  }, [editMode, editGridCols, panels, hasPanels]);
  const maxGridRow = useMemo(() => {
    if (editMode && editGridRows) return editGridRows;
    if (!hasPanels) return 60;
    return panels.reduce((max, p) => Math.max(max, p.y + p.h), 0) || 60;
  }, [editMode, editGridRows, panels, hasPanels]);

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
      if (scaleFactor === 1) return { transform: '', scaledW: 0, scaledH: 0, sx: 1, sy: 1 };
      return { transform: `scale(${scaleFactor})`, scaledW: targetW, scaledH: targetH, sx: 1, sy: 1 };
    }
    if (!containerSize.width || !containerSize.height) {
      return { transform: '', scaledW: 0, scaledH: 0, sx: 1, sy: 1 };
    }
    const availW = containerSize.width - 2 * CONTAINER_PADDING;
    const availH = containerSize.height - 2 * CONTAINER_PADDING;
    const sx = availW / targetW;
    const sy = availH / targetH;
    if (fitMode === 'stretch') {
      // sx/sy are the per-axis scale BEFORE scaleFactor. Round-aspect panels
      // (gauges) read these to counter-scale themselves back to a uniform
      // aspect ratio — see gaugeCounterTransform below.
      return { transform: `scale(${sx * scaleFactor}, ${sy * scaleFactor})`, scaledW: targetW * sx, scaledH: targetH * sy, sx, sy };
    }
    if (fitMode === 'width') {
      return { transform: `scale(${sx * scaleFactor})`, scaledW: targetW * sx, scaledH: targetH * sx, sx, sy: sx };
    }
    const s = Math.min(sx, sy);
    return { transform: `scale(${s * scaleFactor})`, scaledW: targetW * s, scaledH: targetH * s, sx: s, sy: s };
  }, [fitMode, containerSize.width, containerSize.height, maxGridCol, maxGridRow, scaleFactor]);

  // "Stretch" fit applies a NON-UNIFORM scale (sx ≠ sy) to the whole grid,
  // squeezing a round chart's box (gauge, pie) into an ellipse. To keep them
  // circular we counter-scale ONLY the chart's inner BODY by the non-uniform
  // part, contracting to the SMALLER axis (scale the chart down to round rather
  // than up): effective per-axis scale becomes min(sx,sy) on both axes. One
  // factor is 1, the other ≤ 1. The chart still GROWS with the panel (it tracks
  // min(sx,sy), not actual size) — it just grows uniformly. The panel CONTAINER
  // is left untransformed so its background/border fill the full stretched
  // footprint; only the chart content de-stretches. '' when the grid is uniform.
  const gaugeCounterTransform = useMemo(() => {
    const { sx, sy } = fitTransform;
    if (!editMode && fitMode === 'stretch' && sx > 0 && sy > 0 && Math.abs(sx - sy) > 1e-4) {
      const s = Math.min(sx, sy);
      return `scale(${s / sx}, ${s / sy})`;
    }
    return '';
  }, [fitTransform, fitMode, editMode]);

  // View mode with no panels renders nothing (the viewer shows its own
  // "no panels" message). Edit mode always renders so there's a canvas.
  if (!hasPanels && !editMode) return null;

  return (
    <div
      ref={containerRef}
      className={`dashboard-grid-container fit-mode-${editMode ? 'edit' : fitMode}`}
    >
      <div
        className="dashboard-grid-scale-wrapper"
        style={{
          // View mode reserves the post-fit-transform size; edit mode
          // applies the manual view zoom here (scales the whole scene,
          // including the canvas boundary line).
          ...(!editMode && fitTransform.scaledW > 0
            ? { width: fitTransform.scaledW, height: fitTransform.scaledH }
            : {}),
          ...(editMode && editZoom !== 100
            ? { transform: `scale(${editZoom / 100})`, transformOrigin: 'top left' }
            : {}),
        }}
      >
        <div
          ref={gridRef}
          className={`dashboard-grid ${editMode ? 'edit-active' : ''}`}
          onMouseDown={editMode ? onGridMouseDown : undefined}
          style={{
            gridTemplateColumns: `repeat(${maxGridCol}, ${CELL_WIDTH}px)`,
            gridTemplateRows: `repeat(${maxGridRow}, ${CELL_HEIGHT}px)`,
            // View: fit transform. Edit: build/display scaleFactor (design
            // at display size; 100% = actual).
            ...(!editMode && fitTransform.transform
              ? { transform: fitTransform.transform, transformOrigin: 'top left' }
              : {}),
            ...(editMode && editScaleFactor !== 1
              ? { transform: `scale(${editScaleFactor})`, transformOrigin: 'top left' }
              : {}),
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
            // A panel has chart content when its component is a chart, control,
            // or display. Spec-driven charts (use_custom_code=false) carry an
            // EMPTY component_code — the render is synthesized from chart_type +
            // data_mapping by the loader — so we must NOT gate on component_code.
            // Custom-code charts also satisfy chart_type === 'chart'. The legacy
            // `!!chart.component_code` term remains as a fallback for records
            // that predate component_type being set.
            const hasChart = !hasText && (
              chart?.component_type === 'chart'
              || chart?.component_type === 'control'
              || chart?.component_type === 'display'
              || !!chart?.component_code
            );
            const hasContent = hasText || hasChart;

            // Round-aspect charts (gauge, pie) must stay circular under
            // "stretch" (non-uniform) fit. Counter-scale the panel body back to
            // a uniform aspect so the round ECharts box isn't squeezed into an
            // ellipse (#63). Labels/leader lines live inside the transformed
            // body, so they scale uniformly with the chart — no distortion.
            const isRoundChart = chart?.chart_type === 'gauge' || chart?.chart_type === 'pie';
            const counterTransform = isRoundChart ? gaugeCounterTransform : '';

            const expandableDisplayTypes = new Set(['weather', 'frigate_camera']);
            const isLegacyChart = !!chart?.component_code
              && chart?.component_type !== 'control'
              && chart?.component_type !== 'display';
            const canExpand = !!onExpandPanel && hasChart && (
              chart?.component_type === 'chart'
              || isLegacyChart
              || (chart?.component_type === 'display' && expandableDisplayTypes.has(chart?.display_config?.display_type))
            );

            // View mode polls at the dashboard's refresh interval; edit
            // mode passes null (no auto-refresh while designing). The caller
            // can override via dataRefreshInterval.
            const effectiveRefreshInterval = dataRefreshInterval != null
              ? dataRefreshInterval
              : (!editMode && dashboard?.settings?.refresh_interval > 0
                ? dashboard.settings.refresh_interval * 1000
                : null);

            return (
              <div
                key={panel.id}
                data-panel-id={panel.id}
                // Native hover tooltip shows the component NAME (the internal
                // identifier) when a component is involved — the canvas shows the
                // display TITLE, so the hover surfaces the name behind it. Text
                // panels have no component, so no tooltip. Suppressed in edit
                // mode (the edit hover header surfaces this instead).
                title={!editMode && hasChart ? (chart?.name || undefined) : undefined}
                className={`panel-container ${hasContent ? 'has-component' : 'empty-panel'} ${hasText ? 'text-panel' : ''} ${chart?.control_config?.control_type === 'text_label' ? 'text-label-panel' : ''} ${editMode ? 'edit-mode' : ''}`}
                style={{
                  gridColumn: `${panel.x + 1} / span ${panel.w}`,
                  gridRow: `${panel.y + 1} / span ${panel.h}`,
                  cursor: editMode ? 'default' : (hasChart && onExpandPanel ? 'pointer' : 'default'),
                }}
                onDoubleClick={canExpand ? () => onExpandPanel(panel.id) : undefined}
              >
                {/* Edit chrome (hover header / drag overlay / resize / add) is
                    injected by the editor; null in view/kiosk. */}
                {editMode && renderPanelChrome
                  ? renderPanelChrome(panel, { chart, hasText, hasChart, hasContent })
                  : null}

                {/* Shared panel BODY — identical subtree in both modes so the
                    streaming chart survives the edit↔view flip. Gauges wrap the
                    body in a counter-transformed layer so the circle de-stretches
                    back to round while the panel CONTAINER keeps its full
                    stretched footprint (background/border fill the cell). */}
                <div
                  className="panel-body"
                  style={counterTransform
                    ? { transform: counterTransform, transformOrigin: 'center', flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }
                    : { display: 'contents' }}
                >
                <PanelContent
                  panel={panel}
                  chart={chart}
                  effectiveComponentId={effectiveComponentId}
                  hasText={hasText}
                  hasChart={hasChart}
                  swapIssue={swapIssuesByPanel[panel.id] || null}
                  resolveConnectionId={resolveConnectionId}
                  dashboardVariableText={dashboardVariableText}
                  variableValues={variableValues}
                  dashboardVariableValue={dashboardVariableValue}
                  rangeValue={rangeValue}
                  dashboardCommand={dashboardCommand}
                  canControl={canControl}
                  refreshTick={refreshTick}
                  dataRefreshInterval={effectiveRefreshInterval}
                />
                </div>
              </div>
            );
          })}
          {/* Edit-only extras (drawing preview, canvas boundary). */}
          {editMode ? gridExtras : null}
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
  swapIssuesByPanel: PropTypes.object,
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
  dataRefreshInterval: PropTypes.number,
  editMode: PropTypes.bool,
  editGridCols: PropTypes.number,
  editGridRows: PropTypes.number,
  editZoom: PropTypes.number,
  editScaleFactor: PropTypes.number,
  onGridMouseDown: PropTypes.func,
  renderPanelChrome: PropTypes.func,
  gridExtras: PropTypes.node,
  containerRef: PropTypes.object,
  gridRef: PropTypes.object,
};

export default DashboardGrid;
