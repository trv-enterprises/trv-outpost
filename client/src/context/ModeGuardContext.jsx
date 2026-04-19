// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useCallback, useContext, useRef } from 'react';

const ModeGuardContext = createContext(null);

/**
 * ModeGuardProvider
 *
 * Lets a page (notably DashboardViewerPage in edit mode) register a
 * guard function that runs before the app's mode toggle actually
 * changes modes. The guard's promise resolves to either:
 *   - a boolean — true to proceed with the switch, false to stay
 *   - an object — { proceed: bool, dashboardId?: string }
 *     The optional dashboardId tells the mode router which dashboard
 *     to land on after a mode switch (e.g., switching to View while
 *     editing dashboard X should land on X, not the user's default).
 *
 * Pages register via `setModeGuard(fn)` and MUST call `clearModeGuard()`
 * on unmount or when they no longer need to block (e.g., on save).
 *
 * Only one guard active at a time — the last registrant wins. This is
 * fine because there's only ever one active "dirty editor" in the app
 * tree at any moment.
 */
export function ModeGuardProvider({ children }) {
  const guardRef = useRef(null);

  const setModeGuard = useCallback((fn) => {
    guardRef.current = fn;
  }, []);

  const clearModeGuard = useCallback(() => {
    guardRef.current = null;
  }, []);

  const runModeGuard = useCallback(async (newMode) => {
    if (!guardRef.current) return { proceed: true };
    try {
      const result = await guardRef.current(newMode);
      // Normalize to { proceed, dashboardId? } regardless of whether
      // the guard returned a primitive or an object.
      if (typeof result === 'boolean') return { proceed: result };
      if (result && typeof result === 'object') {
        return { proceed: !!result.proceed, dashboardId: result.dashboardId };
      }
      return { proceed: true };
    } catch {
      // If the guard blew up, fail-safe = block the mode change so
      // the user doesn't silently lose in-progress work.
      return { proceed: false };
    }
  }, []);

  const value = { setModeGuard, clearModeGuard, runModeGuard };

  return (
    <ModeGuardContext.Provider value={value}>
      {children}
    </ModeGuardContext.Provider>
  );
}

export function useModeGuard() {
  const ctx = useContext(ModeGuardContext);
  if (!ctx) {
    // Permissive fallback so tests/isolated renders don't need a
    // provider wrap; mode changes proceed immediately.
    return {
      setModeGuard: () => {},
      clearModeGuard: () => {},
      runModeGuard: async () => ({ proceed: true }),
    };
  }
  return ctx;
}
