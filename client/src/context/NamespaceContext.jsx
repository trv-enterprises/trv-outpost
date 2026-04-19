// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import apiClient from '../api/client';

const NamespaceContext = createContext(null);

// Every create path inherits this when the app starts before the user
// has picked a namespace.
const FALLBACK_NAMESPACE = 'default';

/**
 * NamespaceProvider
 *
 * Loads the namespace list from the backend and syncs the active
 * namespace with the current user's app_config (key: `active_namespace`).
 * Any edit form that creates a new connection/component/dashboard reads
 * `activeNamespace` from here to pre-fill the namespace select.
 *
 * When the user switches identities (via the user dropdown in the
 * header), pass the fresh GUID as `currentUserGuid` so the provider
 * re-syncs the active namespace from that user's prefs. Without this
 * the value stays pinned to whoever logged in first.
 */
export function NamespaceProvider({ currentUserGuid, children }) {
  const [namespaces, setNamespaces] = useState([]);
  const [activeNamespace, setActiveNamespaceState] = useState(FALLBACK_NAMESPACE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Track which user's pref we last resolved so we only reload on change.
  const lastResolvedUserRef = useRef(null);

  const loadList = useCallback(async () => {
    try {
      const data = await apiClient.getNamespaces();
      setNamespaces(data?.namespaces || []);
      setError(null);
      return data?.namespaces || [];
    } catch (err) {
      setError(err);
      return [];
    }
  }, []);

  // Restore the active namespace from the user's app_config. If the
  // stored value doesn't match any namespace the system knows about
  // (e.g., the namespace was deleted), fall back to "default".
  const restoreActive = useCallback(async (list) => {
    if (!currentUserGuid) {
      setActiveNamespaceState(FALLBACK_NAMESPACE);
      return;
    }
    try {
      const cfg = await apiClient.getUserConfig(currentUserGuid);
      const stored = cfg?.settings?.active_namespace;
      const validNames = new Set((list || []).map((n) => n.name));
      if (stored && validNames.has(stored)) {
        setActiveNamespaceState(stored);
      } else {
        setActiveNamespaceState(FALLBACK_NAMESPACE);
      }
    } catch {
      // User config fetch is best-effort; a failure just leaves us at
      // the fallback rather than blocking the whole UI.
      setActiveNamespaceState(FALLBACK_NAMESPACE);
    }
  }, [currentUserGuid]);

  const refresh = useCallback(async () => {
    setLoading(true);
    const list = await loadList();
    await restoreActive(list);
    setLoading(false);
  }, [loadList, restoreActive]);

  // Initial load + whenever the user switches.
  useEffect(() => {
    if (lastResolvedUserRef.current === currentUserGuid) return;
    lastResolvedUserRef.current = currentUserGuid;
    refresh();
  }, [currentUserGuid, refresh]);

  // Persist across sessions via user config. Optimistic: we update the
  // state immediately so the header chip animates on click, then save.
  const setActiveNamespace = useCallback(async (name) => {
    if (!name) return;
    setActiveNamespaceState(name);
    if (!currentUserGuid) return;
    try {
      await apiClient.updateUserConfig(currentUserGuid, { active_namespace: name });
    } catch (err) {
      // Non-fatal — user still sees the chip change; next reload
      // reverts to whatever's on disk.
      console.warn('Failed to persist active namespace:', err);
    }
  }, [currentUserGuid]);

  const getNamespace = useCallback((name) => {
    return namespaces.find((n) => n.name === name) || null;
  }, [namespaces]);

  const getNamespaceColor = useCallback((name) => {
    const ns = namespaces.find((n) => n.name === name);
    return ns?.color || '#6f6f6f';
  }, [namespaces]);

  const value = useMemo(() => ({
    namespaces,
    activeNamespace,
    setActiveNamespace,
    loading,
    error,
    refresh,
    getNamespace,
    getNamespaceColor,
  }), [namespaces, activeNamespace, setActiveNamespace, loading, error, refresh, getNamespace, getNamespaceColor]);

  return (
    <NamespaceContext.Provider value={value}>
      {children}
    </NamespaceContext.Provider>
  );
}

export function useNamespaces() {
  const ctx = useContext(NamespaceContext);
  if (!ctx) {
    // Permissive fallback so tests and isolated component renders don't
    // need a provider wrap.
    return {
      namespaces: [],
      activeNamespace: FALLBACK_NAMESPACE,
      setActiveNamespace: async () => {},
      loading: false,
      error: null,
      refresh: async () => {},
      getNamespace: () => null,
      getNamespaceColor: () => '#6f6f6f',
    };
  }
  return ctx;
}
