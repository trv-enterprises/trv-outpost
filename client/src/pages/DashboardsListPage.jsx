// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { getFilters, setFilters } from '../utils/filterStore';
import { getListPrefs, setListPrefs } from '../utils/listPrefs';
import {
  DataTable,
  TableContainer,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  TableToolbarSearch,
  Button,
  IconButton,
  Loading,
  Link,
  ContentSwitcher,
  Switch,
  Tag,
  Tooltip,
  Checkbox,
  OverflowMenu,
  OverflowMenuItem,
  Pagination
} from '@carbon/react';
import { TrashCan, Dashboard, List, Grid, Edit, Download, Close, View, Reset, OverflowMenuVertical, Checkmark } from '@carbon/icons-react';
import apiClient from '../api/client';
import usePaginatedList from '../hooks/usePaginatedList';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import CountListPopover from '../components/shared/CountListPopover';
import VariableIndicator from '../components/shared/VariableIndicator';
import { dashboardUsesVariable } from '../utils/dashboardVariable';
import DashboardTile from '../components/DashboardTile';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import DashboardExportModal from '../components/DashboardExportModal';
import DashboardImportModal from '../components/DashboardImportModal';
import DashboardDeleteModal from '../components/DashboardDeleteModal';
import '../components/shared/FilterOverflowMenu.scss';
import './DashboardsListPage.scss';

const PAGE_SIZES = [25, 50, 100];

/**
 * DashboardsListPage Component
 *
 * Displays list of all dashboards with IBM Cloud-style design:
 * - Page header with title and description
 * - Search bar with filtering
 * - Sortable columns
 * - Click on row to edit, trash icon to delete
 */
