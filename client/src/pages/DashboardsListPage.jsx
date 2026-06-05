// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
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
  TableToolbar,
  TableToolbarContent,
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
  Dropdown
} from '@carbon/react';
import { TrashCan, Dashboard, List, Grid, Edit, DataBase, Download, Close, View, Reset } from '@carbon/icons-react';
import apiClient from '../api/client';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import DashboardTile from '../components/DashboardTile';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import DashboardExportModal from '../components/DashboardExportModal';
import DashboardImportModal from '../components/DashboardImportModal';
import './DashboardsListPage.scss';

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

  const [dashboards, setDashboards] = useState([]);
  const [charts, setCharts] = useState({});
  const [connections, setConnections] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
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
  // Single-select connection filter. 'all' = no filter; otherwise the
  // connection id we're matching against any panel's component refs.
  const [connectionFilter, setConnectionFilter] = useState(savedFilters.connection || 'all');
  // Export mode layers a selection UI on top of the table. When on:
  // the Create button hides, rows show a checkbox, and a batch-action
  // bar at the top of the list shows selection count + Export button.
  const [exportMode, setExportMode] = useState(false);
  const [selectedForExport, setSelectedForExport] = useState(new Set());
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);

  // Save filters to session store when they change
  useEffect(() => {
    setFilters('dashboards', {
      search: searchTerm,
      sortKey,
      sortDir: sortDirection,
      view: viewMode,
      tags: tagFilter,
      namespaces: namespaceFilter,
      connection: connectionFilter,
    });
    // View mode stays in listPrefs (it's UI-local, not shared with
    // View-mode). Sort moved to per-user server config so the two
    // pages stay in lockstep — persisted in persistSort below, not here.
    setListPrefs('dashboards', {
      view: viewMode,
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, tagFilter, namespaceFilter, connectionFilter]);

  // Fetch dashboards, charts, and connections from API
  useEffect(() => {
    fetchData();
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

  const fetchData = async () => {
    try {
      setLoading(true);
      // Fetch dashboards, charts, and connections in parallel (like DashboardTileViewPage)
      const [dashboardsRes, chartsRes, connectionsRes] = await Promise.all([
        apiClient.getDashboards({ page: 1, page_size: 100 }),
        apiClient.getComponents(),
        apiClient.getConnections()
      ]);

      if (dashboardsRes.dashboards) {
        setDashboards(dashboardsRes.dashboards);
      } else if (dashboardsRes.error) {
        setError(dashboardsRes.error);
      } else {
        setDashboards([]);
      }

      // Build component lookup (component_id -> chart)
      if (chartsRes.components) {
        const chartMap = {};
        chartsRes.components.forEach(chart => {
          chartMap[chart.id] = chart;
        });
        setCharts(chartMap);
      }

      // Build connection lookup (connection_id -> name)
      if (connectionsRes.connections) {
        const dsMap = {};
        connectionsRes.connections.forEach(ds => {
          dsMap[ds.id] = ds.name;
        });
        setConnections(dsMap);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchDashboards = () => fetchData();

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

  const handleDelete = async (e, dashboard) => {
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete "${dashboard.name}"?`)) {
      try {
        await apiClient.deleteDashboard(dashboard.id);
        fetchDashboards();
      } catch (err) {
        alert(`Error: ${err.message}`);
      }
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getPanelCount = (dashboard) => {
    // Column header already says "Panels" — return the bare count.
    return dashboard.panels?.length || 0;
  };

  // Build a multi-line label of the named components referenced by a
  // dashboard's panels, for the panel-count tooltip on the list view.
  // Panels without a component_id (text labels, spacers, etc.) are
  // omitted; panels referencing deleted components are surfaced
  // explicitly so the count stays honest.
  const getComponentNamesLabel = (dashboard) => {
    const panels = dashboard.panels || [];
    if (panels.length === 0) return 'No panels';
    const lines = panels
      .filter((panel) => panel.component_id)
      .map((panel) => {
        const c = charts[panel.component_id];
        if (!c) return '(missing component)';
        return c.title || c.name || '(unnamed)';
      });
    if (lines.length === 0) return 'No components';
    return lines.join('\n');
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

  // Helper to get connection names for search filtering (returns string for matching)
  const getConnectionNamesForSearch = (dashboard) => {
    if (!dashboard.panels || dashboard.panels.length === 0) return '';

    const dsNames = new Set();
    dashboard.panels.forEach(panel => {
      if (panel.component_id) {
        const chart = charts[panel.component_id];
        if (chart?.connection_id && connections[chart.connection_id]) {
          dsNames.add(connections[chart.connection_id]);
        }
      }
    });

    return Array.from(dsNames).join(' ');
  };

  // Filter and sort dashboards
  const filteredAndSortedDashboards = useMemo(() => {
    let result = [...dashboards];

    // Namespace filter: empty selection = no filter (show all). Records
    // missing a namespace (shouldn't happen post-migration, but
    // defensive) stay visible to avoid empty lists from bad data.
    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      result = result.filter((d) => !d.namespace || wanted.has(d.namespace));
    }

    // Filter by tags (OR semantics)
    if (tagFilter.length > 0) {
      result = result.filter(dashboard => {
        const dTags = dashboard.tags || [];
        return tagFilter.some(t => dTags.includes(t));
      });
    }

    // Filter by connection. A dashboard matches when any of its panels'
    // components reference the selected connection — through the top-level
    // connection_id (charts/controls) OR display_config.frigate_connection_id
    // / mqtt_connection_id (Frigate/weather displays). Mirrors the union we
    // do for the connection-usage count on the connections list page.
    if (connectionFilter !== 'all') {
      result = result.filter(dashboard => {
        if (!dashboard.panels || dashboard.panels.length === 0) return false;
        return dashboard.panels.some(panel => {
          if (!panel.component_id) return false;
          const c = charts[panel.component_id];
          if (!c) return false;
          if (c.connection_id === connectionFilter) return true;
          const dc = c.display_config;
          if (dc?.frigate_connection_id === connectionFilter) return true;
          if (dc?.mqtt_connection_id === connectionFilter) return true;
          return false;
        });
      });
    }

    // Filter by search term (matches name, description, or connection names)
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(dashboard => {
        // Check name and description
        if (dashboard.name?.toLowerCase().includes(term)) return true;
        if (dashboard.description?.toLowerCase().includes(term)) return true;

        // Check connection names (computed from charts)
        const dsNames = getConnectionNamesForSearch(dashboard);
        if (dsNames.toLowerCase().includes(term)) return true;

        return false;
      });
    }

    // Order resolution.
    //
    // Tile view: delegate to orderDashboardsForViewer so this page and
    // the View-mode tile page render dashboards in identical order
    // (including manual drag-reorder).
    //
    // List view: doesn't support a meaningful "manual" order in a
    // table — fall back to name asc when sortKey === 'manual'. The
    // shared setting itself stays as 'manual' (we don't write back);
    // switching to tile view restores the manual ordering.
    if (viewMode === 'tile') {
      return orderDashboardsForViewer(result, tileOrder, { key: sortKey, direction: sortDirection });
    }

    const effectiveKey = sortKey === 'manual' ? 'name' : sortKey;
    const effectiveDir = sortKey === 'manual' ? 'asc' : sortDirection;
    result.sort((a, b) => {
      let aVal = a[effectiveKey] || '';
      let bVal = b[effectiveKey] || '';

      // Handle date sorting
      if (effectiveKey === 'updated') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else if (effectiveKey === 'panels') {
        // Use panels array length directly (full dashboard object)
        aVal = a.panels?.length || 0;
        bVal = b.panels?.length || 0;
      } else {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return effectiveDir === 'asc' ? -1 : 1;
      if (aVal > bVal) return effectiveDir === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [dashboards, searchTerm, sortKey, sortDirection, viewMode, tileOrder, charts, connections, tagFilter, namespaceFilter, connectionFilter]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'tags', header: 'Tags', isSortable: false },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'panels', header: 'Panels', isSortable: true },
    { key: 'connections', header: 'Connections', isSortable: false },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  // Get unique data source names for a dashboard (computed client-side)
  const getConnectionNames = (dashboard) => {
    if (!dashboard.panels || dashboard.panels.length === 0) return '-';

    const dsNames = new Set();
    dashboard.panels.forEach(panel => {
      if (panel.component_id) {
        const chart = charts[panel.component_id];
        if (chart?.connection_id && connections[chart.connection_id]) {
          dsNames.add(connections[chart.connection_id]);
        }
      }
    });

    const namesArray = Array.from(dsNames);
    if (namesArray.length === 0) return '-';
    return namesArray.join(', ');
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

  if (loading) {
    return (
      <div className="dashboards-list-page">
        <Loading description="Loading dashboards..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
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
          <Dropdown
            id="connection-filter-dashboards"
            className="connection-filter-dropdown"
            label="Filter by connection"
            titleText=""
            items={[
              { id: 'all', text: 'All Connections' },
              ...Object.entries(connections).map(([id, name]) => ({ id, text: name }))
            ]}
            itemToString={(item) => item?.text || ''}
            selectedItem={{ id: connectionFilter, text: connectionFilter === 'all' ? 'All Connections' : (connections[connectionFilter] || 'Unknown') }}
            onChange={({ selectedItem }) => {
              setConnectionFilter(selectedItem?.id || 'all');
            }}
            size="md"
          />
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              tagFilter.length > 0 ||
              connectionFilter !== 'all'
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTagFilter([]);
              setConnectionFilter('all');
            }}
          />
          {viewMode === 'tile' && (
            <>
              <SortMenu
                sortKey={sortKey}
                sortDirection={sortDirection}
                onChange={(k, d) => persistSort(k, d)}
                options={[
                  { key: 'manual', label: 'Manual (drag to reorder)' },
                  { key: 'name', label: 'Name', defaultDir: 'asc' },
                  { key: 'updated', label: 'Last modified', defaultDir: 'desc' },
                  { key: 'namespace', label: 'Namespace', defaultDir: 'asc' },
                ]}
              />
              {sortKey === 'manual' && tileOrder && tileOrder.length > 0 && (
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
                // checkbox toggling).
                const isManual = sortKey === 'manual' && !exportMode;
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
                return (
                <DashboardTile
                  key={dashboard.id}
                  dashboard={dashboard}
                  componentMap={charts}
                  connectionMap={connections}
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
                            if (cell.info.header === 'tags') {
                              const cellTags = Array.isArray(cell.value) ? cell.value : [];
                              return (
                                <TableCell key={cell.id} className="tags-cell">
                                  {cellTags.map((t) => (
                                    <Tag
                                      key={t}
                                      type="cyan"
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
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'panels') {
                              return (
                                <TableCell key={cell.id} className="panels-cell">
                                  <Tooltip
                                    label={getComponentNamesLabel(dashboard)}
                                    align="bottom"
                                    enterDelayMs={150}
                                    className="tooltip-multiline"
                                  >
                                    <span tabIndex={0} className="panels-count">{cell.value}</span>
                                  </Tooltip>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id} className="actions-cell">
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
        onImported={() => fetchData()}
      />
    </div>
  );
}

export default DashboardsListPage;
