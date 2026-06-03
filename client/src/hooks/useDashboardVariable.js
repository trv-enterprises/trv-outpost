// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';

/**
 * useDashboardVariable — runtime state + resolution for the dashboard-variable
 * feature (v1: connection-swap).
 *
 * A dashboard may define a single connection_swap variable. When the feature is
 * enabled (global admin gate AND the per-dashboard toggle), a header dropdown
 * lets the viewer pick a connection; selecting one repoints every
 * variable-driven component (component.uses_dashboard_variable === true) to the
 * chosen connection at view time. The component's stored connection_id is the
 * baseline and is never rewritten.
 *
 * Resolution of the active value: URL query param `?var_<name>=<connId>` wins;
 * otherwise the user's per-dashboard saved value
 * (userConfig.settings.dashboard_variable_values[dashboardId][name]); otherwise
 * none (components fall through to their design-time connection).
 *
 * Why a hook and not a context: in v1 both consumers (the header dropdown and
 * the connectionId resolution) live in DashboardViewerPage's own render, so a
 * context would add indirection with no cross-tree consumer. If filter-value
 * mode later needs deep consumers, promote this to a provider.
 *
 * @param {object}   params
 * @param {object}   params.dashboard       the loaded dashboard (or null)
 * @param {boolean}  params.globalEnabled   admin gate (dashboard_variable.enabled)
 * @param {Function} params.getSearchParam  () => current URLSearchParams
 * @param {Function} params.setSearchParam  (key, value) => void  (value null clears)
 */
