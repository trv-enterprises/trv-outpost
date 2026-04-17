// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import apiClient from '../api/client';

const EnabledTypesContext = createContext(null);

/**
 * EnabledTypesProvider
 *
 * Loads the filtered registry catalog once on mount and exposes helpers for
 * the picker UIs (and AI preflight) to filter their type lists. Renderers
 * (ControlRenderer, FrigateCameraViewer, etc.) MUST NOT consult this context
 * — disabling a type only hides it from creation/AI surfaces; existing
 * dashboards keep rendering.
 *
 * Call refresh() after a settings save so pickers reflect the change without
 * a page reload.
 */
export function EnabledTypesProvider({ children }) {
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiClient.getRegistryCatalog();
      setCatalog(data || {});
      setError(null);
    } catch (err) {
      // Permissive fallback: empty catalog → every isXEnabled returns false,
      // which would empty every picker. Leave catalog null so the helpers can
      // detect the "still loading or failed" state and default to permissive
      // (let everything through).
      setCatalog(null);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Build sets of enabled IDs per category for O(1) lookups. When the catalog
  // hasn't loaded yet, helpers default to permissive (return true) so the UI
  // doesn't briefly hide everything during the initial fetch.
  const enabledSets = useMemo(() => {
    if (!catalog) return null;
    const toSet = (arr, key) => {
      const out = new Set();
      (arr || []).forEach((item) => {
        if (item && typeof item === 'object') {
          const value = item[key];
          if (value) out.add(value);
        }
      });
      return out;
    };
    return {
      integrations: toSet(catalog.integrations, 'id'),
      connections:  toSet(catalog.connection_types, 'type_id'),
      charts:       toSet(catalog.chart_types, 'subtype'),
      controls:     toSet(catalog.control_types, 'subtype'),
      displays:     toSet(catalog.display_types, 'subtype'),
    };
  }, [catalog]);

  const value = useMemo(() => {
    const permissive = enabledSets === null;

    const make = (set) => (id) => {
      if (permissive) return true;
      if (!id) return true;
      return set.has(id);
    };

    return {
      loading,
      error,
      catalog,
      refresh: load,
      isIntegrationEnabled: permissive ? () => true : (id) => !id || enabledSets.integrations.has(id),
      isConnectionTypeEnabled: permissive ? () => true : make(enabledSets.connections),
      isChartTypeEnabled: permissive ? () => true : make(enabledSets.charts),
      isControlTypeEnabled: permissive ? () => true : make(enabledSets.controls),
      isDisplayTypeEnabled: permissive ? () => true : make(enabledSets.displays),
      // Convenience arrays for pickers that want to enumerate the enabled
      // types directly (e.g., ConnectionsPage tile view).
      enabledIntegrations: catalog?.integrations || [],
      enabledConnectionTypes: catalog?.connection_types || [],
      enabledChartTypes: catalog?.chart_types || [],
      enabledControlTypes: catalog?.control_types || [],
      enabledDisplayTypes: catalog?.display_types || [],
    };
  }, [catalog, enabledSets, error, load, loading]);

  return (
    <EnabledTypesContext.Provider value={value}>
      {children}
    </EnabledTypesContext.Provider>
  );
}

export function useEnabledTypes() {
  const context = useContext(EnabledTypesContext);
  if (!context) {
    // Returning permissive helpers when used outside the provider keeps
    // tests and isolated component renders working without a provider wrap.
    return {
      loading: false,
      error: null,
      catalog: null,
      refresh: async () => {},
      isIntegrationEnabled: () => true,
      isConnectionTypeEnabled: () => true,
      isChartTypeEnabled: () => true,
      isControlTypeEnabled: () => true,
      isDisplayTypeEnabled: () => true,
      enabledIntegrations: [],
      enabledConnectionTypes: [],
      enabledChartTypes: [],
      enabledControlTypes: [],
      enabledDisplayTypes: [],
    };
  }
  return context;
}
