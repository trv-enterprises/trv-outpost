// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';
import { buildResourceGraph } from '../utils/resourceGraph';

/**
 * useResourceGraph
 *
 * Loads the three resource lists ONCE (components / connections / dashboards),
 * each with the #21 `include_usage` denormalization, and builds the in-memory
 * relationship graph via the pure buildResourceGraph util.
 *
 * Loads ALL existing records — no `enabled_types` pruning. The `enabled_types`
 * allowlist gates CREATION surfaces (pickers, AI), not existing records: the
 * list pages (ConnectionsPage / ComponentsListPage) show every record
 * regardless. Pruning here would (a) hide real records from the dependency
 * graph and (b) turn every reference to a pruned record into a bogus
 * "(missing …)" node. So the navigator reflects what actually exists.
 *
 * Loads across ALL namespaces (no namespace filter) so cross-namespace
 * references resolve — namespace is a grouping scope, not a reference boundary.
 *
 * Lazy: only fetches when `enabled` is true (the modal passes its open state),
 * and won't refetch on reopen unless refresh() is called.
 *
 * @param {object}  opts
 * @param {boolean} opts.enabled  Fetch when true (e.g. modal is/has been open).
 * @returns {{ graph, loading, error, refresh, loadedOnce }}
 */
export default function useResourceGraph({ enabled = false } = {}) {
  const [graph, setGraph] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try {
      // page_size:'all' on every list — the list endpoints default to 20, so
      // without this a connection/dashboard beyond the first page resolves as
      // "(missing …)" in the graph join.
      const [compResp, connResp, dashResp] = await Promise.all([
        apiClient.getComponents({ include_usage: true, page_size: 'all' }),
        apiClient.getConnections({ include_usage: true, page_size: 'all' }),
        apiClient.getDashboards({ include_connections: true, page_size: 'all' }),
      ]);

      setGraph(
        buildResourceGraph({
          components: compResp?.components || [],
          connections: connResp?.connections || [],
          dashboards: dashResp?.dashboards || [],
        })
      );
      setError(null);
      setLoadedOnce(true);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  // Fetch the first time the consumer becomes enabled; don't refetch on reopen.
  useEffect(() => {
    if (enabled && !loadedOnce && !inFlight.current) {
      load();
    }
  }, [enabled, loadedOnce, load]);

  const refresh = useCallback(() => load(), [load]);

  return { graph, loading, error, refresh, loadedOnce };
}
