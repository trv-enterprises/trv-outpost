// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';
import { RANGE_VARIABLE_TOKEN } from '../utils/dataTransforms';

/**
 * useRangeConnectionTypes — classify the connection types a range variable
 * scopes, so callers know whether to show the Prometheus step field and can
 * warn on a mixed-type range dashboard.
 *
 * Lifted out of DashboardViewerPage so the desktop viewer and the mobile viewer
 * share ONE implementation — the mobile range picker needs the same
 * `rangeIsPrometheus` flag to render the step dropdown. Behavior unchanged.
 *
 * @param {object}   p
 * @param {object}   p.rangeVariable  the range DashboardVariable (or null)
 * @param {Array}    p.panels         dashboard panels
 * @param {object}   p.chartsMap      component_id → component record
 * @param {object}   p.dashboard      dashboard record (once-per-dash warn key)
 * @param {Function} [p.pushToast]        optional toast sink
 * @param {Function} [p.addNotification] optional notification sink
 * @returns {{ rangeConnTypes, rangeMixedType, rangeIsPrometheus }}
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
  useEffect(() => {
    let cancelled = false;
    if (!rangeVariable || rangeScopedConnIds.length === 0) {
      setRangeConnTypes(null);
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
    })();
    return () => { cancelled = true; };
  }, [rangeVariable, rangeScopedConnIds]);

  const rangeMixedType = Array.isArray(rangeConnTypes) && rangeConnTypes.length > 1;
  const rangeIsPrometheus = Array.isArray(rangeConnTypes)
    && rangeConnTypes.length === 1 && rangeConnTypes[0] === 'prometheus';

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

  return { rangeConnTypes, rangeMixedType, rangeIsPrometheus };
}

export default useRangeConnectionTypes;
