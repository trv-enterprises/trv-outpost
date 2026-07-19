// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { Loading, Button } from '@carbon/react';
import { Renew, ChevronLeft, Maximize, Close, Settings } from '@carbon/icons-react';
import PanelContent from '../components/PanelContent';
import ConnectionSwapPicker from '../components/ConnectionSwapPicker';
import FilterVariablePicker from '../components/FilterVariablePicker';
import DashboardRangePicker from '../components/DashboardRangePicker';
import { RefreshableComponentsProvider } from '../context/RefreshableComponentsContext';
import { useNotifications } from '../context/NotificationContext';
import { useDashboardData } from '../hooks/useDashboardData';
import { useDashboardVariable } from '../hooks/useDashboardVariable';
import useRangeConnectionTypes from '../hooks/useRangeConnectionTypes';
import { derivePanelProps } from '../utils/derivePanelProps';
import { candidateLabel } from '../utils/tagValueByPrefix';
import StreamConnectionManager from '../utils/streamConnectionManager';
import apiClient from '../api/client';
import './MobileDashboardViewer.scss';

/**
 * MobileDashboardViewer — view-mode dashboard rendering for phones.
 *
 * The desktop viewer lays panels on a fixed 32×32-px cell grid scaled to fit by
 * a single CSS transform; on a narrow screen that's illegible. This surface
 * instead DISCARDS the author's grid geometry and stacks every panel
 * vertically, full-width, one per row, ordered by (y, x) — so any existing
 * dashboard is readable on a phone with no re-authoring.
 *
 * It deliberately reuses the same leaf the desktop grid renders — <PanelContent>
 * — so a streaming chart keeps its StreamConnectionManager subscription (streams
 * are opened lazily per-panel deep inside PanelContent → useData; rendering the
 * same component type is all that's needed). Data + resolver wiring mirrors the
 * viewer via the shared hooks (useDashboardData, useDashboardVariable) and the
 * shared per-panel derivation (derivePanelProps). No edit-mode machinery.
 *
 * Phase 1 scope: no variable PICKER UI (the hook is still instantiated so
 * URL-param variable defaults resolve), no dashboardCommand MQTT subscription,
 * no per-dashboard mobile layout. Those are follow-ups (issue #170).
 */
