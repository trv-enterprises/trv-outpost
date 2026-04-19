// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef } from 'react';
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
  Tooltip,
  Toggle,
  InlineNotification,
  Dropdown,
  Checkbox
} from '@carbon/react';
import { TrashCan, ChartLineSmooth, ChartBar, ChartArea, ChartPie, Meter, TableSplit, Code, List, Grid, Edit, DataBase, Information, Dashboard, Keyboard, TouchInteraction, Filter, ChevronDown, ChevronRight } from '@carbon/icons-react';
import MdiIcon from '@mdi/react';
import { CONTROL_TYPE_INFO } from '../components/controls';
import AiIcon from '../components/icons/AiIcon';
import apiClient from '../api/client';
import ChartDeleteDialog from '../components/ChartDeleteDialog';
import CreateMenu from '../components/CreateMenu';
import ComponentPickerModal from '../components/ComponentPickerModal';
import AIPreflightModal from '../components/AIPreflightModal';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import { useNamespaces } from '../context/NamespaceContext';
import './ChartsListPage.scss';

/**
 * ChartsListPage Component
 *
 * Displays list of all standalone charts with IBM Cloud-style design:
 * - Page header with title and description
 * - Search bar with filtering
 * - Sortable columns
 * - Click on row to edit, trash icon to delete
 */
