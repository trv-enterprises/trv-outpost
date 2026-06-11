// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useEffect, useState } from 'react';
import apiClient from '../api/client';

const AIAvailabilityContext = createContext({
  enabled: false,
  componentAgentEnabled: false,
  chatAgentEnabled: false,
  loading: true,
});

/**
 * AIAvailabilityProvider
 *
 * Fetches `/api/ai/availability` once at app boot and exposes a
 * per-surface availability map to the rest of the tree. The
 * endpoint is public (no auth required) so it can run before the
 * user signs in.
 *
 * Two AI surfaces ship today:
 *   - Component AI agent — `componentAgentEnabled`
 *   - Dashboard Assistant — `chatAgentEnabled`
 *
 * Each surface gates on its own flag independently. The legacy
 * `enabled` field aliases `componentAgentEnabled` so call sites
 * written before the chat agent landed keep working.
 *
 * Consumers should treat `loading: true` as "every surface off" —
 * hide menu items while we don't know yet. Failing closed avoids
 * the flicker of showing AI items briefly and then yanking them
 * away when the response comes back negative.
 *
 * The endpoint reflects server boot state (ANTHROPIC_API_KEY
 * presence + admin settings). It doesn't change at runtime, so
 * there's no refresh() helper and no re-fetch on auth — one fetch
 * on mount is enough.
 */
export function AIAvailabilityProvider({ children }) {
  const [state, setState] = useState({
    enabled: false,
    componentAgentEnabled: false,
    chatAgentEnabled: false,
    assistantModel: '',
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    apiClient.getAIAvailability()
      .then((res) => {
        if (cancelled) return;
        // Server returns `enabled` (legacy alias for the component
        // agent) plus `component_agent_enabled` and
        // `chat_agent_enabled`. Older servers will only set
        // `enabled` — fall back to that for both flags so the
        // dashboard works against pre-v0.20 backends.
        const componentAgentEnabled = !!(
          res?.component_agent_enabled ?? res?.enabled
        );
        const chatAgentEnabled = !!res?.chat_agent_enabled;
        setState({
          enabled: componentAgentEnabled,
          componentAgentEnabled,
          chatAgentEnabled,
          assistantModel: res?.assistant_model || '',
          loading: false,
        });
      })
      .catch(() => {
        // Network / 5xx → fail closed. A working server with no key
        // returns false flags, so the only path here is an actual
        // outage. Hiding AI items in that case is the safe call.
        if (!cancelled) setState({
          enabled: false,
          componentAgentEnabled: false,
          chatAgentEnabled: false,
          assistantModel: '',
          loading: false,
        });
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
 * Returns `{ enabled, componentAgentEnabled, chatAgentEnabled, loading }`:
 *   - enabled: legacy alias for componentAgentEnabled
 *   - componentAgentEnabled: true iff Component AI agent is available
 *   - chatAgentEnabled: true iff Dashboard Assistant is available
 *   - loading: true until the first response is in; treat as "AI off"
 *
 * Most callers want one of:
 *   const { componentAgentEnabled } = useAIAvailability();
 *   const { chatAgentEnabled } = useAIAvailability();
 */
export function useAIAvailability() {
  return useContext(AIAvailabilityContext);
}
