// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useCallback } from 'react';
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
  Tag,
  Link,
  Tile,
  ContentSwitcher,
  Switch,
  Dropdown,
  OverflowMenu,
  OverflowMenuItem,
  Pagination
} from '@carbon/react';
import { TrashCan, ChartLineSmooth, ChartBar, ChartArea, ChartPie, Meter, TableSplit, Code, List, Grid, Edit, DataBase, Dashboard, TouchInteraction, OverflowMenuVertical, Checkmark } from '@carbon/icons-react';
import MdiIcon from '@mdi/react';
import { CONTROL_TYPE_INFO } from '../components/controls';
import AiIcon from '../components/icons/AiIcon';
import { useAIAvailability } from '../context/AIAvailabilityContext';
import apiClient from '../api/client';
import usePaginatedList from '../hooks/usePaginatedList';
import ComponentDeleteDialog from '../components/ComponentDeleteDialog';
import CreateMenu from '../components/CreateMenu';
import ComponentPickerModal from '../components/ComponentPickerModal';
import AIPreflightModal from '../components/AIPreflightModal';
import TagFilter from '../components/shared/TagFilter';
import TypeHierarchyFilter, { COMPONENT_TYPE_HIERARCHY } from '../components/shared/TypeHierarchyFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import VariableIndicator from '../components/shared/VariableIndicator';
import CustomCodeIndicator from '../components/shared/CustomCodeIndicator';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import CountListPopover from '../components/shared/CountListPopover';
import './ComponentsListPage.scss';
import '../components/shared/FilterOverflowMenu.scss';

const PAGE_SIZES = [25, 50, 100];

// Per-parent subtype counts, used to detect "whole parent selected".
const SUBTYPE_COUNTS = Object.fromEntries(
  Object.entries(COMPONENT_TYPE_HIERARCHY).map(([p, def]) => [p, def.subtypes.length])
);

/**
 * Map a TypeHierarchyFilter selection (Set of "parent:subtype" keys, or null
 * for "all") onto the server's multi-value type params. The server OR-matches
 * across component_types / chart_types / control_types / display_types, so ANY
 * selection — mixed parents, partial subtype sets — is expressed server-side
 * and paginates correctly (no client-side post-filter; the paged total stays
 * accurate).
 *
 * Per parent: if EVERY subtype of a parent is selected, send the parent in
 * component_types (cheaper, and catches components with a blank subtype). For a
 * PARTIAL set, send the individual subtype ids in the parent's *_types list:
 *   chart   → chart_types, control → control_types, display → display_types.
 * Returns { server: { component_types, chart_types, control_types,
 * display_types }, empty: bool } where empty=true means "none selected → show
 * nothing".
 */
