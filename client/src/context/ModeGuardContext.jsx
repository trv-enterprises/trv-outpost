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
 * changes modes. The guard returns a promise:
 *   - resolve(true)  → proceed with the mode switch
 *   - resolve(false) → stay in the current mode
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

  const runModeGuard = useCallback(async () => {
    if (!guardRef.current) return true;
    try {
      return await guardRef.current();
    } catch {
      // If the guard blew up, fail-safe = block the mode change so
      // the user doesn't silently lose in-progress work.
      return false;
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
      runModeGuard: async () => true,
    };
  }
  return ctx;
}
