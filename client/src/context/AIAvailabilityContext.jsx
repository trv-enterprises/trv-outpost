// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useEffect, useState } from 'react';
import apiClient from '../api/client';

const AIAvailabilityContext = createContext({ enabled: false, loading: true });

/**
 * AIAvailabilityProvider
 *
 * Fetches `/api/ai/availability` once at app boot and exposes the
 * single boolean to the rest of the tree. The endpoint is public
 * (no auth required) so it can run before the user signs in.
 *
 * Consumers should treat `loading: true` as "AI off" — i.e. hide
 * menu items while we don't know yet. Failing closed avoids the
 * flicker of showing AI items briefly and then yanking them away
 * when the response comes back negative.
 *
 * The endpoint reflects server boot state (ANTHROPIC_API_KEY
 * presence). It doesn't change at runtime, so there's no refresh()
 * helper and no re-fetch on auth — one fetch on mount is enough.
 */
export function AIAvailabilityProvider({ children }) {
  const [state, setState] = useState({ enabled: false, loading: true });

  useEffect(() => {
    let cancelled = false;
    apiClient.getAIAvailability()
      .then((res) => {
        if (!cancelled) setState({ enabled: !!res?.enabled, loading: false });
      })
      .catch(() => {
        // Network / 5xx → fail closed. A working server with no key
        // returns { enabled: false }, so the only path here is an
        // actual outage. Hiding AI items in that case is the safe
        // call; the rest of the app will surface the outage anyway.
        if (!cancelled) setState({ enabled: false, loading: false });
      });
    return () => { cancelled = true; };
  }, []);

  return (
    <AIAvailabilityContext.Provider value={state}>
      {children}
    </AIAvailabilityContext.Provider>
  );
}

/**
 * Read AI availability anywhere in the tree.
 *
 * Returns `{ enabled, loading }`:
 *   - enabled: true iff the server was started with an Anthropic API key
 *   - loading: true until the first response is in; treat as "AI off"
 *
 * Most callers want: `const { enabled } = useAIAvailability();`
 * and gate `enabled && <AIMenuItem ... />`.
 */
export function useAIAvailability() {
  return useContext(AIAvailabilityContext);
}
