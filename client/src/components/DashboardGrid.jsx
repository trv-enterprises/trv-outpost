// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import PanelContent from './PanelContent';
import AdornmentLayer from './AdornmentLayer';
import { derivePanelProps } from '../utils/derivePanelProps';
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
  // Visual decorations drawn over the grid (border boxes). Separate from
  // panels: they reference no component and render no data.
  adornments = null,
  chartsMap,
  dashboard,
  resolveConnectionId,
  resolveComponent,
  swapIssuesByPanel = {},
  // #4: component_id → "component" | "connection" for panels whose
  // component (or its connection) is in a namespace the viewer can't
  // see. Empty for unrestricted users.
  unauthorizedComponents = {},
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
  onGridDoubleClick = null,
  // Per-panel edit overlay JSX (hover header, drag/resize, add). Receives
  // (panel, { chart, hasText, hasChart, hasContent }).
  renderPanelChrome = null,
  // Extra edit-only grid children rendered after the panels (drawing
  // preview + canvas boundary lines).
  gridExtras = null,
  // --- adornment-mode props (editor only) ---
  // When true the adornment layer takes mouse events and panels are inert,
  // so clicks select/drag borders instead of panels.
  adornmentMode = false,
  selectedAdornmentId = null,
  // Panel ids a pending shift-click extend would cross. Preview-only — the
  // committed border stores nothing about what it overlaps.
  adornmentPreviewPanelIds = null,
  // Panels picked out by a shift-drag marquee. Dragging any one of them
  // moves the whole set until the selection is cleared.
  selectedPanelIds = null,
  onAdornmentMouseDown = null,
  renderAdornmentChrome = null,
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
  // panel_border adornments render INSIDE their panel (as that panel's own
  // border), not in the overlay layer — that's what keeps two bordered
  // neighbours visually separate instead of merging across the gutter.
  // Index them by panel id so the panel loop is a lookup, not a scan.
  const panelBordersById = useMemo(() => {
    const map = {};
    for (const a of adornments || []) {
      if (a.kind === 'panel_border' && a.panel_id) map[a.panel_id] = a;
    }
    return map;
  }, [adornments]);

  // Only rect-positioned adornments belong in the overlay layer.
  // Rect borders only, and only ones with usable geometry. A record carrying
  // NaN x/y/w/h would render at a nonsense position anyway; dropping it here
  // also keeps it out of the extent maths below, where a single NaN collapses
  // the grid to its fallback size (see extentOf).
  //
  // x/y are NORMALIZED to 0 when absent, and that is load-bearing rather than
  // defensive: the Go model tags them `omitempty`, so a border sitting on
  // column 0 or row 0 serializes with the field MISSING, not as 0. Requiring
  // Number.isFinite(a.x) then rejected the whole adornment and it vanished
  // from the dashboard — every border touching the left or top edge. An
  // absent coordinate means 0 (that is exactly what omitempty encodes), so
  // read it that way; only a coordinate that is PRESENT AND non-numeric is
  // corrupt, which is what the finite checks below still catch.
  //
  // w/h keep the strict check: omitempty can drop those too, but a zero-sized
  // border is degenerate rather than edge-positioned, so there is nothing to
  // draw and dropping it is correct.
  const rectAdornments = useMemo(
    () => (adornments || [])
      .filter((a) => a.kind !== 'panel_border')
      .map((a) => ({ ...a, x: a.x ?? 0, y: a.y ?? 0 }))
      .filter((a) => (
        Number.isFinite(a.x) && Number.isFinite(a.y)
        && Number.isFinite(a.w) && Number.isFinite(a.h)
      )),
    [adornments]
  );

  // View-mode extent must cover ADORNMENTS too, not just panels. A border
  // drawn past the rightmost/bottom panel would otherwise fall outside the
  // grid's fit-tight box and get clipped (and, in the scaled fit modes,
  // shift the scale factor it was authored against). panel_border kinds are
  // excluded — they live inside a panel, so they can never extend the grid.
  // Extent helper. Non-finite geometry is SKIPPED rather than folded in:
  // `Math.max(73, NaN)` is NaN, which then fails the `|| 60` guard below and
  // collapses the whole grid to the 60-cell fallback. A single adornment with
  // a corrupt rect therefore shrank the entire dashboard — panels past column
  // 60 fell outside the grid box, and every fit mode scaled against 60
  // columns instead of the real content, leaving a large empty band.
  //
  // Guarding here rather than only at load: view and kiosk render straight
  // from the server record and never pass through the editor's coercion.
  const extentOf = (items, lo, size) => items.reduce((max, it) => {
    const a = it[lo];
    const b = it[size];
    if (!Number.isFinite(a) || !Number.isFinite(b)) return max;
    return Math.max(max, a + b);
  }, 0);

  const maxGridCol = useMemo(() => {
    if (editMode && editGridCols) return editGridCols;
    if (!hasPanels) return 60;
    return Math.max(extentOf(panels, 'x', 'w'), extentOf(rectAdornments, 'x', 'w')) || 60;
  }, [editMode, editGridCols, panels, rectAdornments, hasPanels]);
  const maxGridRow = useMemo(() => {
    if (editMode && editGridRows) return editGridRows;
    if (!hasPanels) return 60;
    return Math.max(extentOf(panels, 'y', 'h'), extentOf(rectAdornments, 'y', 'h')) || 60;
  }, [editMode, editGridRows, panels, rectAdornments, hasPanels]);

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
      className={`dashboard-grid-container fit-mode-${editMode ? 'edit' : fitMode} ${adornmentMode ? 'adornment-active' : ''}`}
      // Adornment mode only: a press in the container's padding — the band
      // just outside the grid — starts a border on the boundary cell.
      //
      // The grid box ends exactly at the last cell, so without this there is
      // nothing to press above row 0 or past the last column and a border
      // can't be STARTED on the outer edge. Padding the grid can't work
      // either: the canvas leaves as little as 4px of total slack.
      //
      // Handled here rather than by overlay strips (tried and reverted):
      // strips floated ABOVE the grid and shadowed the edge grips, breaking
      // resize drags. The container sits BELOW the grid, so anything the
      // grid handles — panels, borders, grips — claims the event first and
      // this only ever sees presses that missed everything.
      // getGridPosition clamps out-of-range coords to the first/last cell.
      onMouseDown={editMode && adornmentMode ? onGridMouseDown : undefined}
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
          className={`dashboard-grid ${editMode ? 'edit-active' : ''} ${adornmentMode ? 'adornment-active' : ''}`}
          onMouseDown={editMode ? onGridMouseDown : undefined}
          // Grid-level double-click, not adornment-level: a border's interior
          // is pointer-events:none, so a double-click inside a box never
          // reaches the adornment element. The editor resolves the cell and
          // finds the containing selected border itself.
          onDoubleClick={editMode ? onGridDoubleClick : undefined}
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
            // Per-panel data derivation (effective component, chart record,
            // authorization, content flags, refresh interval) is shared with
            // the mobile viewer via derivePanelProps — keep it in sync there.
            const {
              effectiveComponentId,
              chart,
              unauthorizedReason,
              hasText,
              hasChart,
              hasContent,
              effectiveRefreshInterval,
            } = derivePanelProps(panel, {
              chartsMap,
              resolveComponent,
              unauthorizedComponents,
              dashboard,
              dataRefreshInterval,
              editMode,
            });

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
                className={`panel-container ${hasContent ? 'has-component' : 'empty-panel'} ${hasText ? 'text-panel' : ''} ${chart?.control_config?.control_type === 'text_label' ? 'text-label-panel' : ''} ${editMode ? 'edit-mode' : ''} ${panelBordersById[panel.id] ? 'has-panel-border' : ''} ${adornmentMode && selectedAdornmentId && panelBordersById[panel.id]?.id === selectedAdornmentId ? 'panel-border-selected' : ''} ${adornmentPreviewPanelIds?.has(panel.id) ? 'adornment-extend-preview' : ''} ${editMode && (panel.h <= 2 || panel.w <= 1) ? 'is-short-panel' : ''} ${selectedPanelIds?.includes(panel.id) ? 'is-multi-selected' : ''}`}
                style={{
                  gridColumn: `${panel.x + 1} / span ${panel.w}`,
                  gridRow: `${panel.y + 1} / span ${panel.h}`,
                  cursor: editMode ? 'default' : (hasChart && onExpandPanel ? 'pointer' : 'default'),
                  // A panel_border replaces the panel's own 1px border, so the
                  // line grows INWARD from the panel edge (border-box) and two
                  // bordered neighbours stay separated by the gutter. Only
                  // widths 1–3 are offered, so it never reaches the content.
                  ...(panelBordersById[panel.id] ? {
                    borderColor: panelBordersById[panel.id].color || '#fa4d56',
                    borderWidth: `${panelBordersById[panel.id].width || 1}px`,
                    borderStyle: panelBordersById[panel.id].line_style || 'solid',
                  } : {}),
                }}
                // Adornment mode owns the double-click (it shrinks the selected
                // border), so the expand modal must not also fire on it.
                onDoubleClick={canExpand && !adornmentMode ? () => onExpandPanel(panel.id) : undefined}
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
                  unauthorizedReason={unauthorizedReason}
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
          {/* Decorations, above panel bodies. Rendered after the panels so
              an overlapping panel visibly crosses the line rather than
              silently hiding a segment of it. Inert unless the editor is
              in adornment mode. */}
          <AdornmentLayer
            adornments={rectAdornments}
            interactive={adornmentMode}
            // A `hidden` border paints nothing on the dashboard, so without a
            // marker the author has no way to know it's there while laying out
            // panels — and moving a panel out of one silently changes mobile
            // grouping. Reveal it across the WHOLE editor, not just adornment
            // mode: same visibility a normal border gets. `interactive` still
            // gates hit-testing, so it stays unclickable until adornment mode.
            revealHidden={editMode}
            selectedId={selectedAdornmentId}
            onSelect={onAdornmentMouseDown}
            renderChrome={renderAdornmentChrome}
            // "stretch" fit scales the grid by scale(sx, sy) with DIFFERENT
            // factors per axis, and a CSS border scales with it — so a 4px
            // line renders 4*sx on the sides and 4*sy on top/bottom, i.e.
            // visibly uneven. Pass the factors so the layer can counter-scale
            // each edge back to the width the author actually chose. Same
            // problem gaugeCounterTransform solves for round charts. 1/1 in
            // every uniform mode, where this is a no-op.
            scaleX={editMode ? 1 : (fitTransform.sx || 1)}
            scaleY={editMode ? 1 : (fitTransform.sy || 1)}
          />
          {/* Edit-only extras (drawing preview, canvas boundary). */}
          {editMode ? gridExtras : null}
        </div>
      </div>
    </div>
  );
}

DashboardGrid.propTypes = {
  panels: PropTypes.array,
  adornments: PropTypes.array,
  adornmentMode: PropTypes.bool,
  selectedAdornmentId: PropTypes.string,
  adornmentPreviewPanelIds: PropTypes.instanceOf(Set),
  selectedPanelIds: PropTypes.arrayOf(PropTypes.string),
  onAdornmentMouseDown: PropTypes.func,
  renderAdornmentChrome: PropTypes.func,
  chartsMap: PropTypes.object,
  dashboard: PropTypes.object,
  resolveConnectionId: PropTypes.func,
  resolveComponent: PropTypes.func,
  swapIssuesByPanel: PropTypes.object,
  unauthorizedComponents: PropTypes.object,
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
  onGridDoubleClick: PropTypes.func,
  renderPanelChrome: PropTypes.func,
  gridExtras: PropTypes.node,
  containerRef: PropTypes.object,
  gridRef: PropTypes.object,
};

export default DashboardGrid;
