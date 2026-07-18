// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';
import { deriveVariableColumn } from '../utils/deriveVariableColumn';
import { DASHBOARD_VARIABLE_TOKEN } from '../utils/dataTransforms';

/**
 * useFilterVariableDiscovery — the "discovered values" machinery for a
 * connection-sourced filter dashboard-variable.
 *
 * Lifted verbatim out of DashboardViewerPage so the desktop viewer and the
 * mobile viewer share ONE implementation (see the FilterVariablePicker
 * component that consumes it). Behavior is unchanged from the inline version.
 *
 * Dispatches value discovery by connection type:
 *   - SQL/EdgeLake/API/tsstore → server-side getVariableValues (DISTINCT /
 *     one-shot / newest).
 *   - raw socket/mqtt → the connection's authoring-time discovered_values list,
 *     with an optional session-only live-recapture ("regenerate") over SSE.
 *
 * @param {object}   p
 * @param {object}   p.filterVariable  the filter DashboardVariable (or null)
 * @param {Array}    p.panels          dashboard panels
 * @param {object}   p.chartsMap       component_id → component record
 * @param {object}   p.dashboard       dashboard record (for the once-per-dash warn key)
 * @param {Function} [p.pushToast]     ({kind,title,subtitle}) => void (optional)
 * @param {Function} [p.addNotification] ({kind,title,subtitle}) => void (optional)
 * @returns discovery state + the regenerate controls the picker needs.
 */