function DashboardsListPage() {
  const navigate = useNavigate();

  // Merge persisted per-user prefs (survives reload) with session filters (takes precedence)
  const savedFilters = { ...getListPrefs('dashboards'), ...getFilters('dashboards') };

  // Delete confirmation — DashboardDeleteModal (Carbon danger modal + orphaned-
  // component cascade). Replaces the old window.confirm (#64) and adds #65.
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [reloadTick, setReloadTick] = useState(0); // bump to refetch after delete/import
  const [searchTerm, setSearchTerm] = useState(savedFilters.search || '');
  // Sort state. Authoritative storage is per-user server config
  // (`dashboard_tile_sort`), shared with the View-mode tile page so a
  // user sees the same ordering everywhere. listPrefs is a fallback
  // until the user-config fetch completes — keeps first-paint stable.
  const [sortKey, setSortKey] = useState(savedFilters.sortKey || 'updated');
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
  // Manual drag-reorder state. Same per-user `dashboard_tile_order`
  // key as View-mode — the order travels with the user, not with the
  // mode.
  //   null  → not yet loaded from server (treat like empty)
  //   []    → user has no manual order yet
  //   [...] → user's pinned sequence; partial coverage is fine
  const [tileOrder, setTileOrder] = useState(null);
  const dragSrcIdRef = useRef(null);
  // {id, side: 'left'|'right'} — which tile we're hovering over and
  // which half. Drop inserts the dragged tile before (left) or after
  // (right) the target. Tracked together so the indicator can render
  // on the correct edge.
  const [dragOver, setDragOver] = useState(null);
  // Suppress the synthetic click some browsers fire on a tile right
  // after it's been dropped. Same tile-scoped, time-bounded pattern as
  // DashboardTileViewPage — a bare boolean was too sticky.
  const droppedRef = useRef({ id: null, expiresAt: 0 });
  const [viewMode, setViewMode] = useState(savedFilters.view || 'list'); // 'list' or 'tile'
  const [tagFilter, setTagFilter] = useState(savedFilters.tags || []); // array of tag names
  // Multi-select namespace filter. Empty array = show all (the user
  // hasn't filtered). Independent from the header's active namespace,
  // so users can peek at other namespaces without changing where new
  // records land.
  const [namespaceFilter, setNamespaceFilter] = useState(savedFilters.namespaces || []);
  // Variable-driven only: when on, keep only dashboards that define and
  // enable dashboard variables (settings.variables_enabled + variables[],
  // via dashboardUsesVariable). Lives in the ⋮ filter overflow.
  // #21: client-only post-filter on the loaded page — the dashboards API has
  // no variable-driven server field. Variables are rare, so filtering only the
  // current page is acceptable.
  const [variableOnly, setVariableOnly] = useState(savedFilters.variableOnly || false);
  // Export mode layers a selection UI on top of the table. When on:
  // the Create button hides, rows show a checkbox, and a batch-action
  // bar at the top of the list shows selection count + Export button.
  const [exportMode, setExportMode] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState(new Set());
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Server-side filter/sort/pagination (#21). Rows are DashboardSummary
  // objects (include_connections:true) — each carries `connection_names`
  // ([string]) + `panel_count` instead of the full `panels` array. 'manual'
  // sort isn't a server field; send 'updated' to the server and re-apply the
  // manual ordering client-side within the current page (see notes below).
  const serverSortKey = sortKey === 'manual' ? 'updated' : sortKey;
  const serverSortDir = sortKey === 'manual' ? 'desc' : sortDirection;
  const {
    rows: dashboards,
    total,
    loading,
    hasLoadedOnce,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaginatedList({
    fetcher: (q) => apiClient.getDashboards(q),
    extract: (resp) => ({ rows: resp?.dashboards || [], total: resp?.total || 0, hasMore: resp?.has_more }),
    filters: {
      include_connections: true,
      namespace: namespaceFilter,
      tags: tagFilter,
    },
    sortKey: serverSortKey,
    sortDir: serverSortDir,
    initialPageSize: savedFilters.pageSize || 25,
    search: searchTerm,
    searchKey: 'name',
    reloadTick,
  });

  const refetch = useCallback(() => setReloadTick((t) => t + 1), []);

  // Save filters to session store when they change
  useEffect(() => {
    setFilters('dashboards', {
      search: searchTerm,
      sortKey,
      sortDir: sortDirection,
      view: viewMode,
      tags: tagFilter,
      namespaces: namespaceFilter,
      variableOnly,
    });
    // View mode stays in listPrefs (it's UI-local, not shared with
    // View-mode). Sort moved to per-user server config so the two
    // pages stay in lockstep — persisted in persistSort below, not here.
    setListPrefs('dashboards', {
      view: viewMode,
      pageSize,
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, tagFilter, namespaceFilter, variableOnly, pageSize]);

  // Load the shared per-user sort + manual order from server config.
  useEffect(() => {
    fetchUserConfig();
  }, []);

  // Load the shared per-user sort + manual order from server config.
  // Mirrors DashboardTileViewPage so both pages converge on the same
  // ordering and the user only sees one source of truth.
  const fetchUserConfig = async () => {
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    try {
      const config = await apiClient.getUserConfig(userGuid);
      const settings = config?.settings || {};
      const stored = settings.dashboard_tile_order;
      setTileOrder(Array.isArray(stored) ? stored : []);
      const storedSort = settings.dashboard_tile_sort;
      if (storedSort && typeof storedSort.key === 'string') {
        setSortKey(storedSort.key);
        setSortDirection(storedSort.direction === 'desc' ? 'desc' : 'asc');
      }
    } catch {
      // No user config yet (new user, first load). Treat as empty manual
      // order; the local `savedFilters` fallback for sort already applied.
      setTileOrder([]);
    }
  };

  // Persist sort preference to user config so both Design and View
  // see the same setting. Local state updates immediately; server
  // call is fire-and-forget — UI shouldn't wait on it.
  const persistSort = useCallback((nextKey, nextDirection) => {
    setSortKey(nextKey);
    setSortDirection(nextDirection);
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    apiClient.updateUserConfig(userGuid, {
      dashboard_tile_sort: { key: nextKey, direction: nextDirection },
    }).catch(() => {});
  }, []);

  // Persist the manual tile order to user config.
  const persistTileOrder = useCallback((nextOrder) => {
    setTileOrder(nextOrder);
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    apiClient.updateUserConfig(userGuid, {
      dashboard_tile_order: nextOrder,
    }).catch(() => {});
  }, []);

  const handleResetOrder = () => {
    persistTileOrder([]);
  };

  // Native HTML5 drag-and-drop. Same pattern as the View-mode tile
  // page — whole-tile drag, drop computes left/right half via midpoint
  // for the indicator, droppedRef suppresses the synthetic click on
  // the dropped tile.
  const handleDragStart = (e, dashboardId) => {
    dragSrcIdRef.current = dashboardId;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dashboardId); } catch { /* no-op */ }
  };

  const handleDragOver = (e, overId) => {
    if (!dragSrcIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const side = (e.clientX - rect.left) < (rect.width / 2) ? 'left' : 'right';
    if (!dragOver || dragOver.id !== overId || dragOver.side !== side) {
      setDragOver({ id: overId, side });
    }
  };

  const handleDragLeave = () => setDragOver(null);

  const handleDrop = (e, dropTargetId) => {
    e.preventDefault();
    const srcId = dragSrcIdRef.current;
    const side = dragOver?.id === dropTargetId ? dragOver.side : 'left';
    dragSrcIdRef.current = null;
    setDragOver(null);
    if (!srcId || srcId === dropTargetId) return;
    // Compute the new order from the *currently rendered* sequence,
    // remove src, re-insert relative to the drop target. The off-by-
    // one is already handled because targetIdx is computed AFTER
    // filtering srcId out; only +1 for the right half.
    const currentOrder = filteredAndSortedDashboards.map(d => d.id);
    const without = currentOrder.filter(id => id !== srcId);
    const targetIdx = without.indexOf(dropTargetId);
    if (targetIdx < 0) return;
    const insertAt = side === 'left' ? targetIdx : targetIdx + 1;
    const next = [...without.slice(0, insertAt), srcId, ...without.slice(insertAt)];
    persistTileOrder(next);
    droppedRef.current = { id: srcId, expiresAt: Date.now() + 250 };
  };

  const handleDragEnd = () => {
    dragSrcIdRef.current = null;
    setDragOver(null);
  };

  const handleCreate = () => {
    navigate('/design/dashboards/new');
  };

  const handleRowClick = (dashboard) => {
    navigate(`/design/dashboards/${dashboard.id}`);
  };

  // "View this dashboard" — skip the edit flow and drop straight into
  // the read-only viewer. `fromDesign: true` tells the viewer we came
  // from the design list, which suppresses prev/next/home nav and
  // routes the back-arrow back here rather than into /view mode.
  const handleView = (e, dashboard) => {
    e.stopPropagation();
    navigate(`/view/dashboards/${dashboard.id}`, { state: { fromDesign: true } });
  };

  const handleDelete = (e, dashboard) => {
    e.stopPropagation();
    setDeleteTarget(dashboard);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getPanelCount = (dashboard) => {
    // Summary rows carry panel_count instead of a full panels array.
    return dashboard.panel_count || 0;
  };

  // Handle column sorting. Goes through persistSort so the choice
  // syncs to user config and surfaces in View-mode too.
  const handleSort = (key) => {
    if (sortKey === key) {
      persistSort(key, sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      persistSort(key, 'asc');
    }
  };

  // Manual drag-reorder is only safe within a single page — it can't
  // re-order rows that live on other pages. Disable it (and the Reset
  // button) whenever the dataset spans more than one page.
  const isPaginated = total > pageSize;

  // Apply the remaining CLIENT-ONLY transforms on top of the server-paged
  // page (#21). Filtering/sorting/search/namespace/tags already happened
  // server-side; what's left has no server equivalent:
  //   - variableOnly: post-filter on the loaded page (variables are rare).
  //   - manual tile order: re-sequence the current page only.
  const filteredAndSortedDashboards = useMemo(() => {
    let result = [...dashboards];

    // #21: client-only post-filter on the loaded page — no server field for
    // variable-driven dashboards. Summary rows include `settings`, so
    // dashboardUsesVariable still works.
    if (variableOnly) {
      result = result.filter((d) => dashboardUsesVariable(d));
    }

    // Order resolution.
    //
    // Tile view: delegate to orderDashboardsForViewer so this page and the
    // View-mode tile page render dashboards in identical order (including
    // manual drag-reorder). #21: manual ordering only re-sequences the
    // current page — it cannot move rows across page boundaries.
    //
    // List view: server order is already applied; manual sort falls back to
    // the server's default (updated desc) ordering, so just return as-is.
    if (viewMode === 'tile') {
      return orderDashboardsForViewer(result, tileOrder, { key: sortKey, direction: sortDirection });
    }

    return result;
  }, [dashboards, sortKey, sortDirection, viewMode, tileOrder, variableOnly]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    // (tags now render under the name in the name cell — no separate column)
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'description', header: 'Description', isSortable: false },
    // 'panels' is not a server sort field (only name/updated/created/namespace
    // are) — marked non-sortable (#21).
    { key: 'panels', header: 'Components', isSortable: false },
    { key: 'connections', header: 'Connections', isSortable: false },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  // Summary rows carry connection_names ([string]) directly — no client-side
  // panel walk needed.
  const getConnectionNames = (dashboard) => {
    const names = dashboard.connection_names || [];
    return names.length === 0 ? '-' : names.join(', ');
  };

  const rows = filteredAndSortedDashboards.map((dashboard) => ({
    id: dashboard.id,
    name: dashboard.name,
    namespace: dashboard.namespace || 'default',
    description: dashboard.description || '',
    panels: getPanelCount(dashboard),
    connections: getConnectionNames(dashboard),
    tags: dashboard.tags || [],
    updated: formatDate(dashboard.updated)
  }));

  const getDashboardById = (id) => dashboards.find(d => d.id === id);

  // Full-page spinner only on the first load; later refetches keep the page
  // mounted so filtering/paging updates just the table (#21).
  if (loading && dashboards.length === 0 && !hasLoadedOnce) {
    return (
      <div className="dashboards-list-page">
        <Loading description="Loading dashboards..." withOverlay={false} />
      </div>
    );
  }

  if (error && dashboards.length === 0) {
    return (
      <div className="dashboards-list-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="dashboards-list-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Dashboards</h1>
        <p className="page-description">
          Create and manage dashboards that combine layouts with charts and data visualizations.
          Dashboards can be viewed in real-time with auto-refresh capabilities.
          {' '}<Link href="/docs/dashboard-editor" target="_blank" rel="noopener noreferrer">Learn more</Link>.
        </p>
      </div>

      {/* Toolbar */}
      <div className="page-toolbar">
        <div className="toolbar-left">
          <TableToolbarSearch
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search"
            persistent
            value={searchTerm}
          />
          <NamespaceFilter
            id="namespace-filter-dashboards"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <TagFilter
            entityType="dashboards"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          {/* #21: the "filter by connection" dropdown was dropped. It was a
              client-side walk over each dashboard's panels/components, which
              the summary list no longer carries, and the dashboards API has no
              connection-id filter (only component_id). Follow-up: add a
              connection→component_id resolution server-side if needed. */}
          {/* Overflow (⋮) menu for facet toggles — mirrors the components
              list/picker. Holds "Variable dashboards only". Sits BEFORE the
              reset button so reset stays the rightmost filter control. */}
          <OverflowMenu
            renderIcon={() => <OverflowMenuVertical size={20} />}
            flipped
            direction="bottom"
            align="bottom-end"
            iconDescription="Filter options"
            menuOptionsClass="filter-overflow-options"
            className={`filter-overflow-trigger${variableOnly ? ' filter-overflow-trigger--active' : ''}`}
          >
            <OverflowMenuItem
              itemText={
                <span className="filter-overflow-item">
                  {variableOnly
                    ? <Checkmark size={16} />
                    : <span style={{ width: 16, display: 'inline-block' }} />}
                  <span>Variable dashboards only</span>
                </span>
              }
              onClick={() => setVariableOnly((v) => !v)}
            />
          </OverflowMenu>
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              tagFilter.length > 0 ||
              variableOnly
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTagFilter([]);
              setVariableOnly(false);
            }}
          />
          {viewMode === 'tile' && (
            <>
              <SortMenu
                sortKey={sortKey}
                sortDirection={sortDirection}
                onChange={(k, d) => persistSort(k, d)}
                options={[
                  // #21: manual drag-reorder only re-sequences the current
                  // page; hide it once the dataset spans multiple pages so
                  // users don't get a partial-reorder surprise.
                  ...(isPaginated ? [] : [{ key: 'manual', label: 'Manual (drag to reorder)' }]),
                  { key: 'name', label: 'Name', defaultDir: 'asc' },
                  { key: 'updated', label: 'Last modified', defaultDir: 'desc' },
                  { key: 'namespace', label: 'Namespace', defaultDir: 'asc' },
                ]}
              />
              {sortKey === 'manual' && !isPaginated && tileOrder && tileOrder.length > 0 && (
                <Button
                  kind="ghost"
                  size="sm"
                  renderIcon={Reset}
                  onClick={handleResetOrder}
                  title="Discard your manual tile order and revert to most-recently-updated first"
                >
                  Reset manual order
                </Button>
              )}
            </>
          )}
          <ContentSwitcher
            onChange={(e) => setViewMode(e.name)}
            selectedIndex={viewMode === 'list' ? 0 : 1}
            size="md"
          >
            <Switch name="list">
              <List size={16} />
            </Switch>
            <Switch name="tile">
              <Grid size={16} />
            </Switch>
          </ContentSwitcher>
        </div>
        <div className="toolbar-actions">
          {!exportMode && (
            <>
              <Button
                onClick={() => setImportModalOpen(true)}
                size="md"
                kind="tertiary"
              >
                Import
              </Button>
              <Tooltip
                label="Export selected dashboards and their related components and connections"
                align="bottom"
              >
                <Button
                  onClick={() => { setExportMode(true); setSelectedForExport(new Set()); }}
                  size="md"
                  kind="tertiary"
                  renderIcon={Download}
                >
                  Export
                </Button>
              </Tooltip>
              <Button
                onClick={handleCreate}
                size="md"
                kind="primary"
              >
                Create
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Export mode bulk-action bar */}
      {exportMode && (
        <div className="export-mode-bar">
          <div className="export-mode-bar__count">
            {selectedForExport.size} selected
          </div>
          <div className="export-mode-bar__actions">
            <Button
              kind="ghost"
              size="sm"
              renderIcon={Close}
              onClick={() => { setExportMode(false); setSelectedForExport(new Set()); }}
            >
              Cancel
            </Button>
            <Button
              kind="primary"
              size="sm"
              renderIcon={Download}
              disabled={selectedForExport.size === 0}
              onClick={() => setExportModalOpen(true)}
            >
              Export ({selectedForExport.size})
            </Button>
          </div>
        </div>
      )}

      {/* Tile View */}
      {viewMode === 'tile' && (
        <div className="dashboards-content">
          {filteredAndSortedDashboards.length === 0 ? (
            <div className="empty-state">
              <Dashboard size={64} />
              <h3>No dashboards available</h3>
              <p>
                Looks like you haven't added any dashboards. Click{' '}
                <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                {' '}to get started.
              </p>
            </div>
          ) : (
            <div className="dashboards-grid">
              {filteredAndSortedDashboards.map((dashboard) => {
                const isTileSelected = exportMode && selectedForExport.has(dashboard.id);
                const toggleTileSelection = () => {
                  setSelectedForExport((prev) => {
                    const next = new Set(prev);
                    if (next.has(dashboard.id)) next.delete(dashboard.id); else next.add(dashboard.id);
                    return next;
                  });
                };
                // Drag-reorder is only meaningful in manual sort and
                // out of export mode (export mode owns the click for
                // checkbox toggling). #21: disabled while paginated — a
                // drag can't move rows onto another page.
                const isManual = sortKey === 'manual' && !exportMode && !isPaginated;
                const dropSide = dragOver?.id === dashboard.id ? dragOver.side : null;
                const handleTileClickGuarded = () => {
                  // Swallow the synthetic click that fires immediately
                  // after a drop on the source tile. Scope is tight:
                  // only THIS tile, only for ~250ms after the drop.
                  if (droppedRef.current.id === dashboard.id && Date.now() < droppedRef.current.expiresAt) {
                    droppedRef.current = { id: null, expiresAt: 0 };
                    return;
                  }
                  if (exportMode) {
                    toggleTileSelection();
                  } else {
                    handleRowClick(dashboard);
                  }
                };
                // #21: feed the tile pre-computed comps/conns from the
                // summary's denormalized {id,name} fields — both navigable.
                const tileComponentItems = (dashboard.component_usage || []).map((c) => ({ id: c.id, label: c.name }));
                const tileConnectionItems = (dashboard.connection_usage || []).map((c) => ({ id: c.id, label: c.name }));
                return (
                <DashboardTile
                  key={dashboard.id}
                  dashboard={dashboard}
                  componentItems={tileComponentItems}
                  connectionItems={tileConnectionItems}
                  onComponentClick={(item) => navigate(`/design/components/${item.id}`)}
                  onConnectionClick={(item) => navigate(`/design/connections/${item.id}`)}
                  selected={isTileSelected}
                  onClick={handleTileClickGuarded}
                  draggable={isManual}
                  onDragStart={isManual ? (e) => handleDragStart(e, dashboard.id) : undefined}
                  onDragOver={isManual ? (e) => handleDragOver(e, dashboard.id) : undefined}
                  onDragLeave={isManual ? handleDragLeave : undefined}
                  onDrop={isManual ? (e) => handleDrop(e, dashboard.id) : undefined}
                  onDragEnd={isManual ? handleDragEnd : undefined}
                  dropSide={dropSide}
                  showDate
                  descriptionMode="inline"
                  onTagClick={(t) => {
                    if (!tagFilter.includes(t)) setTagFilter([...tagFilter, t]);
                  }}
                  badge={exportMode ? (
                    <div onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        id={`export-tile-${dashboard.id}`}
                        labelText=""
                        checked={isTileSelected}
                        onChange={toggleTileSelection}
                      />
                    </div>
                  ) : null}
                  actions={exportMode ? null : (
                    <>
                      <IconButton
                        kind="ghost"
                        label="View"
                        onClick={(e) => handleView(e, dashboard)}
                        size="sm"
                      >
                        <View size={16} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        label="Edit"
                        onClick={(e) => { e.stopPropagation(); handleRowClick(dashboard); }}
                        size="sm"
                      >
                        <Edit size={16} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        label="Delete"
                        onClick={(e) => handleDelete(e, dashboard)}
                        size="sm"
                      >
                        <TrashCan size={16} />
                      </IconButton>
                    </>
                  )}
                />
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* List View (DataTable) */}
      {viewMode === 'list' && (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows, headers, getTableProps, getHeaderProps, getRowProps }) => (
            <TableContainer>
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {exportMode && (
                      <TableHeader className="export-select-cell" onClick={(e) => e.stopPropagation()}>
                        {/* Header intentionally blank — clicking the body
                            row toggles selection; a header-level select-all
                            would be useful later but isn't part of v1. */}
                      </TableHeader>
                    )}
                    {headers.map((header) => {
                      if (exportMode && header.key === 'actions') return null;
                      return (
                        <TableHeader
                          {...getHeaderProps({ header })}
                          key={header.key}
                          isSortable={header.isSortable}
                          isSortHeader={sortKey === header.key}
                          sortDirection={sortKey === header.key ? sortDirection.toUpperCase() : 'NONE'}
                          onClick={() => header.isSortable && handleSort(header.key)}
                        >
                          {header.header}
                        </TableHeader>
                      );
                    })}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={headers.length}>
                        <div className="empty-state">
                          <Dashboard size={64} />
                          <h3>No dashboards available</h3>
                          <p>
                            Looks like you haven't added any dashboards. Click{' '}
                            <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                            {' '}to get started.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const dashboard = getDashboardById(row.id);
                      if (!dashboard) return null; // guard transient refetch row/lookup mismatch
                      const isSelected = selectedForExport.has(row.id);
                      const toggleSelection = () => {
                        setSelectedForExport((prev) => {
                          const next = new Set(prev);
                          if (next.has(row.id)) next.delete(row.id); else next.add(row.id);
                          return next;
                        });
                      };
                      return (
                        <TableRow
                          {...getRowProps({ row })}
                          key={row.id}
                          onClick={() => exportMode ? toggleSelection() : handleRowClick(dashboard)}
                          className={`clickable-row ${exportMode && isSelected ? 'is-selected' : ''}`}
                        >
                          {exportMode && (
                            <TableCell className="export-select-cell" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                id={`export-select-${row.id}`}
                                labelText=""
                                checked={isSelected}
                                onChange={toggleSelection}
                              />
                            </TableCell>
                          )}
                          {row.cells.map((cell) => {
                            if (exportMode && cell.info.header === 'actions') {
                              return null; // Hide action column in export mode
                            }
                            if (cell.info.header === 'namespace') {
                              return (
                                <TableCell key={cell.id} className="namespace-cell">
                                  <NamespaceChip name={cell.value} />
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'panels') {
                              // #21: the dashboard summary now carries
                              // component_usage [{id,name}] (server-side
                              // denormalized), so the navigable "Components"
                              // popover is restored — click a component to jump
                              // to its editor.
                              const compItems = (dashboard.component_usage || []).map((c) => ({ id: c.id, label: c.name }));
                              return (
                                <TableCell key={cell.id} className="panels-cell" onClick={(e) => e.stopPropagation()}>
                                  <CountListPopover
                                    count={cell.value}
                                    className="panels-count"
                                    heading="Components"
                                    items={compItems}
                                    emptyLabel="No components on this dashboard"
                                    onItemClick={(item) => navigate(`/design/components/${item.id}`)}
                                  />
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id} className="actions-cell">
                                  <div className="actions-wrapper">
                                    <IconButton
                                      kind="ghost"
                                      label="View"
                                      onClick={(e) => handleView(e, dashboard)}
                                      size="sm"
                                    >
                                      <View size={16} />
                                    </IconButton>
                                    <IconButton
                                      kind="ghost"
                                      label="Delete"
                                      onClick={(e) => handleDelete(e, dashboard)}
                                      size="sm"
                                    >
                                      <TrashCan size={16} />
                                    </IconButton>
                                  </div>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'name') {
                              const dashTags = dashboard.tags || [];
                              return (
                                <TableCell key={cell.id} className="name-cell">
                                  <div className="name-cell__name">
                                    <span>{cell.value}</span>
                                    <VariableIndicator active={dashboardUsesVariable(dashboard)} />
                                  </div>
                                  {dashTags.length > 0 && (
                                    <div className="name-cell__tags">
                                      {dashTags.map((t) => (
                                        <Tag
                                          key={t}
                                          type="blue"
                                          size="sm"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            if (!tagFilter.includes(t)) setTagFilter([...tagFilter, t]);
                                          }}
                                          title={`Filter by ${t}`}
                                          style={{ cursor: 'pointer' }}
                                        >
                                          {t}
                                        </Tag>
                                      ))}
                                    </div>
                                  )}
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'connections') {
                              // #21: the summary now carries connection_usage
                              // [{id,name}] (server-side denormalized), so the
                              // connections render as navigable comma-separated
                              // links to each connection's editor — same as
                              // before pagination.
                              const connItems = dashboard.connection_usage || [];
                              return (
                                <TableCell key={cell.id} className="connections-cell" onClick={(e) => e.stopPropagation()}>
                                  {connItems.length === 0 ? '-' : connItems.map((c, i) => (
                                    <Fragment key={c.id}>
                                      <Link
                                        href={`/design/connections/${c.id}`}
                                        onClick={(e) => { e.preventDefault(); navigate(`/design/connections/${c.id}`); }}
                                      >
                                        {c.name}
                                      </Link>
                                      {i < connItems.length - 1 ? <span>, </span> : null}
                                    </Fragment>
                                  ))}
                                </TableCell>
                              );
                            }
                            return <TableCell key={cell.id}>{cell.value}</TableCell>;
                          })}
                        </TableRow>
                      );
                    })
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </DataTable>
      )}

      <DashboardExportModal
        open={exportModalOpen}
        onClose={() => {
          setExportModalOpen(false);
          // If the modal closed after a successful download, drop out of
          // export mode so the UI returns to its normal state.
          setExportMode(false);
          setSelectedForExport(new Set());
        }}
        dashboardIds={Array.from(selectedForExport)}
        dashboards={dashboards}
      />
      <DashboardImportModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImported={refetch}
      />

      {/* Delete confirmation + orphaned-component cascade (#64, #65) */}
      <DashboardDeleteModal
        dashboard={deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onDeleted={refetch}
      />

      {/* Server-side pagination (#21) — shared across both views. */}
      <Pagination
        className="list-pagination"
        page={page}
        pageSize={pageSize}
        pageSizes={PAGE_SIZES}
        totalItems={total}
        onChange={({ page: p, pageSize: ps }) => {
          if (ps !== pageSize) setPageSize(ps);
          setPage(p);
        }}
      />
    </div>
  );
}

export default DashboardsListPage;