function resolveTypeSelection(selectedTypes) {
  const empty = {
    server: { component_types: [], chart_types: [], control_types: [], display_types: [] },
    empty: false,
  };
  if (selectedTypes === null) return empty; // all → no type filter
  if (selectedTypes.size === 0) return { ...empty, empty: true }; // none selected

  const byParent = { chart: [], control: [], display: [] };
  for (const key of selectedTypes) {
    const [parent, subtype] = key.split(':');
    if (byParent[parent]) byParent[parent].push(subtype);
  }

  const component_types = [];
  const chart_types = [];
  const control_types = [];
  const display_types = [];
  const subtypeListByParent = { chart: chart_types, control: control_types, display: display_types };

  for (const parent of ['chart', 'control', 'display']) {
    const subs = byParent[parent];
    if (subs.length === 0) continue;
    if (subs.length === SUBTYPE_COUNTS[parent]) {
      // Whole parent selected → match by component_type (also catches blanks).
      component_types.push(parent);
    } else {
      // Partial set → match the specific subtype ids.
      subtypeListByParent[parent].push(...subs);
    }
  }
  return { server: { component_types, chart_types, control_types, display_types }, empty: false };
}

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
  const [connections, setConnections] = useState({}); // id -> name, one-shot lookup for the connection column
  const [searchTerm, setSearchTerm] = useState(savedFilters.search || '');
  // 'dashboards' (count) and 'connection' (name) were client-only sort keys with
  // no server field; fall back to 'updated' so a persisted value stays valid.
  const initialSort = (savedFilters.sortKey === 'dashboards' || savedFilters.sortKey === 'connection')
    ? 'updated'
    : (savedFilters.sortKey || 'updated');
  const [sortKey, setSortKey] = useState(initialSort);
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
  const [reloadTick, setReloadTick] = useState(0); // bump to refetch after delete
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

  // Resolve the hierarchical type selection into the server's multi-value type
  // params (any selection is now server-side; no client post-filter). See
  // resolveTypeSelection above. `typeEmpty` = nothing selected → show nothing.
  const { server: typeServerParams, empty: typeEmpty } = resolveTypeSelection(selectedTypes);

  // Server-side filter/sort/pagination (#21). dashboard_count / dashboard_usage
  // come from include_usage:true (replaces the old getDashboards(page_size:1000)
  // truncation hack). Server search matches NAME only (the old client search
  // also matched description/chart_type/connection-name — acceptable).
  const {
    rows: charts,
    total,
    loading,
    hasLoadedOnce,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaginatedList({
    fetcher: (q) => {
      // Nothing-selected in the type picker → render an empty list without a
      // pointless server round-trip.
      if (typeEmpty) return Promise.resolve({ components: [], total: 0, has_more: false });
      return apiClient.getComponents(q);
    },
    extract: (resp) => ({ rows: resp?.components || [], total: resp?.total || 0, hasMore: resp?.has_more }),
    filters: {
      include_usage: true,
      namespace: namespaceFilter,
      component_types: typeServerParams.component_types,
      chart_types: typeServerParams.chart_types,
      control_types: typeServerParams.control_types,
      display_types: typeServerParams.display_types,
      connection_id: connectionFilter === 'all' ? '' : connectionFilter,
      tags: tagFilter,
    },
    sortKey,
    sortDir: sortDirection,
    initialPageSize: savedFilters.pageSize || 25,
    search: searchTerm,
    searchKey: 'name',
    reloadTick,
  });

  const refetch = useCallback(() => setReloadTick((t) => t + 1), []);

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
    // Persist user-level preferences (view mode, sort, page size) — survives reloads
    setListPrefs('charts', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection,
      pageSize,
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, connectionFilter, selectedTypes, tagFilter, namespaceFilter, variableOnly, customCodeOnly, pageSize]);

  // One-shot connection-name lookup for the connection column. Connections are
  // few (no truncation risk), so a single page_size:'all' fetch is fine —
  // separate from the paginated component list.
  useEffect(() => {
    let cancelled = false;
    apiClient.getConnections({ page_size: 'all' }).then((data) => {
      if (cancelled || !data?.connections) return;
      const connMap = {};
      data.connections.forEach((conn) => { connMap[conn.id] = conn.name; });
      setConnections(connMap);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

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

  const handleDeleteConfirm = () => {
    setDeleteDialogOpen(false);
    setChartToDelete(null);
    // The delete already succeeded server-side. The list is server-paged now,
    // so refetch the current page to reflect the change (#21).
    refetch();
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

  // Server applied namespace / type (fully, incl. mixed/partial selections via
  // the multi-value type params) / connection / tags / search / sort /
  // pagination. The only remaining CLIENT-only passes are the variableOnly /
  // customCodeOnly toggles — no server field — which filter the loaded page
  // (#21; niche, acceptable).
  const filteredAndSortedCharts = useMemo(() => {
    let result = charts;

    if (variableOnly) {
      result = result.filter((chart) => !!chart.uses_dashboard_variable);
    }
    if (customCodeOnly) {
      result = result.filter((chart) => !!chart.use_custom_code);
    }

    return result;
  }, [charts, variableOnly, customCodeOnly]);

  // Sort allowlist: name, updated, created, component_type, chart_type, status,
  // namespace. 'dashboards' (count) and 'connection' (name) have no server sort
  // field — marked non-sortable. The old drafts-first special-case is dropped
  // (status sorts plainly now).
  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'component_type', header: 'Component', isSortable: true },
    { key: 'chart_type', header: 'Type', isSortable: true },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'dashboards', header: 'Dashboards', isSortable: false },
    { key: 'connection', header: 'Connection', isSortable: false },
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
    connection: connections[chart.connection_id] || 'None',
    dashboards: chart.dashboard_count || 0,
    status: chart.status || 'draft',
    description: chart.description || '',
    updated: formatDate(chart.updated)
  }));

  const getChartById = (id) => charts.find(c => c.id === id);

  // Full-page spinner ONLY on the very first load (no rows yet). On later
  // refetches (filter / sort / page change) keep the page — header, toolbar,
  // filters, pagination — mounted so only the table contents update; the
  // toolbar shows the inline busy state instead of the whole page flashing.
  if (loading && charts.length === 0 && !hasLoadedOnce) {
    return (
      <div className="components-list-page">
        <Loading description="Loading components..." withOverlay={false} />
      </div>
    );
  }

  if (error && charts.length === 0) {
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
            width={190}
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
                        {chart.dashboard_count > 0 && (
                          <span className="tile-dashboards">
                            <Dashboard size={14} />
                            {chart.dashboard_count} dashboard{chart.dashboard_count !== 1 ? 's' : ''}
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
                      if (!chart) return null; // guard transient refetch row/lookup mismatch
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
                              // Server returns dashboard_usage as [{id,name}];
                              // CountListPopover wants [{id,label}].
                              const items = (chart?.dashboard_usage || []).map((u) => ({ id: u.id, label: u.name }));
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
              {/* #112: footer lives INSIDE the table panel so it's bounded by the
                  table's width and reads as the table's footer. */}
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
            </TableContainer>
          )}
        </DataTable>
      )}

      {/* Tile view keeps its own page-level pagination (#21). */}
      {viewMode === 'tile' && (
        <Pagination
          className="list-pagination list-pagination--tile"
          page={page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          totalItems={total}
          onChange={({ page: p, pageSize: ps }) => {
            if (ps !== pageSize) setPageSize(ps);
            setPage(p);
          }}
        />
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