export function useFilterVariableDiscovery({
  filterVariable,
  panels,
  chartsMap,
  dashboard,
  pushToast,
  addNotification,
}) {
  // Resolve the discovery target: the connection + column/table backing the
  // token-consuming components. Uses the FIRST connection and warns if the
  // variable-driven components span more than one.
  const discoveryWarnedRef = useRef(null);
  const discoveryTarget = useMemo(() => {
    const cfg = filterVariable?.filter_value || {};
    if (!filterVariable || cfg.value_source !== 'connection') return null;

    // Components that actually consume the token (query OR a filter value).
    const driven = [];
    for (const panel of panels || []) {
      const comp = panel?.component_id ? chartsMap[panel.component_id] : null;
      if (!comp || !comp.connection_id) continue;
      const raw = comp.query_config?.raw;
      const usesInQuery = typeof raw === 'string' && raw.includes(DASHBOARD_VARIABLE_TOKEN);
      const usesInFilter = Array.isArray(comp.data_mapping?.filters)
        && comp.data_mapping.filters.some((f) => typeof f.value === 'string' && f.value.trim() === DASHBOARD_VARIABLE_TOKEN);
      if (usesInQuery || usesInFilter) driven.push(comp);
    }
    if (driven.length === 0) return null;

    const connIds = [...new Set(driven.map((c) => c.connection_id))];
    // Pick the first component on the first connection to derive column/table.
    const firstConnId = connIds[0];
    const comp = driven.find((c) => c.connection_id === firstConnId);
    const raw = comp.query_config?.raw || '';
    let { column, table } = deriveVariableColumn(raw);
    // Non-SQL filter components: the bound column is the filter row whose value
    // is the token (no table needed for those adapters).
    if (!column && Array.isArray(comp.data_mapping?.filters)) {
      const f = comp.data_mapping.filters.find((x) => typeof x.value === 'string' && x.value.trim() === DASHBOARD_VARIABLE_TOKEN);
      if (f?.field) column = f.field;
    }
    const database = comp.query_config?.params?.database || '';
    return { connId: firstConnId, column, table, database, multiConn: connIds.length > 1 };
  }, [filterVariable, panels, chartsMap]);

  // Warn once per dashboard when discovery spans >1 connection (use first).
  useEffect(() => {
    if (!discoveryTarget?.multiConn) return;
    const key = `${dashboard?.id || ''}`;
    if (discoveryWarnedRef.current === key) return;
    discoveryWarnedRef.current = key;
    const msg = "This dashboard's variable spans more than one connection; using the first for value discovery.";
    pushToast?.({ kind: 'warning', title: 'Multiple connections', subtitle: msg });
    addNotification?.({ kind: 'warning', title: 'Dashboard variable: multiple connections', subtitle: msg });
  }, [discoveryTarget, dashboard?.id, pushToast, addNotification]);

  const [discoveredOptions, setDiscoveredOptions] = useState(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  // Session-only override the viewer's "regenerate" sets; wins over the stored
  // list but is NOT persisted (persistence needs design authority in the editor).
  const [sessionDiscoveredOverride, setSessionDiscoveredOverride] = useState(null);
  // The connection type backing discovery (drives path + whether regenerate is
  // offered). Set by the discovery effect.
  const [discoveryConnType, setDiscoveryConnType] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setSessionDiscoveredOverride(null); // clear stale session override on target change
    if (!discoveryTarget || !discoveryTarget.connId || !discoveryTarget.column) {
      setDiscoveredOptions(null);
      setDiscoveryLoading(false);
      setDiscoveryConnType(null);
      return undefined;
    }
    setDiscoveryLoading(true);
    (async () => {
      try {
        // Resolve the connection type (cached) to choose the discovery path.
        const conn = await apiClient.getConnection(discoveryTarget.connId).catch(() => null);
        if (cancelled) return;
        const type = conn?.type || conn?.config?.type || null;
        setDiscoveryConnType(type);
        // Only RAW socket / mqtt are truly stream-only (no query API) — those
        // read the authoring-captured stored list. tsstore (even streaming
        // transport) answers "newest" over HTTP, so it uses the server path
        // like SQL/EdgeLake/API — no stored list, no view-time capture.
        const isStreamLike = type === 'socket' || type === 'mqtt';

        if (isStreamLike) {
          // Raw socket/mqtt: read the authoring-time captured list off the
          // connection record. No view-time capture (too slow).
          const stored = conn?.discovered_values?.[discoveryTarget.column];
          setDiscoveredOptions(Array.isArray(stored?.values) ? stored.values : null);
        } else {
          // SQL/EdgeLake/API/tsstore: server-side discovery (DISTINCT for SQL/
          // EdgeLake; one-shot fetch + harvest for API; newest 1000 for tsstore).
          const res = await apiClient.getVariableValues(discoveryTarget.connId, {
            column: discoveryTarget.column,
            table: discoveryTarget.table,
            database: discoveryTarget.database,
          });
          if (cancelled) return;
          setDiscoveredOptions(res?.success && Array.isArray(res.values) ? res.values : null);
        }
      } catch {
        if (!cancelled) setDiscoveredOptions(null); // fall back to static options
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // Key on the resolved triple so it doesn't refire on unrelated renders.
  }, [discoveryTarget?.connId, discoveryTarget?.column, discoveryTarget?.table, discoveryTarget?.database]);

  // Session-only regenerate for a stream/socket variable: live-capture records
  // via the connection's SSE stream, unique the bound column, and override the
  // dropdown list for THIS session (not persisted).
  const regenerateCaptureRef = useRef(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenLiveValues, setRegenLiveValues] = useState([]);
  const [regenRecordCount, setRegenRecordCount] = useState(0);
  const [regenModalOpen, setRegenModalOpen] = useState(false);
  const regenSeenRef = useRef(null);
  const [autoOpenFilterDropdown, setAutoOpenFilterDropdown] = useState(false);

  const startSessionRegenerate = useCallback(() => {
    const target = discoveryTarget;
    if (!target?.connId || !target.column) return;
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
    const seen = new Set();
    regenSeenRef.current = seen;
    setRegenLiveValues([]);
    setRegenRecordCount(0);
    setRegenModalOpen(true);
    setRegenerating(true);
    const authParam = apiClient.streamAuthQuery();
    const sseUrl = `${apiClient.httpOriginForApi()}/api/connections/${target.connId}/stream?${authParam}`;
    const es = new EventSource(sseUrl);
    regenerateCaptureRef.current = es;
    const values = [];
    const CAP = 1000;
    const finish = () => {
      if (regenerateCaptureRef.current !== es) return;
      es.close();
      regenerateCaptureRef.current = null;
      setRegenerating(false);
    };
    let records = 0;
    es.addEventListener('record', (event) => {
      try {
        records += 1;
        setRegenRecordCount(records); // live update → modal shows records processed
        const rec = JSON.parse(event.data);
        const v = rec?.[target.column];
        if (v != null) {
          const s = String(v);
          if (s !== '' && !seen.has(s)) {
            seen.add(s);
            values.push(s);
            setRegenLiveValues([...values]); // live update → modal re-renders
          }
        }
        if (values.length >= CAP) finish();
      } catch { /* ignore parse errors */ }
    });
    es.onerror = () => { if (regenerateCaptureRef.current === es) finish(); };
    // Safety cap: stop after 5 minutes if the user walks away.
    setTimeout(() => { if (regenerateCaptureRef.current === es) finish(); }, 300000);
  }, [discoveryTarget]);

  const stopSessionRegenerate = useCallback(() => {
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
    setRegenerating(false);
    setSessionDiscoveredOverride([...regenLiveValues]);
    setRegenModalOpen(false);
    setAutoOpenFilterDropdown(true);
  }, [regenLiveValues]);

  // Tear down any in-flight capture on unmount.
  useEffect(() => () => {
    if (regenerateCaptureRef.current) { regenerateCaptureRef.current.close(); regenerateCaptureRef.current = null; }
  }, []);

  // After a regenerate completes, auto-open the filter dropdown so the user sees
  // the freshly-captured list is ready to pick from. Carbon's Dropdown has no
  // controlled-open prop (Downshift-driven), so we click its trigger.
  const filterDropdownRef = useRef(null);
  useEffect(() => {
    if (!autoOpenFilterDropdown || regenModalOpen) return;
    setAutoOpenFilterDropdown(false);
    const t = setTimeout(() => {
      const trigger = filterDropdownRef.current?.querySelector('[role="combobox"], .cds--list-box__field');
      if (trigger) trigger.click();
    }, 50);
    return () => clearTimeout(t);
  }, [autoOpenFilterDropdown, regenModalOpen]);

  // The list the dropdown actually uses: session override wins, else discovered.
  const effectiveDiscoveredOptions = sessionDiscoveredOverride ?? discoveredOptions;
  // Regenerate (live SSE re-capture) is only meaningful for RAW socket/mqtt
  // variables, where the list is stored (no query API).
  const discoveryIsStream = discoveryConnType === 'socket' || discoveryConnType === 'mqtt';

  return {
    discoveryTarget,
    effectiveDiscoveredOptions,
    discoveryLoading,
    discoveryIsStream,
    filterDropdownRef,
    // regenerate controls (for the VariableValuePickerModal)
    regenerating,
    regenModalOpen,
    regenLiveValues,
    regenRecordCount,
    startSessionRegenerate,
    stopSessionRegenerate,
  };
}

export default useFilterVariableDiscovery;
