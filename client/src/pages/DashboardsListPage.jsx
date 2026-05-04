// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
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
  Tile,
  ContentSwitcher,
  Switch,
  Tag,
  Tooltip,
  Checkbox,
  Dropdown
} from '@carbon/react';
import { TrashCan, Dashboard, List, Grid, Edit, DataBase, Information, ChartMultitype, Download, Close, View } from '@carbon/icons-react';
import apiClient from '../api/client';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
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
  const [sortKey, setSortKey] = useState(savedFilters.sortKey || 'updated');
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
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
    // Persist user-level preferences (view mode, sort) to user config — survives reloads
    setListPrefs('dashboards', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, tagFilter, namespaceFilter, connectionFilter]);

  // Fetch dashboards, charts, and connections from API
  useEffect(() => {
    fetchData();
  }, []);

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
  // Empty panels (no component_id) and panels referencing deleted
  // components are surfaced explicitly so the count stays honest.
  const getComponentNamesLabel = (dashboard) => {
    const panels = dashboard.panels || [];
    if (panels.length === 0) return 'No panels';
    const lines = panels.map((panel) => {
      if (!panel.component_id) return '(empty panel)';
      const c = charts[panel.component_id];
      if (!c) return '(missing component)';
      return c.title || c.name || '(unnamed)';
    });
    return lines.join('\n');
  };

  // Handle column sorting
  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
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

    // Sort
    result.sort((a, b) => {
      let aVal = a[sortKey] || '';
      let bVal = b[sortKey] || '';

      // Handle date sorting
      if (sortKey === 'updated') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else if (sortKey === 'panels') {
        // Use panels array length directly (full dashboard object)
        aVal = a.panels?.length || 0;
        bVal = b.panels?.length || 0;
      } else {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [dashboards, searchTerm, sortKey, sortDirection, charts, connections, tagFilter, namespaceFilter, connectionFilter]);

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
          {' '}<Link href="#" onClick={(e) => e.preventDefault()}>Learn more</Link>.
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
            <SortMenu
              sortKey={sortKey}
              sortDirection={sortDirection}
              onChange={(k, d) => { setSortKey(k); setSortDirection(d); }}
              options={[
                { key: 'name', label: 'Name', defaultDir: 'asc' },
                { key: 'updated', label: 'Last modified', defaultDir: 'desc' },
                { key: 'namespace', label: 'Namespace', defaultDir: 'asc' },
              ]}
            />
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
                return (
                <Tile
                  key={dashboard.id}
                  className={`dashboard-tile ${isTileSelected ? 'is-selected' : ''}`}
                  onClick={() => exportMode ? toggleTileSelection() : handleRowClick(dashboard)}
                >
                  {exportMode && (
                    <div
                      className="tile-export-checkbox"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <Checkbox
                        id={`export-tile-${dashboard.id}`}
                        labelText=""
                        checked={isTileSelected}
                        onChange={toggleTileSelection}
                      />
                    </div>
                  )}
                  {/* Thumbnail */}
                  <div className="tile-thumbnail">
                    {dashboard.thumbnail ? (
                      <img src={dashboard.thumbnail} alt={dashboard.name} />
                    ) : (
                      <div className="tile-thumbnail-placeholder">
                        <ChartMultitype size={48} />
                      </div>
                    )}
                  </div>

                  {/* Content */}
                  <div className="tile-content">
                    <div className="tile-header">
                      <h3>{dashboard.name}</h3>
                      {dashboard.description && (
                        <Tooltip label={dashboard.description} align="bottom">
                          <button type="button" className="info-button" onClick={(e) => e.stopPropagation()}>
                            <Information size={16} />
                          </button>
                        </Tooltip>
                      )}
                    </div>

                    <div className="tile-meta">
                      <Tooltip
                        label={getComponentNamesLabel(dashboard)}
                        align="bottom"
                        enterDelayMs={150}
                        className="tooltip-multiline"
                      >
                        <Tag type="blue" size="sm">
                          {(() => {
                            const n = getPanelCount(dashboard);
                            return `${n} panel${n === 1 ? '' : 's'}`;
                          })()}
                        </Tag>
                      </Tooltip>
                      {(dashboard.tags || []).map((t) => (
                        <Tag
                          key={`dt-${t}`}
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
                    </div>

                    {getConnectionNames(dashboard) !== '-' && (
                      <div className="tile-connection">
                        <DataBase size={14} />
                        <span>{getConnectionNames(dashboard)}</span>
                      </div>
                    )}

                    <div className="tile-date">
                      Updated: {formatDate(dashboard.updated)}
                    </div>
                  </div>

                  {/* Actions — hidden in export mode so the tile is a
                      pure toggle target. */}
                  {!exportMode && (
                    <div className="tile-actions">
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
                    </div>
                  )}
                </Tile>
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
