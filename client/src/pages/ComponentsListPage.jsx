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
  Tag,
  Link,
  Tile,
  ContentSwitcher,
  Switch,
  InlineNotification,
  Dropdown,
  OverflowMenu,
  OverflowMenuItem
} from '@carbon/react';
import { TrashCan, ChartLineSmooth, ChartBar, ChartArea, ChartPie, Meter, TableSplit, Code, List, Grid, Edit, DataBase, Information, Dashboard, Keyboard, TouchInteraction, Filter, OverflowMenuVertical, Checkmark } from '@carbon/icons-react';
import MdiIcon from '@mdi/react';
import { CONTROL_TYPE_INFO } from '../components/controls';
import AiIcon from '../components/icons/AiIcon';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import apiClient from '../api/client';
import ComponentDeleteDialog from '../components/ComponentDeleteDialog';
import CreateMenu from '../components/CreateMenu';
import ComponentPickerModal from '../components/ComponentPickerModal';
import AIPreflightModal from '../components/AIPreflightModal';
import TagFilter from '../components/shared/TagFilter';
import TypeHierarchyFilter from '../components/shared/TypeHierarchyFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import VariableIndicator from '../components/shared/VariableIndicator';
import CustomCodeIndicator from '../components/shared/CustomCodeIndicator';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import CountListPopover from '../components/shared/CountListPopover';
import './ComponentsListPage.scss';
import '../components/shared/FilterOverflowMenu.scss';

/**
 * ComponentsListPage Component
 *
 * Displays list of all standalone charts with IBM Cloud-style design:
 * - Page header with title and description
 * - Search bar with filtering
 * - Sortable columns
 * - Click on row to edit, trash icon to delete
 */
