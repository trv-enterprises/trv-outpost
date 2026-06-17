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
 * Used by the kiosk surface (and a candidate for the viewer to adopt later).
 *
 * @param {string|null} id dashboard id; null/empty → idle.
 * @returns {{ dashboard, chartsMap, loading, error, refetch }}
 */
export function useDashboardData(id) {
  const [dashboard, setDashboard] = useState(null);
  const [chartsMap, setChartsMap] = useState({});
  const [loading, setLoading] = useState(!!id);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    if (!id) {
      setDashboard(null);
      setChartsMap({});
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getDashboard(id);
      setDashboard(data);

      const map = {};
      if (data.panels && data.panels.length > 0) {
        // Batch-fetch all referenced components (defaults + component-swap
        // overrides, so a kiosk swap renders without a mid-render fetch) in ONE
        // request (#60) instead of one getComponent per panel.
        const charts = await apiClient.getDashboardComponents(id).catch(() => []);
        charts.forEach((chart) => { if (chart) map[chart.id] = chart; });
      }
      setChartsMap(map);
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

  return { dashboard, chartsMap, loading, error, refetch: fetchDashboard };
}

export default useDashboardData;