function MobileDashboardViewer({ canControl = false }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { addNotification } = useNotifications();

  const {
    dashboard,
    chartsMap,
    unauthorizedComponents,
    loading,
    error,
    refetch,
  } = useDashboardData(id);

  // Admin gate for the dashboard-variable feature (mirrors the desktop viewer).
  // Even without a picker UI, we honor URL-param variable selections so a
  // shared link like ?var_x=… resolves the same on mobile.
  const [dashboardVariableEnabled, setDashboardVariableEnabled] = useState(false);
  useEffect(() => {
    apiClient.getSetting('dashboard_variable.enabled')
      .then((s) => setDashboardVariableEnabled((s?.value ?? s) !== false))
      .catch(() => setDashboardVariableEnabled(false));
  }, []);

  // Search-param accessors for useDashboardVariable (same shape the viewer uses).
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;
  const getSearchParam = useCallback(() => searchParamsRef.current, []);
  const setSearchParam = useCallback((key, value) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value == null || value === '') next.delete(key);
      else next.set(key, value);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const {
    variable: dashVariable,
    candidates: dashVariableCandidates,
    selectedConnId: dashVariableValue,
    setValue: setDashVariableValue,
    resolveConnectionId,
    resolveComponent,
    filterVariable: dashFilterVariable,
    filterValue: dashFilterValue,
    setFilterValue: setDashFilterValue,
    rangeVariable: dashRangeVariable,
    rangeValue: dashRangeValue,
    setRangeValue: setDashRangeValue,
  } = useDashboardVariable({
    dashboard,
    globalEnabled: dashboardVariableEnabled,
    getSearchParam,
    setSearchParam,
  });

  // Any variable active for this dashboard? Drives whether the mobile viewer
  // shows the Variables toggle at all.
  const hasVariables = !!(dashVariable || dashFilterVariable || dashRangeVariable);
  const [variablesOpen, setVariablesOpen] = useState(false);

  // Prometheus detection for the range picker's step field (shared with desktop).
  const { rangeConnType, rangeSupportsStep, rangeHasConsumer } = useRangeConnectionTypes({
    rangeVariable: dashRangeVariable,
    panels: dashboard?.panels || [],
    chartsMap,
    dashboard,
    addNotification,
  });

  // Resolved display value of the connection-swap variable (tag-prefix label or
  // name), for {{variable:NAME}} tokens in text panels. Mirrors the viewer.
  const dashboardVariableText = useMemo(() => {
    if (!dashVariable) return '';
    const cands = dashVariableCandidates || [];
    const prefix = dashVariable.connection_swap?.label_tag_prefix || '';
    const selected = cands.find((c) => c.id === dashVariableValue);
    if (selected) return candidateLabel(selected, prefix);
    const reference = cands.find((c) => c.reference);
    return reference ? candidateLabel(reference, prefix) : '';
  }, [dashVariable, dashVariableCandidates, dashVariableValue]);

  // name → value map for {{variable:NAME}} tokens (both variable kinds).
  const variableValues = useMemo(() => {
    const map = {};
    if (dashVariable?.name) map[dashVariable.name] = dashboardVariableText;
    if (dashFilterVariable?.name) map[dashFilterVariable.name] = dashFilterValue || '';
    return map;
  }, [dashVariable, dashboardVariableText, dashFilterVariable, dashFilterValue]);

  // Close all streaming connections when leaving the mobile viewer, matching the
  // desktop viewer's cleanup — frees connection slots for the next surface.
  useEffect(() => () => StreamConnectionManager.getInstance().closeAll(), []);

  // Manual refresh (out-of-band refetch WITHOUT remount — preserves streaming
  // buffers) plus a re-pull of the dashboard record.
  const [refreshTick, setRefreshTick] = useState(0);
  const onRefresh = useCallback(() => {
    setRefreshTick((t) => t + 1);
    refetch();
  }, [refetch]);

  // Panels stacked in reading order: top-to-bottom (y), then left-to-right (x).
  // The author's x/w/h are otherwise ignored — every panel renders full-width.
  const orderedPanels = useMemo(() => {
    const panels = dashboard?.panels || [];
    return [...panels].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  }, [dashboard]);

  const refreshInterval = dashboard?.settings?.refresh_interval > 0
    ? dashboard.settings.refresh_interval * 1000
    : null;

  // Edge-to-edge fullscreen for a single panel. Holds the panel id being shown
  // fullscreen (null = none). The overlay renders a SEPARATE PanelContent
  // instance for that panel; because streams are shared per-connection via the
  // StreamConnectionManager, the fullscreen copy streams alongside the inline
  // one — same pattern as the desktop ComponentExpandModal. Escape/back closes.
  const [fullscreenPanelId, setFullscreenPanelId] = useState(null);

  // Pair the overlay with NATIVE browser fullscreen so the phone's browser
  // chrome (Safari's URL/tab bars, Android's URL + status bars) gets out of
  // the way. Element fullscreen is long-standing on Android and arrived on
  // iPhone in Safari 16.4; older browsers fall back to the plain overlay.
  // Fullscreening documentElement (not the overlay node) keeps the request
  // inside the tap's user-gesture window — the overlay isn't mounted yet at
  // tap time — and the fixed inset-0 overlay covers the viewport either way.
  const enterBrowserFullscreen = useCallback(() => {
    const el = document.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    try {
      const p = req.call(el);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* unsupported/denied — overlay alone still works */ }
  }, []);
  const exitBrowserFullscreen = useCallback(() => {
    if (!(document.fullscreenElement || document.webkitFullscreenElement)) return;
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      const p = exit && exit.call(document);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch { /* already exited */ }
  }, []);

  const openFullscreen = useCallback((panelId) => {
    setFullscreenPanelId(panelId);
    enterBrowserFullscreen();
  }, [enterBrowserFullscreen]);
  const closeFullscreen = useCallback(() => {
    setFullscreenPanelId(null);
    exitBrowserFullscreen();
  }, [exitBrowserFullscreen]);

  useEffect(() => {
    if (!fullscreenPanelId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') closeFullscreen(); };
    // The system can exit fullscreen without us (iOS swipe-down, Android
    // back). Keep the overlay in lockstep: fullscreen gone → overlay closes.
    const onFsChange = () => {
      if (!(document.fullscreenElement || document.webkitFullscreenElement)) {
        setFullscreenPanelId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('webkitfullscreenchange', onFsChange);
    };
  }, [fullscreenPanelId, closeFullscreen]);

  // Resolve the panel + its derived props for the fullscreen overlay. Recomputed
  // from live chartsMap/resolvers so the fullscreen chart tracks variable/range
  // changes just like the inline one. Clears itself if the panel disappears
  // (e.g. after a refetch that removed it).
  const fullscreenPanel = useMemo(() => {
    if (!fullscreenPanelId) return null;
    const panel = (dashboard?.panels || []).find((p) => p.id === fullscreenPanelId);
    if (!panel) return null;
    const derived = derivePanelProps(panel, {
      chartsMap,
      resolveComponent,
      unauthorizedComponents,
      dashboard,
      dataRefreshInterval: refreshInterval,
      editMode: false,
    });
    return { panel, derived };
  }, [fullscreenPanelId, dashboard, chartsMap, resolveComponent, unauthorizedComponents, refreshInterval]);
  const fullscreenTitle = fullscreenPanel?.derived?.chart?.title
    || fullscreenPanel?.derived?.chart?.name
    || 'Component';

  if (loading && !dashboard) {
    return (
      <div className="mobile-viewer mobile-viewer--center">
        <Loading withOverlay={false} description="Loading dashboard…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mobile-viewer mobile-viewer--center">
        <p className="mobile-viewer__error">Failed to load dashboard: {error}</p>
        <Button size="sm" kind="tertiary" onClick={onRefresh}>Retry</Button>
      </div>
    );
  }

  const title = dashboard?.name || 'Dashboard';

  return (
    <RefreshableComponentsProvider>
      <div className="mobile-viewer">
        <div className="mobile-viewer__bar">
          <Button
            hasIconOnly
            size="sm"
            kind="ghost"
            iconDescription="Back to dashboards"
            renderIcon={ChevronLeft}
            onClick={() => navigate('/view/dashboards')}
          />
          <span className="mobile-viewer__title" title={title}>{title}</span>
          {hasVariables && (
            <Button
              hasIconOnly
              size="sm"
              kind={variablesOpen ? 'secondary' : 'ghost'}
              iconDescription="Variables"
              renderIcon={Settings}
              isSelected={variablesOpen}
              onClick={() => setVariablesOpen((v) => !v)}
            />
          )}
          <Button
            hasIconOnly
            size="sm"
            kind="ghost"
            iconDescription="Refresh"
            renderIcon={Renew}
            onClick={onRefresh}
          />
        </div>

        {/* Collapsible dashboard-variable controls. Same pickers the desktop
            toolbar uses (shared components), stacked for a narrow screen.
            Only the pickers whose variable exists render. */}
        {hasVariables && variablesOpen && (
          <div className="mobile-viewer__variables">
            <ConnectionSwapPicker
              variable={dashVariable}
              candidates={dashVariableCandidates}
              value={dashVariableValue}
              onChange={setDashVariableValue}
            />
            <FilterVariablePicker
              variable={dashFilterVariable}
              value={dashFilterValue}
              onChange={setDashFilterValue}
              panels={orderedPanels}
              chartsMap={chartsMap}
              dashboard={dashboard}
              addNotification={addNotification}
            />
            {/* Hidden when no panel actually consumes the range
                (rangeHasConsumer) — same gate as the desktop viewer. */}
            {dashRangeVariable && rangeHasConsumer && (
              <DashboardRangePicker
                variable={dashRangeVariable}
                value={dashRangeValue}
                onChange={setDashRangeValue}
                showStep={rangeSupportsStep}
                stepType={rangeConnType}
              />
            )}
          </div>
        )}

        {orderedPanels.length === 0 ? (
          <div className="mobile-viewer__empty">This dashboard has no panels.</div>
        ) : (
          <div className="mobile-viewer__stack">
            {orderedPanels.map((panel) => {
              const derived = derivePanelProps(panel, {
                chartsMap,
                resolveComponent,
                unauthorizedComponents,
                dashboard,
                dataRefreshInterval: refreshInterval,
                editMode: false,
              });

              // Skip truly empty panels (no text, no component) — on desktop
              // they're invisible grid cells; in a vertical stack an empty row
              // would just be dead space.
              if (!derived.hasContent && !derived.unauthorizedReason) return null;

              // Row height class by content kind so charts get a sensible box
              // (ECharts fills 100% height) while tiles/controls stay compact.
              const kind = derived.chart?.component_type || (derived.hasText ? 'text' : 'chart');
              const chartType = derived.chart?.chart_type || '';
              const rowClass = `mobile-panel mobile-panel--${kind}`
                + (chartType ? ` mobile-panel--${chartType}` : '');

              // Fullscreen makes sense for visual components (charts/displays),
              // not text panels or unauthorized placeholders.
              const canFullscreen = derived.hasChart && kind !== 'control';

              return (
                <div key={panel.id} className={rowClass} data-panel-id={panel.id}>
                  {canFullscreen && (
                    <Button
                      className="mobile-panel__fullscreen-btn"
                      hasIconOnly
                      size="sm"
                      kind="ghost"
                      iconDescription="Fullscreen"
                      renderIcon={Maximize}
                      onClick={() => openFullscreen(panel.id)}
                    />
                  )}
                  {renderPanelBody(panel, derived)}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Edge-to-edge fullscreen overlay for a single panel. A fresh
          PanelContent instance (streaming shares per-connection, so it runs
          alongside the inline copy). Rotate the phone to landscape for a wide
          chart. */}
      {fullscreenPanel && (
        <div className="mobile-fullscreen" role="dialog" aria-modal="true" aria-label={fullscreenTitle}>
          {/* No header bar — the component renders its own title. The close
              button floats over the top-right corner of the component. */}
          <Button
            className="mobile-fullscreen__close"
            hasIconOnly
            size="sm"
            kind="ghost"
            iconDescription="Close fullscreen"
            renderIcon={Close}
            onClick={closeFullscreen}
          />
          <div className="mobile-fullscreen__body">
            {renderPanelBody(fullscreenPanel.panel, fullscreenPanel.derived)}
          </div>
        </div>
      )}
    </RefreshableComponentsProvider>
  );

  // Shared per-panel body so the inline row and the fullscreen overlay render
  // IDENTICAL PanelContent wiring — same props, same streaming behavior.
  function renderPanelBody(panel, derived) {
    return (
      <PanelContent
        panel={panel}
        chart={derived.chart}
        effectiveComponentId={derived.effectiveComponentId}
        hasText={derived.hasText}
        hasChart={derived.hasChart}
        unauthorizedReason={derived.unauthorizedReason}
        swapIssue={null}
        resolveConnectionId={resolveConnectionId}
        dashboardVariableText={dashboardVariableText}
        variableValues={variableValues}
        // GOTCHA: the prop named dashboardVariableValue carries the FILTER value
        // (not the connection-swap id) — mirror the desktop viewer's grid call
        // site, or {{dashboard-variable}} filter substitution breaks.
        dashboardVariableValue={dashFilterValue}
        rangeValue={dashRangeValue}
        dashboardCommand={null}
        canControl={canControl}
        refreshTick={refreshTick}
        dataRefreshInterval={derived.effectiveRefreshInterval}
      />
    );
  }
}

export default MobileDashboardViewer;