function ComponentsListPage() {
  const navigate = useNavigate();
  // Hide the "Edit with AI" wand (row action) when the deployment
  // has no Anthropic key. Same hide-while-loading semantics as the
  // menus — see AIAvailabilityContext.
  const { enabled: aiEnabled } = useAIAvailability();

  // Merge persisted per-user prefs (survives reload) with session filters (takes precedence)
  const savedFilters = { ...getListPrefs('charts'), ...getFilters('charts') };

  // Initialize state from saved filters (persist across navigation within session)
  const [charts, setCharts] = useState([]);
  const [connections, setConnections] = useState({});
  const [dashboardCounts, setDashboardCounts] = useState({}); // Map of component_id -> dashboard count
  const [dashboardNames, setDashboardNames] = useState({}); // Map of component_id -> array of dashboard display names
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState(savedFilters.search || '');
  const [sortKey, setSortKey] = useState(savedFilters.sortKey || 'updated');
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [chartToDelete, setChartToDelete] = useState(null);
  const [viewMode, setViewMode] = useState(savedFilters.view || 'list'); // 'list' or 'tile'
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aiPreflightOpen, setAiPreflightOpen] = useState(false);
  const [connectionFilter, setConnectionFilter] = useState(savedFilters.ds || 'all'); // 'all' or connection id
  const [tagFilter, setTagFilter] = useState(savedFilters.tags || []); // array of tag names
  const [variableOnly, setVariableOnly] = useState(!!savedFilters.variableOnly); // show only variable-driven components
  const [customCodeOnly, setCustomCodeOnly] = useState(!!savedFilters.customCodeOnly); // show only custom-code components
  const [namespaceFilter, setNamespaceFilter] = useState(savedFilters.namespaces || []);
  // Hierarchical type filter — selection state only. The widget itself
  // (popover, parent/subtype checkboxes, partial-state logic, label
  // formatting, click-outside) is provided by the shared
  // TypeHierarchyFilter component. Subtype catalog lives in
  // shared/TypeHierarchyFilter.jsx so it stays in sync with the picker
  // modal.
  // null = all selected (no filter), Set of "parent:subtype" keys = specific selection.
  const [selectedTypes, setSelectedTypes] = useState(() => {
    if (savedFilters.types) {
      return new Set(savedFilters.types.split(',').filter(t => t));
    }
    return null;
  });

  // Save filters to session store when they change
  useEffect(() => {
    setFilters('charts', {
      search: searchTerm,
      sortKey,
      sortDir: sortDirection,
      view: viewMode,
      ds: connectionFilter,
      types: selectedTypes !== null && selectedTypes.size > 0 ? Array.from(selectedTypes).join(',') : '',
      tags: tagFilter,
      namespaces: namespaceFilter,
      variableOnly,
      customCodeOnly,
    });
    // Persist user-level preferences (view mode, sort) to user config — survives reloads
    setListPrefs('charts', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, connectionFilter, selectedTypes, tagFilter, namespaceFilter, variableOnly, customCodeOnly]);

  // Fetch charts and data sources from API
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Fetch charts, connections, and dashboards in parallel
      const [chartsData, connectionsData, dashboardsData] = await Promise.all([
        apiClient.getComponents(),
        apiClient.getConnections(),
        apiClient.getDashboards()
      ]);

      if (chartsData.components) {
        setCharts(chartsData.components);
      } else if (chartsData.error) {
        setError(chartsData.error);
      } else {
        setCharts([]);
      }

      // Create a lookup map for connections
      if (connectionsData.connections) {
        const connMap = {};
        connectionsData.connections.forEach(conn => {
          connMap[conn.id] = conn.name;
        });
        setConnections(connMap);
      }

      // Build dashboard count + name-list maps by component_id. The
      // count tracks how many panels reference the component (a single
      // dashboard can use the same component in multiple panels — those
      // bump the count but the dashboard name only appears once in the
      // tooltip list).
      if (dashboardsData.dashboards) {
        const counts = {};
        const names = {};
        dashboardsData.dashboards.forEach(dashboard => {
          if (!dashboard.panels) return;
          const dashboardLabel = dashboard.name || '(unnamed)';
          const seenInThisDashboard = new Set();
          dashboard.panels.forEach(panel => {
            if (!panel.component_id) return;
            counts[panel.component_id] = (counts[panel.component_id] || 0) + 1;
            if (seenInThisDashboard.has(panel.component_id)) return;
            seenInThisDashboard.add(panel.component_id);
            // Store { id, label } so the count popover can navigate to each
            // dashboard's editor.
            (names[panel.component_id] = names[panel.component_id] || []).push({ id: dashboard.id, label: dashboardLabel });
          });
        });
        setDashboardCounts(counts);
        setDashboardNames(names);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchCharts = async () => {
    fetchData();
  };

  // Create menu handlers
  const handleCreate = () => {
    navigate('/design/components/new');
  };

  const handleCreateWithAI = () => {
    setAiPreflightOpen(true);
  };

  const handleSelectExisting = () => {
    setPickerOpen(true);
  };

  // AI pre-flight modal handler
  const handleAIPreflightContinue = (context) => {
    setAiPreflightOpen(false);
    navigate('/design/components/ai/new', { state: context });
  };

  // Component picker handler
  const handlePickerSelect = (item) => {
    setPickerOpen(false);
    navigate(`/design/components/${item.id}`);
  };

  const handleRowClick = (chart) => {
    navigate(`/design/components/${chart.id}`);
  };

  const handleAIEdit = (e, chart) => {
    e.stopPropagation();
    navigate(`/design/components/ai/${chart.id}`);
  };

  const handleDelete = (e, chart) => {
    e.stopPropagation();
    setChartToDelete(chart);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = (result) => {
    setDeleteDialogOpen(false);
    setChartToDelete(null);
    // The delete already succeeded server-side. When the whole component
    // was removed, drop just its row from local state — no full re-fetch
    // (re-fetching components + connections + dashboards and replacing the
    // arrays regenerated the entire list on a single delete). When only a
    // version/draft was removed the component still exists; re-fetch so the
    // row's version metadata stays accurate.
    if (result?.removedComponent) {
      setCharts((prev) => prev.filter((c) => c.id !== result.id));
    } else {
      fetchCharts();
    }
  };

  const handleDeleteClose = () => {
    setDeleteDialogOpen(false);
    setChartToDelete(null);
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getChartTypeColor = (chartType) => {
    const colors = {
      'bar': 'blue',
      'line': 'green',
      'area': 'teal',
      'pie': 'purple',
      'scatter': 'magenta',
      'gauge': 'cyan',
      'dataview': 'purple',
      'number': 'teal',
      'custom': 'gray'
    };
    return colors[chartType?.toLowerCase()] || 'gray';
  };

  // Get icon component for chart type
  const getChartTypeIcon = (chartType, componentType, controlType) => {
    // Controls use MDI icons from CONTROL_TYPE_INFO
    if (componentType === 'control') {
      const typeInfo = CONTROL_TYPE_INFO[controlType];
      if (typeInfo?.icon) {
        // Return a wrapper component that renders the MDI icon
        const iconPath = typeInfo.icon;
        return ({ size }) => <MdiIcon path={iconPath} size={`${size}px`} color="currentColor" />;
      }
      return TouchInteraction;
    }
    const icons = {
      'bar': ChartBar,
      'line': ChartLineSmooth,
      'area': ChartArea,
      'pie': ChartPie,
      'gauge': Meter,
      'dataview': TableSplit,
      'number': Meter,
      'custom': Code
    };
    return icons[chartType?.toLowerCase()] || ChartLineSmooth;
  };

  // Handle column sorting
  const handleSort = (key) => {
    let newDirection = 'asc';
    if (sortKey === key) {
      newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
      setSortDirection(newDirection);
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // Filter and sort components (displays + controls)
  const filteredAndSortedCharts = useMemo(() => {
    let result = [...charts];

    // Multi-select namespace filter; empty filter = show everything.
    // Components with an empty/missing namespace value are treated as
    // "default" — same fallback the table cell uses for display, so
    // filtering and the visible namespace tag stay in lockstep.
    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      result = result.filter((c) => wanted.has(c.namespace || 'default'));
    }

    // Filter by hierarchical type selection
    // null = all selected (no filter), Set = specific selection
    if (selectedTypes !== null) {
      if (selectedTypes.size === 0) {
        // Nothing selected - return empty array
        return [];
      }
      result = result.filter(item => {
        // Map component_type to hierarchy key
        const componentType = item.component_type || 'chart';
        let subtype;
        if (componentType === 'control') {
          subtype = item.control_config?.control_type || 'button';
        } else if (componentType === 'display') {
          subtype = item.display_config?.display_type || 'frigate_camera';
        } else {
          subtype = item.chart_type || 'custom';
        }
        const typeKey = `${componentType}:${subtype}`;
        return selectedTypes.has(typeKey);
      });
    }

    // Filter by connection. Components reference connections through one of
    // three fields: top-level connection_id (charts/controls), or
    // display_config.frigate_connection_id / mqtt_connection_id for
    // Frigate/weather displays. Include all of them so a Frigate display's
    // API and MQTT connections both filter correctly.
    if (connectionFilter !== 'all') {
      result = result.filter(item => {
        if (item.connection_id === connectionFilter) return true;
        const dc = item.display_config;
        if (dc?.frigate_connection_id === connectionFilter) return true;
        if (dc?.mqtt_connection_id === connectionFilter) return true;
        return false;
      });
    }

    // Filter by tags (OR semantics)
    if (tagFilter.length > 0) {
      result = result.filter(chart => {
        const chartTags = chart.tags || [];
        return tagFilter.some(t => chartTags.includes(t));
      });
    }

    // Variable-driven only: keep components whose query/filter uses the
    // {{dashboard-variable}} token (auto-derived uses_dashboard_variable).
    if (variableOnly) {
      result = result.filter(chart => !!chart.uses_dashboard_variable);
    }

    // Custom-code only: keep components that render from hand-written code.
    if (customCodeOnly) {
      result = result.filter(chart => !!chart.use_custom_code);
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(chart => {
        const connName = connections[chart.connection_id || chart.connection_id] || '';
        return chart.name?.toLowerCase().includes(term) ||
          chart.description?.toLowerCase().includes(term) ||
          chart.chart_type?.toLowerCase().includes(term) ||
          connName.toLowerCase().includes(term);
      });
    }

    // Sort - drafts first, then by selected sort key
    result.sort((a, b) => {
      // Primary sort: drafts come first
      const aIsDraft = (a.status || 'draft') === 'draft';
      const bIsDraft = (b.status || 'draft') === 'draft';
      if (aIsDraft && !bIsDraft) return -1;
      if (!aIsDraft && bIsDraft) return 1;

      // Secondary sort: by selected sort key
      let aVal, bVal;

      // Handle connection sorting (use name lookup)
      if (sortKey === 'connection') {
        aVal = connections[a.connection_id || a.datasource_id] || '';
        bVal = connections[b.connection_id || b.datasource_id] || '';
      } else if (sortKey === 'component_type' || sortKey === 'chart_type') {
        // Component + Type are two columns, but BOTH sort by the same composite
        // key: component_type FIRST so all charts (then controls, then displays)
        // group together, then by subtype within each group (chart/LINE,
        // chart/BAR, ...). So sorting by either column keeps charts contiguous
        // instead of the old behavior where a Type sort interleaved
        // chart/control/display by subtype.
        const sub = (c) => c.chart_type || c.control_config?.control_type || c.display_config?.display_type || '';
        aVal = `${a.component_type || 'chart'}:${sub(a)}`;
        bVal = `${b.component_type || 'chart'}:${sub(b)}`;
      } else if (sortKey === 'dashboards') {
        // Handle dashboards count sorting
        aVal = dashboardCounts[a.id] || 0;
        bVal = dashboardCounts[b.id] || 0;
      } else {
        aVal = a[sortKey] || '';
        bVal = b[sortKey] || '';
      }

      // Handle date sorting
      if (sortKey === 'updated') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else if (sortKey !== 'dashboards') {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [charts, connections, dashboardCounts, searchTerm, sortKey, sortDirection, selectedTypes, connectionFilter, tagFilter, namespaceFilter, variableOnly, customCodeOnly]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'component_type', header: 'Component', isSortable: true },
    { key: 'chart_type', header: 'Type', isSortable: true },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'dashboards', header: 'Dashboards', isSortable: true },
    { key: 'connection', header: 'Connection', isSortable: true },
    { key: 'status', header: 'Status', isSortable: true },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = filteredAndSortedCharts.map((chart) => ({
    id: chart.id,
    name: chart.name,
    namespace: chart.namespace || 'default',
    component_type: chart.component_type || 'chart',
    chart_type: chart.chart_type || chart.control_config?.control_type || chart.display_config?.display_type || '',
    connection: connections[chart.connection_id || chart.connection_id] || 'None',
    dashboards: dashboardCounts[chart.id] || 0,
    status: chart.status || 'draft',
    description: chart.description || '',
    updated: formatDate(chart.updated)
  }));

  const getChartById = (id) => charts.find(c => c.id === id);

  if (loading) {
    return (
      <div className="components-list-page">
        <Loading description="Loading components..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="components-list-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="components-list-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Components</h1>
        <p className="page-description">
          Create and manage reusable components for your dashboards.
          Components include charts for data visualization and controls for user interaction.
          {' '}<Link href="/docs/components-overview" target="_blank" rel="noopener noreferrer">Learn more</Link>.
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
            id="namespace-filter-components"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <TypeHierarchyFilter
            selectedTypes={selectedTypes}
            onChange={setSelectedTypes}
          />
          <TagFilter
            entityType="components"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <Dropdown
            id="connection-filter"
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
          {/* Overflow (⋮) menu for facet toggles. Mirrors the dashboard
              viewer's three-dot menu. Holds the "Variable-driven only" toggle
              (checkmark when active); room for more facet toggles later.
              Sits BEFORE the reset button so reset stays the rightmost
              control in the filter group. */}
          <OverflowMenu
            renderIcon={() => <OverflowMenuVertical size={20} />}
            flipped
            direction="bottom"
            align="bottom-end"
            iconDescription="Filter options"
            menuOptionsClass="filter-overflow-options"
            className={`filter-overflow-trigger${(variableOnly || customCodeOnly) ? ' filter-overflow-trigger--active' : ''}`}
          >
            <OverflowMenuItem
              itemText={
                <span className="filter-overflow-item">
                  {variableOnly
                    ? <Checkmark size={16} />
                    : <span style={{ width: 16, display: 'inline-block' }} />}
                  <span>Variable-driven only</span>
                </span>
              }
              onClick={() => setVariableOnly((v) => !v)}
            />
            <OverflowMenuItem
              itemText={
                <span className="filter-overflow-item">
                  {customCodeOnly
                    ? <Checkmark size={16} />
                    : <span style={{ width: 16, display: 'inline-block' }} />}
                  <span>Custom code only</span>
                </span>
              }
              onClick={() => setCustomCodeOnly((v) => !v)}
            />
          </OverflowMenu>
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              selectedTypes !== null ||
              tagFilter.length > 0 ||
              connectionFilter !== 'all' ||
              variableOnly ||
              customCodeOnly
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setSelectedTypes(null);
              setTagFilter([]);
              setConnectionFilter('all');
              setVariableOnly(false);
              setCustomCodeOnly(false);
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
          <CreateMenu
            onCreate={handleCreate}
            onCreateWithAI={handleCreateWithAI}
            onSelectExisting={handleSelectExisting}
          />
        </div>
      </div>

      {/* Tile View */}
      {viewMode === 'tile' && (
        <div className="charts-content">
          {filteredAndSortedCharts.length === 0 ? (
            <div className="empty-state">
              <ChartLineSmooth size={64} />
              <h3>No components available</h3>
              <p>
                Looks like you haven't added any components. Click{' '}
                <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                {' '}to get started.
              </p>
            </div>
          ) : (
            <div className="charts-rows">
              {filteredAndSortedCharts.map((chart) => {
                const TypeIcon = getChartTypeIcon(chart.chart_type, chart.component_type, chart.control_config?.control_type);
                return (
                  <Tile
                    key={chart.id}
                    className="chart-row-tile"
                    onClick={() => handleRowClick(chart)}
                  >
                    {/* Icon */}
                    <div className={`tile-icon tile-icon--${getChartTypeColor(chart.chart_type)}`}>
                      <TypeIcon size={32} />
                    </div>

                    {/* Content */}
                    <div className="tile-content">
                      <div className="tile-header">
                        <h3>{chart.name}</h3>
                        <div className="tile-meta">
                          {chart.namespace && (
                            <NamespaceChip name={chart.namespace} />
                          )}
                          <Tag type={chart.component_type === 'control' ? 'purple' : chart.component_type === 'display' ? 'teal' : 'blue'} size="sm">
                            {chart.component_type === 'control' ? 'CONTROL' : chart.component_type === 'display' ? 'DISPLAY' : 'CHART'}
                          </Tag>
                          <Tag type={getChartTypeColor(chart.chart_type)} size="sm">
                            {chart.chart_type?.toUpperCase() || 'N/A'}
                          </Tag>
                          <Tag type={chart.status === 'final' ? 'green' : 'gray'} size="sm">
                            {chart.status === 'draft'
                              ? (chart.version > 0 ? `DRAFT (v${chart.version} saved)` : 'DRAFT')
                              : `V${chart.version || 0}`}
                          </Tag>
                          {(chart.tags || []).map((t) => (
                            <Tag
                              key={`ct-${t}`}
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
                      </div>

                      <div className="tile-details">
                        {chart.description && (
                          <span className="tile-description">{chart.description}</span>
                        )}
                        {connections[chart.connection_id || chart.connection_id] && (
                          <span className="tile-connection">
                            <DataBase size={14} />
                            {connections[chart.connection_id || chart.connection_id]}
                          </span>
                        )}
                        {dashboardCounts[chart.id] > 0 && (
                          <span className="tile-dashboards">
                            <Dashboard size={14} />
                            {dashboardCounts[chart.id]} dashboard{dashboardCounts[chart.id] !== 1 ? 's' : ''}
                          </span>
                        )}
                        <span className="tile-date">
                          Updated: {formatDate(chart.updated)}
                        </span>
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="tile-actions">
                      <IconButton
                        kind="ghost"
                        label="Edit"
                        onClick={(e) => { e.stopPropagation(); handleRowClick(chart); }}
                        size="sm"
                      >
                        <Edit size={16} />
                      </IconButton>
                      {aiEnabled && (
                        <IconButton
                          kind="ghost"
                          label="Edit with AI"
                          onClick={(e) => handleAIEdit(e, chart)}
                          size="sm"
                        >
                          <AiIcon size={16} />
                        </IconButton>
                      )}
                      <IconButton
                        kind="ghost"
                        label="Delete"
                        onClick={(e) => handleDelete(e, chart)}
                        size="sm"
                      >
                        <TrashCan size={16} />
                      </IconButton>
                    </div>
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
                    {headers.map((header) => (
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
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={headers.length}>
                        <div className="empty-state">
                          <ChartLineSmooth size={64} />
                          <h3>No components available</h3>
                          <p>
                            Looks like you haven't added any components. Click{' '}
                            <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                            {' '}to get started.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const chart = getChartById(row.id);
                      return (
                        <TableRow
                          {...getRowProps({ row })}
                          key={row.id}
                          onClick={() => handleRowClick(chart)}
                          className="clickable-row"
                        >
                          {row.cells.map((cell) => {
                            if (cell.info.header === 'namespace') {
                              return (
                                <TableCell key={cell.id} className="namespace-cell">
                                  <NamespaceChip name={cell.value} />
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'name') {
                              const chartTags = chart?.tags || [];
                              return (
                                <TableCell key={cell.id} className="name-cell">
                                  <div className="name-cell__name">
                                    <span>{cell.value}</span>
                                    <VariableIndicator active={!!chart?.uses_dashboard_variable} />
                                    <CustomCodeIndicator active={!!chart?.use_custom_code} />
                                  </div>
                                  {chartTags.length > 0 && (
                                    <div className="name-cell__tags">
                                      {chartTags.map((t) => (
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
                            if (cell.info.header === 'component_type') {
                              const tagType = cell.value === 'control' ? 'purple' : cell.value === 'display' ? 'teal' : 'blue';
                              const tagLabel = cell.value === 'control' ? 'CONTROL' : cell.value === 'display' ? 'DISPLAY' : 'CHART';
                              return (
                                // Right-aligned so the Component pill hugs the
                                // Component|Type border, with a ':' connector after
                                // it (in the cell's existing right-edge space — no
                                // extra column width) signalling it pairs with the
                                // Type pill.
                                <TableCell key={cell.id} className="component-cell--right">
                                  <Tag type={tagType} size="md">
                                    {tagLabel}
                                  </Tag>
                                  <span className="component-cell__pair-colon" aria-hidden="true">:</span>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'chart_type') {
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={getChartTypeColor(cell.value)} size="md">
                                    {cell.value?.toUpperCase() || 'N/A'}
                                  </Tag>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'dashboards') {
                              const items = (chart && dashboardNames[chart.id]) || [];
                              return (
                                <TableCell key={cell.id} className="dashboards-cell" onClick={(e) => e.stopPropagation()}>
                                  <CountListPopover
                                    count={cell.value}
                                    items={items}
                                    heading="Dashboards"
                                    emptyLabel="Not used by any dashboard"
                                    className="dashboards-count"
                                    onItemClick={(item) => navigate(`/design/dashboards/${item.id}`)}
                                  />
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'status') {
                              const isDraft = cell.value === 'draft';
                              const chartVersion = chart?.version || 0;
                              const hasSavedVersion = isDraft && chartVersion > 0;
                              const statusColor = cell.value === 'final' ? 'green' : 'gray';
                              const statusLabel = isDraft
                                ? (hasSavedVersion ? `DRAFT (v${chartVersion} saved)` : 'DRAFT')
                                : `V${chartVersion}`;
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={statusColor} size="md">
                                    {statusLabel}
                                  </Tag>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id} className="actions-cell">
                                  <div className="actions-wrapper">
                                    {aiEnabled && (
                                      <IconButton
                                        kind="ghost"
                                        label="Edit with AI"
                                        onClick={(e) => handleAIEdit(e, chart)}
                                        size="sm"
                                      >
                                        <AiIcon size={16} />
                                      </IconButton>
                                    )}
                                    <IconButton
                                      kind="ghost"
                                      label="Delete"
                                      onClick={(e) => handleDelete(e, chart)}
                                      size="sm"
                                    >
                                      <TrashCan size={16} />
                                    </IconButton>
                                  </div>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'description') {
                              return (
                                <TableCell key={cell.id} className="description-cell" title={cell.value}>
                                  <span className="description-cell__text">{cell.value}</span>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'connection') {
                              // Link the connection name to its editor. Plain
                              // text when there's no connection ('None').
                              const connId = chart?.connection_id;
                              return (
                                <TableCell key={cell.id} className="connection-cell" onClick={(e) => e.stopPropagation()}>
                                  {connId && connections[connId] ? (
                                    <Link
                                      href={`/design/connections/${connId}`}
                                      onClick={(e) => {
                                        e.preventDefault();
                                        navigate(`/design/connections/${connId}`);
                                      }}
                                    >
                                      {connections[connId]}
                                    </Link>
                                  ) : (
                                    cell.value
                                  )}
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

      {/* Delete Confirmation Dialog */}
      <ComponentDeleteDialog
        open={deleteDialogOpen}
        chart={chartToDelete}
        onClose={handleDeleteClose}
        onDelete={handleDeleteConfirm}
      />

      {/* Component Picker Modal */}
      <ComponentPickerModal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={handlePickerSelect}
        category="chart"
      />

      {/* AI Pre-flight Modal */}
      <AIPreflightModal
        open={aiPreflightOpen}
        onClose={() => setAiPreflightOpen(false)}
        onContinue={handleAIPreflightContinue}
      />

    </div>
  );
}

export default ComponentsListPage;
