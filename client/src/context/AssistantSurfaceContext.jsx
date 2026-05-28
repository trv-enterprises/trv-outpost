// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

// Two separate contexts on purpose:
// - SurfaceValueContext changes every time the active surface changes.
//   Only the sidecard (which reads the value) subscribes here.
// - SurfaceMutatorContext is stable for the life of the provider.
//   Pages that register surfaces subscribe here so their re-render
//   doesn't fire when somebody else updates the surface — preventing
//   a register → setSurface → re-render-via-mutator-context →
//   register-again infinite loop.
const SurfaceValueContext = createContext(null);
const SurfaceMutatorContext = createContext(null);

/**
 * AssistantSurfaceContext — per-turn awareness of what the user is
 * currently looking at, fed into the Dashboard Assistant's system
 * prompt so it can answer "update the chart I'm looking at" without
 * a list_components round-trip.
 *
 * Provider owns a single "current surface" record, updated by pages
 * via the `useAssistantSurface` hook. The sidecard reads it through
 * `useAssistantSurfaceValue` and includes it in every sendMessage
 * call.
 *
 * Why a single slot (rather than a stack): exactly one page is
 * mounted at a time in our routing model. The hook clears the slot
 * on unmount, but only if its own registration is still the one
 * stored — a guard against route-switch races where the new page
 * mounts before the old one unmounts.
 *
 * Shape of the surface object:
 *   {
 *     mode: 'VIEW' | 'EDIT',
 *     surface: 'DASHBOARD' | 'COMPONENT' | 'CONNECTION',
 *     surfaceId?: string,
 *     surfaceName?: string,
 *     // Dashboards only:
 *     panels?: Array<{
 *       id: string,
 *       title?: string,
 *       componentId?: string,
 *       componentType?: 'chart' | 'control' | 'display',
 *       chartType?: string,
 *     }>,
 *   }
 *
 * Anything else passed in is dropped — the provider keeps the shape
 * tight so we don't accidentally exfiltrate page state into the
 * model's prompt.
 */

const ALLOWED_MODES = new Set(['VIEW', 'EDIT']);
const ALLOWED_SURFACES = new Set(['DASHBOARD', 'COMPONENT', 'CONNECTION']);

function sanitizeSurface(input) {
  if (!input || typeof input !== 'object') return null;
  const mode = ALLOWED_MODES.has(input.mode) ? input.mode : 'VIEW';
  if (!ALLOWED_SURFACES.has(input.surface)) return null;
  const out = {
    mode,
    surface: input.surface,
  };
  if (input.surfaceId) out.surfaceId = String(input.surfaceId);
  if (input.surfaceName) out.surfaceName = String(input.surfaceName);
  if (Array.isArray(input.panels)) {
    out.panels = input.panels
      .filter((p) => p && typeof p === 'object' && p.id)
      .map((p) => {
        const panel = { id: String(p.id) };
        if (p.title) panel.title = String(p.title);
        if (p.componentId) panel.componentId = String(p.componentId);
        if (p.componentType) panel.componentType = String(p.componentType);
        if (p.chartType) panel.chartType = String(p.chartType);
        return panel;
      });
  }
  return out;
}

export function AssistantSurfaceProvider({ children }) {
  const [surface, setSurface] = useState(null);
  // tokenRef holds the most recently-issued registration token. A
  // page's clear() only takes effect if its token still matches —
  // prevents the previous page's late unmount from wiping the new
  // page's freshly-registered surface.
  const tokenRef = useRef(0);

  const register = useCallback((next) => {
    tokenRef.current += 1;
    const myToken = tokenRef.current;
    setSurface(sanitizeSurface(next));
    return myToken;
  }, []);

  const clear = useCallback((token) => {
    if (token === tokenRef.current) {
      setSurface(null);
    }
  }, []);

  // Mutator value is stable across renders — register/clear are
  // useCallback'd with empty deps. That's what keeps consumers of
  // the mutator (pages calling useAssistantSurface) from re-running
  // their effect every time the value changes.
  const mutator = useMemo(() => ({ register, clear }), [register, clear]);

  return (
    <SurfaceMutatorContext.Provider value={mutator}>
      <SurfaceValueContext.Provider value={surface}>
        {children}
      </SurfaceValueContext.Provider>
    </SurfaceMutatorContext.Provider>
  );
}

// Used by the sidecard / session hook to read the current surface
// at send time. Returns null when no page has registered.
export function useAssistantSurfaceValue() {
  return useContext(SurfaceValueContext);
}

// Internal helper for the page-side hook to grab the mutator API
// without re-rendering on surface changes. Returns null when used
// outside the provider (e.g. unit tests).
export function useAssistantSurfaceMutator() {
  return useContext(SurfaceMutatorContext);
}
