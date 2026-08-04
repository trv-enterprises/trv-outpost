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
 * Drop the CURRENT user's saved layout for one dataview chart.
 *
 * Called when a component is saved in the editor. The author has just
 * re-specified the column layout, and their own per-user drag widths from
 * viewing that chart earlier would otherwise sit on top of it — the author
 * changes a width, saves, opens the viewer, and sees the old width, with
 * nothing on screen explaining why.
 *
 * `widthBase` only covers the narrower case where the author sets an
 * explicit width on a column (a changed author width invalidates a drag
 * captured against the old one). It does nothing when the author's change
 * is to RELEASE a width to autosize, to reorder, or to hide a column —
 * and it never applies at all to columns the author never pinned. Those
 * are exactly the cases that leave a stale drag stranded.
 *
 * Scoped deliberately: this clears only the saving user's own layout for
 * this one chart. Other users' layouts are untouched — their drags are
 * still their own preference, and the existing widthBase rule remains the
 * mechanism that invalidates those when it should.
 *
 * Best-effort: a failure here must never block the component save, so it
 * resolves either way and only warns.
 *
 * @param {string} chartId
 * @returns {Promise<void>}
 */
export async function clearDataviewLayoutForCurrentUser(chartId) {
  if (!chartId) return;
  const userGuid = apiClient.getCurrentUserGuid();
  if (!userGuid) return;
  try {
    const cfg = await apiClient.getUserConfig(userGuid);
    const existing = cfg?.settings?.[APP_CONFIG_KEY] || {};
    if (!(chartId in existing)) return; // nothing stored — no write needed
    const next = { ...existing };
    delete next[chartId];
    await apiClient.updateUserConfig(userGuid, { [APP_CONFIG_KEY]: next });
  } catch (err) {
    console.warn('[useDataviewLayout] Failed to clear layout:', err);
  }
}

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
