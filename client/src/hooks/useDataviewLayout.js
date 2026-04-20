// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';

// User-config key holding all per-user dataview layouts, keyed by chart id.
// Shape:
//   {
//     "<chart_id>": {
//       widths: { "col_name": 240, ... },
//       order:  ["col_a", "col_b", ...]
//     },
//     ...
//   }
//
// The wrapper key keeps every dataview's per-user layout in one round-trip
// rather than fanning out to N user-config keys.
const APP_CONFIG_KEY = 'dataview_layouts';

// Debounce window for save bursts. AG Grid fires onColumnResized many
// times during a single drag — coalescing into one PUT keeps the user
// config endpoint quiet.
const SAVE_DEBOUNCE_MS = 600;

/**
 * useDataviewLayout
 *
 * Loads the current user's saved layout for a specific dataview chart
 * and returns a saver that persists changes back to app_config.
 *
 *   const { layout, saveLayout } = useDataviewLayout(chartId);
 *
 *   layout       — { widths: {col: px}, order: [col, ...] } | null
 *   saveLayout   — accepts either a partial object to merge, or a
 *                  function (prev) => next. Coalesces rapid calls.
 *
 * The hook is a no-op when chartId is empty (e.g., during chart
 * preview in the editor before save). It safely tolerates a missing
 * user GUID (returns null layout, ignores saves).
 */
export function useDataviewLayout(chartId) {
  const [layout, setLayout] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const pendingRef = useRef(null);
  const saveTimerRef = useRef(null);

  // Load on mount / chart change.
  useEffect(() => {
    if (!chartId) {
      setLayout(null);
      setLoaded(true);
      return undefined;
    }
    let cancelled = false;
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) {
      setLoaded(true);
      return undefined;
    }
    apiClient.getUserConfig(userGuid).then((cfg) => {
      if (cancelled) return;
      const layouts = cfg?.settings?.[APP_CONFIG_KEY] || {};
      setLayout(layouts[chartId] || null);
      setLoaded(true);
    }).catch(() => {
      if (cancelled) return;
      setLoaded(true);
    });
    return () => { cancelled = true; };
  }, [chartId]);

  const flushSave = useCallback(async () => {
    saveTimerRef.current = null;
    const next = pendingRef.current;
    pendingRef.current = null;
    if (!next || !chartId) return;
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    try {
      // Merge into the existing dataview_layouts map without clobbering
      // other charts' entries. Read-modify-write is fine — the user
      // can only have one tab editing this at a time.
      const cfg = await apiClient.getUserConfig(userGuid);
      const existing = cfg?.settings?.[APP_CONFIG_KEY] || {};
      const merged = { ...existing, [chartId]: next };
      await apiClient.updateUserConfig(userGuid, { [APP_CONFIG_KEY]: merged });
    } catch (err) {
      console.warn('[useDataviewLayout] Failed to persist layout:', err);
    }
  }, [chartId]);

  const saveLayout = useCallback((updater) => {
    if (!chartId) return;
    setLayout((prev) => {
      const base = prev || {};
      const next = typeof updater === 'function' ? updater(base) : { ...base, ...updater };
      pendingRef.current = next;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
      return next;
    });
  }, [chartId, flushSave]);

  // Cleanup pending timer on unmount — flush so a fast unmount after a
  // resize doesn't lose the change.
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        flushSave();
      }
    };
  }, [flushSave]);

  return { layout, loaded, saveLayout };
}