function ChartsListPage() {
  const navigate = useNavigate();

  // Merge persisted per-user prefs (survives reload) with session filters (takes precedence)
  const savedFilters = { ...getListPrefs('charts'), ...getFilters('charts') };

  // Initialize state from saved filters (persist across navigation within session)
  const [charts, setCharts] = useState([]);
  const [connections, setConnections] = useState({});
  const [dashboardCounts, setDashboardCounts] = useState({}); // Map of chart_id -> dashboard count
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
  const [showAllNamespaces, setShowAllNamespaces] = useState(
    savedFilters.showAllNamespaces === true
  );
  const { activeNamespace } = useNamespaces();
  const [typeFilterOpen, setTypeFilterOpen] = useState(false);
  const [collapsedTypes, setCollapsedTypes] = useState(new Set(['display', 'control'])); // Display and Control start collapsed
  const typeFilterRef = useRef(null); // Ref for click-outside detection

  // Hierarchical type filter - tracks selected types
  // null = all selected (no filter), Set = specific selection (empty Set = nothing selected)
  // Chart subtypes: bar, line, area, pie, scatter, gauge, dataview, number, custom
  // Control subtypes: derived from CONTROL_TYPE_INFO
  const [selectedTypes, setSelectedTypes] = useState(() => {
    if (savedFilters.types) {
      return new Set(savedFilters.types.split(',').filter(t => t)); // Filter out empty strings
    }
    return null; // null = all selected
  });

  // Type hierarchy definition
  // Three component types: chart (data viz), display (non-chart visuals), control (interactive)
  const TYPE_HIERARCHY = {
    chart: {
      label: 'Charts',
      dbValue: 'chart', // What's stored in DB (component_type)
      subtypes: [
        { id: 'bar', label: 'Bar Chart' },
        { id: 'line', label: 'Line Chart' },
        { id: 'area', label: 'Area Chart' },
        { id: 'pie', label: 'Pie Chart' },
        { id: 'scatter', label: 'Scatter Plot' },
        { id: 'gauge', label: 'Gauge' },
        { id: 'dataview', label: 'Data Table' },
        { id: 'number', label: 'Number' },
        { id: 'custom', label: 'Custom' }
      ]
    },
    display: {
      label: 'Displays',
      dbValue: 'display',
      subtypes: [
        { id: 'frigate_camera', label: 'Frigate Camera' },
        { id: 'weather', label: 'Weather' }
      ]
    },
    control: {
      label: 'Controls',
      subtypes: Object.entries(CONTROL_TYPE_INFO).map(([id, info]) => ({
        id,
        label: info.label
      }))
    }
  };

  // Get all subtypes for a parent type
  const getSubtypes = (parentType) => {
    return TYPE_HIERARCHY[parentType]?.subtypes.map(s => `${parentType}:${s.id}`) || [];
  };

  // Check if a parent type is fully selected (all subtypes selected)
  const isParentFullySelected = (parentType) => {
    if (selectedTypes === null) return true; // All selected
    const subtypes = getSubtypes(parentType);
    return subtypes.every(st => selectedTypes.has(st));
  };

  // Check if a parent type is partially selected (some but not all subtypes)
  const isParentPartiallySelected = (parentType) => {
    if (selectedTypes === null) return false;
    const subtypes = getSubtypes(parentType);
    const selectedCount = subtypes.filter(st => selectedTypes.has(st)).length;
    return selectedCount > 0 && selectedCount < subtypes.length;
  };

  // Check if a subtype is selected
  const isSubtypeSelected = (parentType, subtypeId) => {
    if (selectedTypes === null) return true; // All selected
    return selectedTypes.has(`${parentType}:${subtypeId}`);
  };

  // Toggle parent type (select/deselect all subtypes)
  const toggleParentType = (parentType) => {
    const subtypes = getSubtypes(parentType);
    const allSelected = isParentFullySelected(parentType);

    setSelectedTypes(prev => {
      if (prev === null) {
        // Currently "all" - switching to specific selection
        // Add all types except this parent's subtypes (deselect this parent)
        const newSet = new Set();
        Object.keys(TYPE_HIERARCHY).forEach(pt => {
          if (pt !== parentType) {
            getSubtypes(pt).forEach(st => newSet.add(st));
          }
        });
        return newSet;
      }

      const newSet = new Set(prev);

      if (allSelected) {
        // Deselect all subtypes of this parent
        subtypes.forEach(st => newSet.delete(st));
        // Allow empty set - will show nothing, which is valid
        return newSet;
      } else {
        // Select all subtypes of this parent
        subtypes.forEach(st => newSet.add(st));
      }

      // If all types are now selected, set to null to represent "all"
      const allSubtypes = Object.keys(TYPE_HIERARCHY).flatMap(pt => getSubtypes(pt));
      if (allSubtypes.every(st => newSet.has(st))) {
        return null;
      }

      return newSet;
    });
  };

  // Toggle individual subtype
  const toggleSubtype = (parentType, subtypeId) => {
    const key = `${parentType}:${subtypeId}`;

    setSelectedTypes(prev => {
      if (prev === null) {
        // Currently "all" - switching to specific selection
        // Add all types except this one
        const newSet = new Set();
        Object.keys(TYPE_HIERARCHY).forEach(pt => {
          getSubtypes(pt).forEach(st => {
            if (st !== key) newSet.add(st);
          });
        });
        return newSet;
      }

      const newSet = new Set(prev);

      if (newSet.has(key)) {
        newSet.delete(key);
      } else {
        newSet.add(key);
      }

      // If all types are now selected, set to null to represent "all"
      const allSubtypes = Object.keys(TYPE_HIERARCHY).flatMap(pt => getSubtypes(pt));
      if (allSubtypes.every(st => newSet.has(st))) {
        return null;
      }

      return newSet;
    });
  };

  // Get filter label for display
  const getTypeFilterLabel = () => {
    if (selectedTypes === null) return 'All Types';
    if (selectedTypes.size === 0) return 'None Selected';
    if (selectedTypes.size === 1) {
      const [type] = selectedTypes;
      const [parent, subtype] = type.split(':');
      const subtypeInfo = TYPE_HIERARCHY[parent]?.subtypes.find(s => s.id === subtype);
      return subtypeInfo?.label || type;
    }
    return `${selectedTypes.size} types selected`;
  };

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
      showAllNamespaces,
    });
    // Persist user-level preferences (view mode, sort) to user config — survives reloads
    setListPrefs('charts', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, connectionFilter, selectedTypes, tagFilter, showAllNamespaces]);

  // Close type filter popover when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (typeFilterRef.current && !typeFilterRef.current.contains(event.target)) {
        setTypeFilterOpen(false);
      }
    };

    if (typeFilterOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [typeFilterOpen]);

  // Fetch charts and data sources from API
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Fetch charts, connections, and dashboards in parallel
      const [chartsData, connectionsData, dashboardsData] = await Promise.all([
        apiClient.getCharts(),
        apiClient.getConnections(),
        apiClient.getDashboards()
      ]);

      if (chartsData.charts) {
        setCharts(chartsData.charts);
      } else if (chartsData.error) {
        setError(chartsData.error);
      } else {
        setCharts([]);
      }

      // Create a lookup map for connections
      if (connectionsData.datasources) {
        const connMap = {};
        connectionsData.datasources.forEach(conn => {
          connMap[conn.id] = conn.name;
        });
        setConnections(connMap);
      }

      // Build dashboard count map by chart_id
      if (dashboardsData.dashboards) {
        const counts = {};
        dashboardsData.dashboards.forEach(dashboard => {
          // Each dashboard has panels, each panel can have a chart_id
          if (dashboard.panels) {
            dashboard.panels.forEach(panel => {
              if (panel.chart_id) {
                counts[panel.chart_id] = (counts[panel.chart_id] || 0) + 1;
              }
            });
          }
        });
        setDashboardCounts(counts);
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
    navigate('/design/charts/new');
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
    navigate('/design/charts/ai/new', { state: context });
  };

  // Component picker handler
  const handlePickerSelect = (item) => {
    setPickerOpen(false);
    navigate(`/design/charts/${item.id}`);
  };

  const handleRowClick = (chart) => {
    navigate(`/design/charts/${chart.id}`);
  };

  const handleAIEdit = (e, chart) => {
    e.stopPropagation();
    navigate(`/design/charts/ai/${chart.id}`);
  };

  const handleDelete = (e, chart) => {
    e.stopPropagation();
    setChartToDelete(chart);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = () => {
    setDeleteDialogOpen(false);
    setChartToDelete(null);
    fetchCharts();
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

    // Active-namespace scope unless the user opted into all.
    if (!showAllNamespaces && activeNamespace) {
      result = result.filter((c) => !c.namespace || c.namespace === activeNamespace);
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

    // Filter by connection
    if (connectionFilter !== 'all') {
      result = result.filter(item => (item.connection_id || item.datasource_id) === connectionFilter);
    }

    // Filter by tags (OR semantics)
    if (tagFilter.length > 0) {
      result = result.filter(chart => {
        const chartTags = chart.tags || [];
        return tagFilter.some(t => chartTags.includes(t));
      });
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(chart => {
        const connName = connections[chart.connection_id || chart.datasource_id] || '';
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
  }, [charts, connections, dashboardCounts, searchTerm, sortKey, sortDirection, selectedTypes, connectionFilter, tagFilter, showAllNamespaces, activeNamespace]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'component_type', header: 'Component', isSortable: true },
    { key: 'chart_type', header: 'Type', isSortable: true },
    { key: 'connection', header: 'Connection', isSortable: true },
    { key: 'dashboards', header: 'Dashboards', isSortable: true },
    { key: 'status', header: 'Status', isSortable: true },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = filteredAndSortedCharts.map((chart) => ({
    id: chart.id,
    name: chart.name,
    namespace: chart.namespace || 'default',
    component_type: chart.component_type || 'chart',
    chart_type: chart.chart_type || chart.control_config?.control_type || chart.display_config?.display_type || '',
    connection: connections[chart.connection_id || chart.datasource_id] || 'None',
    dashboards: dashboardCounts[chart.id] || 0,
    status: chart.status || 'draft',
    description: chart.description || '',
    updated: formatDate(chart.updated)
  }));

  const getChartById = (id) => charts.find(c => c.id === id);

  if (loading) {
    return (
      <div className="charts-list-page">
        <Loading description="Loading components..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="charts-list-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="charts-list-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Components</h1>
        <p className="page-description">
          Create and manage reusable components for your dashboards.
          Components include charts for data visualization and controls for user interaction.
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
          <div ref={typeFilterRef} className="type-filter-dropdown">
            <button
              type="button"
              className={`type-filter-button${typeFilterOpen ? ' type-filter-button--open' : ''}`}
              onClick={() => setTypeFilterOpen(!typeFilterOpen)}
            >
              <span>{getTypeFilterLabel()}</span>
              <ChevronDown size={16} />
            </button>
            {typeFilterOpen && (
            <div className="type-filter-content">
              <div className="type-filter-header">
                <span>Filter by Type</span>
                {selectedTypes !== null && (
                  <button
                    type="button"
                    className="clear-filter-button"
                    onClick={() => setSelectedTypes(null)}
                  >
                    Select All
                  </button>
                )}
              </div>
              <div className="type-filter-list">
                {Object.entries(TYPE_HIERARCHY).map(([parentType, config]) => {
                  const isCollapsed = collapsedTypes.has(parentType);
                  return (
                    <div key={parentType} className="type-filter-group">
                      <div className="type-filter-parent">
                        <button
                          type="button"
                          className="collapse-toggle"
                          onClick={() => {
                            setCollapsedTypes(prev => {
                              const newSet = new Set(prev);
                              if (newSet.has(parentType)) {
                                newSet.delete(parentType);
                              } else {
                                newSet.add(parentType);
                              }
                              return newSet;
                            });
                          }}
                        >
                          {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                        </button>
                        <Checkbox
                          id={`filter-${parentType}`}
                          labelText={config.label}
                          checked={isParentFullySelected(parentType)}
                          indeterminate={isParentPartiallySelected(parentType)}
                          onChange={() => toggleParentType(parentType)}
                        />
                      </div>
                      {!isCollapsed && (
                        <div className="type-filter-subtypes">
                          {config.subtypes.map(subtype => (
                            <Checkbox
                              key={subtype.id}
                              id={`filter-${parentType}-${subtype.id}`}
                              labelText={subtype.label}
                              checked={isSubtypeSelected(parentType, subtype.id)}
                              onChange={() => toggleSubtype(parentType, subtype.id)}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
            )}
          </div>
          <Dropdown
            id="connection-filter"
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
          <TagFilter
            entityType="components"
            selected={tagFilter}
            onChange={setTagFilter}
          />
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
          <Toggle
            id="toggle-all-namespaces-components"
            size="sm"
            labelText=""
            labelA="Current namespace"
            labelB="All namespaces"
            toggled={showAllNamespaces}
            onToggle={setShowAllNamespaces}
          />
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
                      </div>

                      <div className="tile-details">
                        {chart.description && (
                          <span className="tile-description">{chart.description}</span>
                        )}
                        {connections[chart.connection_id || chart.datasource_id] && (
                          <span className="tile-connection">
                            <DataBase size={14} />
                            {connections[chart.connection_id || chart.datasource_id]}
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
                      <IconButton
                        kind="ghost"
                        label="Edit with AI"
                        onClick={(e) => handleAIEdit(e, chart)}
                        size="sm"
                      >
                        <AiIcon size={16} />
                      </IconButton>
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
                                  <div className="name-cell__name">{cell.value}</div>
                                  {chartTags.length > 0 && (
                                    <div className="name-cell__tags">
                                      {chartTags.map((t) => (
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
                                    </div>
                                  )}
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'component_type') {
                              const tagType = cell.value === 'control' ? 'purple' : cell.value === 'display' ? 'teal' : 'blue';
                              const tagLabel = cell.value === 'control' ? 'CONTROL' : cell.value === 'display' ? 'DISPLAY' : 'CHART';
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={tagType} size="md">
                                    {tagLabel}
                                  </Tag>
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
                                    <IconButton
                                      kind="ghost"
                                      label="Edit with AI"
                                      onClick={(e) => handleAIEdit(e, chart)}
                                      size="sm"
                                    >
                                      <AiIcon size={16} />
                                    </IconButton>
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
      <ChartDeleteDialog
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

export default ChartsListPage;
