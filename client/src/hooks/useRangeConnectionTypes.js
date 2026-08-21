// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';
import { RANGE_VARIABLE_TOKEN } from '../utils/dataTransforms';
import { maxPointsForType, chartTypeConsumesRange, resolveMinStepMs } from '../utils/rangePresets';

/**
 * useRangeConnectionTypes — classify the connection types a range variable
 * scopes, so callers know whether to show the step field, which type's step
 * budget applies, whether any panel actually consumes the range, and can
 * warn on a mixed-type range dashboard.
 *
 * Lifted out of DashboardViewerPage so the desktop viewer and the mobile viewer
 * share ONE implementation — both range pickers need the same step/consumer
 * classification.
 *
 * @param {object}   p
 * @param {object}   p.rangeVariable  the range DashboardVariable (or null)
 * @param {Array}    p.panels         dashboard panels
 * @param {object}   p.chartsMap      component_id → component record
 * @param {object}   p.dashboard      dashboard record (once-per-dash warn key)
 * @param {Function} [p.pushToast]        optional toast sink
 * @param {Function} [p.addNotification] optional notification sink
 * @returns {{ rangeConnTypes, rangeMixedType, rangeConnType, rangeSupportsStep, rangeHasConsumer }}
 */
export function useRangeConnectionTypes({
  rangeVariable,
  panels,
  chartsMap,
  dashboard,
  pushToast,
  addNotification,
}) {
  // Connection ids backing RANGE-scoped components: a SQL/EdgeLake component
  // whose query carries the {{range-variable}} token, OR any tsstore/Prometheus
  // component (those auto-apply the window). Also includes every referenced
  // connection so the resolver can classify tsstore/Prometheus (auto-apply)
  // panels; non-time types are dropped in the effect below.
  const rangeScopedConnIds = useMemo(() => {
    if (!rangeVariable) return [];
    const ids = new Set();
    for (const panel of panels || []) {
      const comp = panel?.component_id ? chartsMap[panel.component_id] : null;
      if (!comp || !comp.connection_id) continue;
      const raw = comp.query_config?.raw;
      if (typeof raw === 'string' && raw.includes(RANGE_VARIABLE_TOKEN)) {
        ids.add(comp.connection_id);
      }
    }
    for (const panel of panels || []) {
      const comp = panel?.component_id ? chartsMap[panel.component_id] : null;
      if (comp?.connection_id) ids.add(comp.connection_id);
    }
    return [...ids];
  }, [rangeVariable, panels, chartsMap]);

  // Resolved distinct time-series type set across those connections.
  const [rangeConnTypes, setRangeConnTypes] = useState(null); // string[] | null
  // Store descriptors backing range-scoped ts-store panels, used to INFER the
  // step granularity floor (#277). Only ts-store reports its rollup window.
  const [rangeStores, setRangeStores] = useState([]);
  useEffect(() => {
    let cancelled = false;
    if (!rangeVariable || rangeScopedConnIds.length === 0) {
      setRangeConnTypes(null);
      setRangeStores([]);
      return undefined;
    }
    (async () => {
      const conns = await Promise.all(
        rangeScopedConnIds.map((id) => apiClient.getConnection(id).catch(() => null)),
      );
      if (cancelled) return;
      // Keep only time-series-capable types (those a range can scope).
      const TIME_TYPES = new Set(['sql', 'edgelake', 'tsstore', 'prometheus']);
      const types = [...new Set(
        conns.map((c) => c?.type || c?.config?.type).filter((t) => TIME_TYPES.has(t)),
      )];
      setRangeConnTypes(types);

      // Granularity floor inference (#277). ts-store reports a rollup store's
      // window in its store listing; nothing else does. Fetch the listing for
      // each ts-store connection and keep the descriptor for its PINNED store
      // (config.tsstore.store_name) — that's the store the panel actually
      // reads. Endpoint-scoped connections (no pinned store) contribute no
      // floor here: which store a panel uses is a per-component choice, so
      // there is no single answer at the dashboard level.
      //
      // Best-effort by construction: a failed or slow listing yields no floor
      // rather than blocking. Losing the step dropdown because a metadata call
      // timed out would be far worse than offering a too-fine step.
      const tsConns = conns.filter((c) => c && (c.type || c.config?.type) === 'tsstore');
      if (tsConns.length === 0) {
        setRangeStores([]);
        return;
      }
      const listings = await Promise.all(
        tsConns.map(async (c) => {
          const pinned = c.config?.tsstore?.store_name;
          if (!pinned) return null;
          try {
            const res = await apiClient.getConnectionStores(c.id || c._id);
            const stores = Array.isArray(res) ? res : (res?.stores || []);
            return stores.find((st) => st?.name === pinned) || null;
          } catch {
            return null; // no floor from this connection
          }
        }),
      );
      if (cancelled) return;
      setRangeStores(listings.filter(Boolean));
    })();
    return () => { cancelled = true; };
  }, [rangeVariable, rangeScopedConnIds]);

  // Effective step floor (ms) for this dashboard: the MAX rollup window across
  // range-scoped panels, unless the variable declares a manual `min_step`
  // (which always wins — see resolveMinStepMs).
  const rangeMinStepMs = useMemo(
    () => resolveMinStepMs(rangeStores, rangeVariable?.range?.min_step),
    [rangeStores, rangeVariable?.range?.min_step],
  );

  const rangeMixedType = Array.isArray(rangeConnTypes) && rangeConnTypes.length > 1;
  // The single connection type driving the range, or null when mixed/none. A
  // range dashboard is expected to be single-type (rangeMixedType warns below),
  // so this is the type whose step budget and semantics apply.
  const rangeConnType = Array.isArray(rangeConnTypes) && rangeConnTypes.length === 1 ? rangeConnTypes[0] : null;
  // Step is only meaningful for types that downsample server-side. Driven off
  // the shared budget map so a new step-aware type only touches rangePresets.
  const rangeSupportsStep = maxPointsForType(rangeConnType) !== null;

  // Whether ANY panel on the dashboard actually consumes the range. A range
  // variable can exist with no consumer — a board of only gauges, or of
  // streaming charts that don't yet honor range — in which case the picker
  // should not appear (it would "show but do nothing"). A consumer is:
  //   - an SQL/EdgeLake chart with the {{range-variable}} token in its query, OR
  //   - a series (non gauge/number/pie) chart on a range-scoping connection type.
  // rangeConnTypes resolves async; until it's known we optimistically show the
  // picker (matches prior behavior) and hide it only once we KNOW there's no
  // consumer, so a slow connection fetch never flickers the control away.
  const rangeHasConsumer = useMemo(() => {
    if (!rangeVariable) return false;
    const timeTypeConns = new Set(rangeScopedConnIds); // referenced time-capable conns
    for (const panel of panels || []) {
      const comp = panel?.component_id ? chartsMap[panel.component_id] : null;
      if (!comp) continue;
      const raw = comp.query_config?.raw;
      if (typeof raw === 'string' && raw.includes(RANGE_VARIABLE_TOKEN)) return true; // SQL/EdgeLake token
      // Series chart on a connection the range can scope. rangeConnTypes null →
      // not yet resolved; treat as "maybe" so we don't hide prematurely.
      if (chartTypeConsumesRange(comp.chart_type) && comp.connection_id && timeTypeConns.has(comp.connection_id)) {
        if (rangeConnTypes === null) return true; // unresolved → optimistic
        if (maxPointsForType(rangeConnType) !== null || rangeConnType === 'sql' || rangeConnType === 'edgelake') return true;
      }
    }
    return false;
  }, [rangeVariable, panels, chartsMap, rangeScopedConnIds, rangeConnTypes, rangeConnType]);

  // Surface the mixed-type guard once per dashboard.
  const rangeMixedWarnedRef = useRef(null);
  useEffect(() => {
    if (!rangeMixedType) return;
    const key = `${dashboard?.id || ''}`;
    if (rangeMixedWarnedRef.current === key) return;
    rangeMixedWarnedRef.current = key;
    const msg = `This dashboard's time-range variable spans more than one connection type (${rangeConnTypes.join(', ')}). A range dashboard must be single-type — the range may not apply correctly.`;
    pushToast?.({ kind: 'error', title: 'Range variable: mixed connection types', subtitle: msg });
    addNotification?.({ kind: 'error', title: 'Range variable: mixed connection types', subtitle: msg });
  }, [rangeMixedType, rangeConnTypes, dashboard?.id, pushToast, addNotification]);

  return { rangeConnTypes, rangeMixedType, rangeConnType, rangeSupportsStep, rangeHasConsumer, rangeMinStepMs };
}

export default useRangeConnectionTypes;
