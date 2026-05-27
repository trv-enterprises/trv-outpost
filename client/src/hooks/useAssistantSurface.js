// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef } from 'react';
import { useAssistantSurfaceMutator } from '../context/AssistantSurfaceContext';

/**
 * useAssistantSurface — page-side hook that publishes the current
 * surface (mode + surface kind + id + optional panel list) into
 * AssistantSurfaceContext.
 *
 * Pages call this with their current state and the provider updates
 * whenever the inputs change. On unmount the hook clears the slot —
 * but only if no other page has registered since (the token guard
 * in the provider handles the race).
 *
 * The dependency array compares the rendered string of the surface,
 * not its identity, so a parent's render that produces a fresh
 * object every time doesn't churn the provider on every keystroke.
 *
 * Pass `null` (or a falsy value) to opt out — e.g. a list page
 * that has no specific entity in view shouldn't pin a stale surface.
 */
export default function useAssistantSurface(surface) {
  const ctx = useAssistantSurfaceMutator();
  const tokenRef = useRef(null);

  // Serialize so we only re-register on actual content changes.
  // JSON.stringify is fine here — surface objects are tiny and we
  // already constrained the shape in the provider's sanitize step.
  const serialized = surface ? JSON.stringify(surface) : '';

  useEffect(() => {
    if (!ctx) return undefined;
    if (!serialized) {
      // Explicit null/empty → clear our previous registration if we
      // still own the slot.
      if (tokenRef.current != null) {
        ctx.clear(tokenRef.current);
        tokenRef.current = null;
      }
      return undefined;
    }
    tokenRef.current = ctx.register(JSON.parse(serialized));
    return () => {
      if (tokenRef.current != null) {
        ctx.clear(tokenRef.current);
        tokenRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized, ctx]);
}
