// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useState } from 'react';
import apiClient from '../api/client';

/**
 * useDashboardData — load a dashboard record plus the components its panels
 * reference, keyed by id. Mirrors the viewer's fetchDashboard: fetch the
 * dashboard, then fetch each referenced component into a `chartsMap` keyed by
 * component id.
 *
 * Used by the kiosk surface and the mobile viewer (and a candidate for the
 * desktop viewer to adopt later).
 *
 * @param {string|null} id dashboard id; null/empty → idle.
 * @returns {{ dashboard, chartsMap, unauthorizedComponents, loading, error, refetch }}
 *   unauthorizedComponents maps component_id → "component" | "connection" for
 *   panels the caller can't see (#4); empty for unrestricted users.
 */
export function useDashboardData(id) {
  const [dashboard, setDashboard] = useState(null);
  const [chartsMap, setChartsMap] = useState({});
  const [unauthorizedComponents, setUnauthorizedComponents] = useState({});
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    if (!id) {
      setDashboard(null);
      setChartsMap({});
      setUnauthorizedComponents({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getDashboard(id);
      setDashboard(data);

      const map = {};
      const unauthorized = {};
      if (data.panels && data.panels.length > 0) {
        // Batch-fetch all referenced components (defaults + component-swap
        // overrides, so a swap renders without a mid-render fetch) in ONE
        // request (#60) instead of one getComponent per panel. Use the
        // authorized envelope so callers can render an "unauthorized" panel
        // (#4) instead of a blank one when a component/connection is in an
        // ungranted namespace.
        const res = await apiClient.getDashboardComponentsAuthorized(id)
          .catch(() => ({ components: [], unauthorized: [] }));
        (res.components || []).forEach((chart) => { if (chart) map[chart.id] = chart; });
        (res.unauthorized || []).forEach((u) => {
          if (u && u.id) unauthorized[u.id] = u.reason || 'component';
        });
      }
      setChartsMap(map);
      setUnauthorizedComponents(unauthorized);
    } catch (err) {
      setError(err.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    // Re-run on id change; guard state writes against unmount/id-swap races.
    (async () => {
      if (cancelled) return;
      await fetchDashboard();
    })();
    return () => { cancelled = true; };
  }, [fetchDashboard]);

  return { dashboard, chartsMap, unauthorizedComponents, loading, error, refetch: fetchDashboard };
}

export default useDashboardData;
