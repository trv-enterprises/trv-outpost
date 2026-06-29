// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

/**
 * ResourceNavigatorContext
 *
 * Holds the hierarchical-navigator modal's state OUTSIDE the route so it
 * survives open/close (and a tab reload) within a session. This is why a modal
 * + remembered state beats a stateful left-nav: the overlay is decoupled from
 * wherever the user navigated, so there's no "return to the nav you left."
 *
 * Persisted via sessionStorage:
 *   - rootDirection ('dashboard' | 'connection' | 'component')
 *   - showConnectionsUnderComponents (bool; dashboard-rooted noisy-toggle)
 *   - expandedIds (Set of path-unique tree-node ids)
 *   - selectedNode ({ kind, refId } | null)
 *   - scrollTop (left-pane scroll offset)
 * `open` is intentionally NOT persisted — a reload shouldn't reopen the modal.
 */

const STORAGE_KEY = 'resourceNavigator';

const DEFAULTS = {
  rootDirection: 'dashboard',
  showConnectionsUnderComponents: false,
  expandedIds: [],
  selectedNode: null,
  scrollTop: 0,
  search: '',
  filterNamespaces: [],
  filterTags: [],
};

function loadPersisted() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return {
      rootDirection: parsed.rootDirection || DEFAULTS.rootDirection,
      showConnectionsUnderComponents: !!parsed.showConnectionsUnderComponents,
      expandedIds: Array.isArray(parsed.expandedIds) ? parsed.expandedIds : [],
      selectedNode: parsed.selectedNode || null,
      scrollTop: parsed.scrollTop || 0,
      search: typeof parsed.search === 'string' ? parsed.search : '',
      filterNamespaces: Array.isArray(parsed.filterNamespaces) ? parsed.filterNamespaces : [],
      filterTags: Array.isArray(parsed.filterTags) ? parsed.filterTags : [],
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const ResourceNavigatorContext = createContext(null);

export function ResourceNavigatorProvider({ children }) {
  const initial = useRef(loadPersisted()).current;

  const [open, setOpen] = useState(false);
  const [rootDirection, setRootDirectionState] = useState(initial.rootDirection);
  const [showConnectionsUnderComponents, setShowConnsState] = useState(
    initial.showConnectionsUnderComponents
  );
  const [expandedIds, setExpandedIdsState] = useState(() => new Set(initial.expandedIds));
  const [selectedNode, setSelectedNodeState] = useState(initial.selectedNode);
  const [search, setSearchState] = useState(initial.search);
  const [filterNamespaces, setFilterNamespacesState] = useState(initial.filterNamespaces);
  const [filterTags, setFilterTagsState] = useState(initial.filterTags);
  const scrollTopRef = useRef(initial.scrollTop);

  // Write-through to sessionStorage. Reads current state from refs/args so we
  // never persist stale values.
  const persist = useCallback((patch) => {
    try {
      const current = loadPersisted();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...patch }));
    } catch {
      /* sessionStorage unavailable (private mode etc.) — non-fatal */
    }
  }, []);

  const openModal = useCallback(() => setOpen(true), []);
  const closeModal = useCallback(() => setOpen(false), []);

  const setRootDirection = useCallback(
    (dir) => {
      setRootDirectionState(dir);
      // Tag options are scoped to the root entity type, so a tag selected
      // under the previous root may not exist for the new one — clear it so
      // the new root isn't filtered down to nothing by a stale tag.
      setFilterTagsState([]);
      persist({ rootDirection: dir, filterTags: [] });
    },
    [persist]
  );

  const setShowConnectionsUnderComponents = useCallback(
    (val) => {
      setShowConnsState(val);
      persist({ showConnectionsUnderComponents: val });
    },
    [persist]
  );

  const toggleExpanded = useCallback(
    (id, isExpanded) => {
      setExpandedIdsState((prev) => {
        const next = new Set(prev);
        if (isExpanded) next.add(id);
        else next.delete(id);
        persist({ expandedIds: [...next] });
        return next;
      });
    },
    [persist]
  );

  const setSelectedNode = useCallback(
    (sel) => {
      setSelectedNodeState(sel);
      persist({ selectedNode: sel });
    },
    [persist]
  );

  const setScrollTop = useCallback(
    (top) => {
      scrollTopRef.current = top;
      persist({ scrollTop: top });
    },
    [persist]
  );

  const setSearch = useCallback(
    (val) => {
      setSearchState(val);
      persist({ search: val });
    },
    [persist]
  );

  const setFilterNamespaces = useCallback(
    (vals) => {
      setFilterNamespacesState(vals);
      persist({ filterNamespaces: vals });
    },
    [persist]
  );

  const setFilterTags = useCallback(
    (vals) => {
      setFilterTagsState(vals);
      persist({ filterTags: vals });
    },
    [persist]
  );

  const value = useMemo(
    () => ({
      open,
      openModal,
      closeModal,
      rootDirection,
      setRootDirection,
      showConnectionsUnderComponents,
      setShowConnectionsUnderComponents,
      expandedIds,
      toggleExpanded,
      selectedNode,
      setSelectedNode,
      scrollTopRef,
      setScrollTop,
      search,
      setSearch,
      filterNamespaces,
      setFilterNamespaces,
      filterTags,
      setFilterTags,
    }),
    [
      open,
      openModal,
      closeModal,
      rootDirection,
      setRootDirection,
      showConnectionsUnderComponents,
      setShowConnectionsUnderComponents,
      expandedIds,
      toggleExpanded,
      selectedNode,
      setSelectedNode,
      setScrollTop,
      search,
      setSearch,
      filterNamespaces,
      setFilterNamespaces,
      filterTags,
      setFilterTags,
    ]
  );

  return (
    <ResourceNavigatorContext.Provider value={value}>
      {children}
    </ResourceNavigatorContext.Provider>
  );
}

export function useResourceNavigator() {
  const ctx = useContext(ResourceNavigatorContext);
  if (!ctx) {
    throw new Error('useResourceNavigator must be used within a ResourceNavigatorProvider');
  }
  return ctx;
}