export function useDashboardVariable({ dashboard, globalEnabled, getSearchParam, setSearchParam }) {
  const dashboardId = dashboard?.id || null;
  const settings = dashboard?.settings || {};

  // The single connection_swap variable (v1: index 0). Null when the feature
  // is off or no connection_swap variable is defined.
  const variable = useMemo(() => {
    if (!globalEnabled || !settings.variables_enabled) return null;
    const list = Array.isArray(settings.variables) ? settings.variables : [];
    return list.find((v) => v && v.mode === 'connection_swap') || null;
  }, [globalEnabled, settings.variables_enabled, settings.variables]);

  const variableName = variable?.name || null;

  // The single filter-mode variable (v1 allows at most one). Independent of the
  // connection_swap variable — the two may coexist (different mechanisms). The
  // filter variable holds a free string VALUE substituted server-side into the
  // query ({{dashboard-variable}} token) and client-side into filters.
  const filterVariable = useMemo(() => {
    if (!globalEnabled || !settings.variables_enabled) return null;
    const list = Array.isArray(settings.variables) ? settings.variables : [];
    return list.find((v) => v && v.mode === 'filter') || null;
  }, [globalEnabled, settings.variables_enabled, settings.variables]);

  const filterVariableName = filterVariable?.name || null;

  const [candidates, setCandidates] = useState([]);
  // The selected connection_id for the active variable (null = none selected).
  const [selectedConnId, setSelectedConnId] = useState(null);
  const loadedForRef = useRef(null);

  // The active value for the filter-mode variable (null = none/unset). A plain
  // string, persisted the same way as the connection value (URL + userConfig).
  const [filterValue, setFilterValueState] = useState(null);
  const filterLoadedForRef = useRef(null);

  // Fetch candidate connections whenever the active variable changes.
  useEffect(() => {
    let cancelled = false;
    if (!dashboardId || !variableName) {
      setCandidates([]);
      return undefined;
    }
    apiClient
      .getDashboardVariableCandidates(dashboardId, variableName)
      .then((res) => {
        if (cancelled) return;
        setCandidates(res?.candidates || []);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [dashboardId, variableName]);

  // Resolve the initial selection once candidates are known. URL param wins,
  // then the per-user saved value; the chosen id must be a known candidate.
  useEffect(() => {
    if (!dashboardId || !variableName) return;
    // Re-resolve only when the (dashboard, variable) pair changes — not on
    // every candidate refresh — so we don't clobber a live user selection.
    const resolveKey = `${dashboardId}::${variableName}`;
    if (loadedForRef.current === resolveKey) return;
    if (!candidates.length) return; // wait until we can validate against candidates
    loadedForRef.current = resolveKey;

    const valid = (cid) => !!cid && candidates.some((c) => c.id === cid);

    const fromUrl = getSearchParam?.()?.get(`var_${variableName}`);
    if (valid(fromUrl)) {
      setSelectedConnId(fromUrl);
      return;
    }

    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) {
      setSelectedConnId(null);
      return;
    }
    apiClient
      .getUserConfig(userGuid)
      .then((cfg) => {
        const saved = cfg?.settings?.dashboard_variable_values?.[dashboardId]?.[variableName];
        setSelectedConnId(valid(saved) ? saved : null);
      })
      .catch(() => setSelectedConnId(null));
  }, [dashboardId, variableName, candidates, getSearchParam]);

  // Set + persist the selected value. Updates state, writes the URL param, and
  // saves to userConfig (mirrors the fit-mode pattern incl. stale-id pruning).
  const setValue = useCallback(
    (connId) => {
      if (!dashboardId || !variableName) return;
      setSelectedConnId(connId || null);

      // URL param (shareable). Clear when deselected.
      setSearchParam?.(`var_${variableName}`, connId || null);

      const userGuid = apiClient.getCurrentUserGuid();
      if (!userGuid) return; // anonymous → URL-only persistence

      Promise.all([
        apiClient.getUserConfig(userGuid).catch(() => ({ settings: {} })),
        apiClient.getDashboards().catch(() => ({ dashboards: [] })),
      ]).then(([cfg, dashboardsRes]) => {
        const existing = cfg?.settings?.dashboard_variable_values || {};
        const liveList = dashboardsRes?.dashboards || dashboardsRes?.Dashboards || [];
        const liveIds = new Set(liveList.map((d) => d.id).filter(Boolean));
        liveIds.add(dashboardId); // always preserve the one we're setting

        const pruned = {};
        for (const [dashId, vals] of Object.entries(existing)) {
          if (liveIds.has(dashId)) pruned[dashId] = vals;
        }
        const dashVals = { ...(pruned[dashboardId] || {}) };
        if (connId) dashVals[variableName] = connId;
        else delete dashVals[variableName];
        pruned[dashboardId] = dashVals;

        apiClient
          .updateUserConfig(userGuid, { dashboard_variable_values: pruned })
          .catch(() => {});
      });
    },
    [dashboardId, variableName, setSearchParam],
  );

  // Resolve the initial filter value once, when the filter variable is known.
  // URL param wins, then the per-user saved value, then the variable's
  // DefaultValue. No candidate validation — options are author-defined (static
  // list or free text), so any saved/URL value is accepted as-is.
  useEffect(() => {
    if (!dashboardId || !filterVariableName) {
      setFilterValueState(null);
      return;
    }
    const resolveKey = `${dashboardId}::${filterVariableName}`;
    if (filterLoadedForRef.current === resolveKey) return;
    filterLoadedForRef.current = resolveKey;

    const fromUrl = getSearchParam?.()?.get(`var_${filterVariableName}`);
    if (fromUrl) {
      setFilterValueState(fromUrl);
      return;
    }

    const fallback = filterVariable?.filter_value?.default_value || null;
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) {
      setFilterValueState(fallback);
      return;
    }
    apiClient
      .getUserConfig(userGuid)
      .then((cfg) => {
        const saved = cfg?.settings?.dashboard_variable_values?.[dashboardId]?.[filterVariableName];
        setFilterValueState(saved != null ? saved : fallback);
      })
      .catch(() => setFilterValueState(fallback));
  }, [dashboardId, filterVariableName, filterVariable, getSearchParam]);

  // Set + persist the filter value (pass null/'' to clear). Same persistence
  // path as the connection setter (URL param + userConfig, stale-id pruning).
  const setFilterValue = useCallback(
    (value) => {
      if (!dashboardId || !filterVariableName) return;
      const v = value || null;
      setFilterValueState(v);

      setSearchParam?.(`var_${filterVariableName}`, v);

      const userGuid = apiClient.getCurrentUserGuid();
      if (!userGuid) return; // anonymous → URL-only persistence

      Promise.all([
        apiClient.getUserConfig(userGuid).catch(() => ({ settings: {} })),
        apiClient.getDashboards().catch(() => ({ dashboards: [] })),
      ]).then(([cfg, dashboardsRes]) => {
        const existing = cfg?.settings?.dashboard_variable_values || {};
        const liveList = dashboardsRes?.dashboards || dashboardsRes?.Dashboards || [];
        const liveIds = new Set(liveList.map((d) => d.id).filter(Boolean));
        liveIds.add(dashboardId);

        const pruned = {};
        for (const [dashId, vals] of Object.entries(existing)) {
          if (liveIds.has(dashId)) pruned[dashId] = vals;
        }
        const dashVals = { ...(pruned[dashboardId] || {}) };
        if (v) dashVals[filterVariableName] = v;
        else delete dashVals[filterVariableName];
        pruned[dashboardId] = dashVals;

        apiClient
          .updateUserConfig(userGuid, { dashboard_variable_values: pruned })
          .catch(() => {});
      });
    },
    [dashboardId, filterVariableName, setSearchParam],
  );

  // Resolve a panel's effective connection_id for connection-swap. When the
  // variable is active and a connection is selected, EVERY panel follows it by
  // default — the connection IS the variable, so any panel can be repointed.
  // A panel opts OUT via panel.pin_connection (set per placement, in the panel
  // edit menu), keeping its component's own connection. With no selection (or
  // feature off) everything falls through to the component's design-time
  // connection_id.
  const resolveConnectionId = useCallback(
    (component, panel) => {
      const baseline = component?.connection_id;
      if (!variableName || !selectedConnId) return baseline;
      if (panel?.pin_connection) return baseline;
      return selectedConnId;
    },
    [variableName, selectedConnId],
  );

  return {
    /** the active connection_swap variable definition, or null when inactive */
    variable,
    /** candidate connections for the dropdown */
    candidates,
    /** currently selected connection_id (null = none) */
    selectedConnId,
    /** set + persist the selection (pass null to clear) */
    setValue,
    /** (component, panel) => effective connection_id */
    resolveConnectionId,
    /** the active filter-mode variable definition, or null when inactive */
    filterVariable,
    /** the active filter value (string), or null when unset */
    filterValue,
    /** set + persist the filter value (pass null/'' to clear) */
    setFilterValue,
    /** true when EITHER variable mode is active for this dashboard */
    active: !!variable || !!filterVariable,
  };
}

export default useDashboardVariable;
