// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loading } from '@carbon/react';
import { RefreshableComponentsProvider } from '../context/RefreshableComponentsContext';
import DashboardGrid from '../components/DashboardGrid';
import KioskNotifications from '../components/KioskNotifications';
import { useDashboardData } from '../hooks/useDashboardData';
import apiClient from '../api/client';
import { syncKioskFromUrl, getKioskConfig } from '../utils/kioskMode';
import { tagValueByPrefix } from '../utils/tagValueByPrefix';
import './KioskPage.scss';

/**
 * KioskPage — chromeless, display-only status-board surface (/kiosk).
 *
 * Owns an ordered list of ENTRIES ({dashboardId, variable}), the current entry
 * index, and the auto-rotate timer. For the active entry it loads the dashboard
 * + components and renders the shared <DashboardGrid>, forcing the entry's
 * connection (connection-swap) via a resolver. The same dashboard may repeat
 * with different connections, so navigation is by entry index — not id.
 *
 * No app header, no toolbar, no edit/nav controls. A passive notification layer
 * (toasts + pinned) is overlaid per the kiosk flags; it never navigates.
 */
function KioskPage() {
  // Resolve kiosk config once from the URL (consumes params) → falls back to
  // the cached config. Stable for the life of the surface.
  const [config] = useState(() => syncKioskFromUrl() || getKioskConfig());

  const entries = config?.entries || [];
  const rotateSeconds = config?.rotateSeconds || 0;

  const [entryIndex, setEntryIndex] = useState(0);
  const activeEntry = entries[entryIndex] || null;
  const activeId = activeEntry?.dashboardId || null;

  const { dashboard, chartsMap, loading, error } = useDashboardData(activeId);

  // Force the active entry's connection onto every variable-driven panel. This
  // is the connection-swap override, but sourced from the kiosk entry instead
  // of a header dropdown. Pinned panels keep their own connection.
  const forcedConnId = activeEntry?.variable?.type === 'connection'
    ? activeEntry.variable.value
    : null;
  const resolveConnectionId = useCallback(
    (component, panel) => {
      const baseline = component?.connection_id;
      if (!forcedConnId) return baseline;
      if (panel?.pin_connection) return baseline;
      return forcedConnId;
    },
    [forcedConnId],
  );

  // The dashboard's connection-swap variable definition (name, label,
  // label_tag_prefix) — drives both the legacy "Dashboard Variable" content
  // type and {{variable:NAME}} tokens in text panels.
  const connVariable = useMemo(() => {
    const list = dashboard?.settings?.variables || [];
    return list.find((v) => v && v.mode === 'connection_swap') || null;
  }, [dashboard]);

  // Forced connection's name + tags, fetched once (the kiosk doesn't load the
  // candidate list). Falls back to the id until it resolves.
  const [forcedConn, setForcedConn] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!forcedConnId) { setForcedConn(null); return undefined; }
    apiClient.getConnection(forcedConnId)
      .then((c) => { if (!cancelled) setForcedConn(c || null); })
      .catch(() => { if (!cancelled) setForcedConn(null); });
    return () => { cancelled = true; };
  }, [forcedConnId]);

  // The connection variable's display value: tag-prefix label when configured,
  // else the connection name (else its id).
  const dashboardVariableText = useMemo(() => {
    if (!forcedConnId) return '';
    const prefix = connVariable?.connection_swap?.label_tag_prefix || '';
    if (prefix) {
      const v = tagValueByPrefix(forcedConn?.tags, prefix);
      if (v) return v;
    }
    return forcedConn?.name || forcedConnId || '';
  }, [forcedConnId, forcedConn, connVariable]);

  // name → value map for {{variable:NAME}} tokens in text panels.
  const variableValues = useMemo(() => {
    if (!connVariable?.name) return {};
    return { [connVariable.name]: dashboardVariableText };
  }, [connVariable, dashboardVariableText]);

  // ── Auto-rotate (Phase 4) ──────────────────────────────────────────
  // Advance the entry index on the interval; pause while the tab is hidden so
  // a backgrounded board doesn't churn. Manual nav isn't offered (display-only).
  const entryCount = entries.length;
  const advance = useCallback(() => {
    setEntryIndex((i) => (entryCount > 0 ? (i + 1) % entryCount : 0));
  }, [entryCount]);

  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  useEffect(() => {
    if (rotateSeconds <= 0 || entryCount <= 1) return undefined;
    let timer = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => advanceRef.current(), rotateSeconds * 1000);
    };
    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else start();
    };
    if (document.visibilityState !== 'hidden') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [rotateSeconds, entryCount]);

  // Clamp the index if the entry list somehow shrinks.
  useEffect(() => {
    if (entryIndex >= entryCount && entryCount > 0) setEntryIndex(0);
  }, [entryIndex, entryCount]);

  // Stretch to fill the entire board — a status display should use the whole
  // screen. (The dashboard was designed against the viewer's ~57px toolbar
  // budget; the kiosk has no toolbar, so "window" would leave proportional
  // gaps. Stretch fills both axes. A per-dashboard "kiosk mode" that adjusts
  // the design-time chrome budget is the proper fix — see kiosk TODO.)
  const fitMode = useMemo(() => 'stretch', []);

  if (!config || entries.length === 0) {
    return (
      <div className="kiosk-page kiosk-empty">
        <p>No kiosk configured. Add <code>?dashboards=&lt;id&gt;,…</code> to the URL.</p>
      </div>
    );
  }

  return (
    <RefreshableComponentsProvider>
      <div className="kiosk-page">
        {loading && !dashboard ? (
          <div className="kiosk-loading"><Loading withOverlay={false} /></div>
        ) : error ? (
          <div className="kiosk-error">Failed to load dashboard: {error}</div>
        ) : (
          <DashboardGrid
            // Key on the dashboard id ONLY, not the entry index. Rotating to a
            // DIFFERENT dashboard remounts (different panels); rotating to the
            // SAME dashboard with a different connection (repeats) updates in
            // place — resolveConnectionId changes flow as props and useData
            // re-subscribes the stream per panel. Keying on entryIndex caused a
            // full grid unmount/remount every rotation: an ECharts ResizeObserver
            // cleanup crash + a burst of simultaneous per-panel REST refetches
            // that timed out against slow backends.
            key={activeId || 'none'}
            panels={dashboard?.panels || []}
            chartsMap={chartsMap}
            dashboard={dashboard}
            resolveConnectionId={resolveConnectionId}
            dashboardVariableText={dashboardVariableText}
            variableValues={variableValues}
            dashboardCommand={null}
            canControl={false}
            refreshTick={0}
            fitMode={fitMode}
            scalePercent={dashboard?.settings?.scale_percent || 100}
            isFullscreen
          />
        )}

        <KioskNotifications
          showNotifications={config.showNotifications}
          showPinned={config.showPinned}
        />
      </div>
    </RefreshableComponentsProvider>
  );
}

export default KioskPage;
