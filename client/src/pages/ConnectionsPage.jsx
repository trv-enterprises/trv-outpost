// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, useRef } from 'react';
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
  IconButton,
  Loading,
  Tag,
  Link,
  Tile,
  ContentSwitcher,
  Switch,
  Tooltip,
  Dropdown,
  Pagination
} from '@carbon/react';
import { TrashCan, DataBase, List, Grid, Edit, Copy, Information, Sql, Api, Document, NetworkEnterprise, ChartLineSmooth, Meter, Db2Database, Tree, Video } from '@carbon/icons-react';
import apiClient from '../api/client';
import usePaginatedList from '../hooks/usePaginatedList';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import { useNotifications } from '../context/NotificationContext';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import CountListPopover from '../components/shared/CountListPopover';
import { toUsageItems } from '../utils/usageRefs';
import CreateMenu from '../components/CreateMenu';
import { buildConnectionCopy } from '../utils/duplicateEntity';
import './ConnectionsPage.scss';

const PAGE_SIZES = [25, 50, 100];

/**
 * ConnectionsPage Component
 *
 * Displays list of all connections with IBM Cloud-style design:
 * - Page header with title and description
 * - Search bar with filtering
 * - Sortable columns
 * - Click on row to edit, trash icon to delete
 */
function ConnectionsPage() {
  const navigate = useNavigate();
  const { pushToast } = useNotifications();

  // Get saved filters from session store
  const savedFilters = { ...getListPrefs('connections'), ...getFilters('connections') };

  const [searchTerm, setSearchTerm] = useState(savedFilters.search || '');
  // 'components' was a client-only count sort (no server field); fall back to
  // 'updated_at' so a persisted 'components' sortKey stays a valid request.
  const initialSort = savedFilters.sortKey === 'components' ? 'updated_at' : (savedFilters.sortKey || 'updated_at');
  const [sortKey, setSortKey] = useState(initialSort);
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
  const [viewMode, setViewMode] = useState(savedFilters.view || 'list'); // 'list' or 'tile'
  const [typeFilter, setTypeFilter] = useState(savedFilters.type || 'all'); // 'all' or specific type
  const [tagFilter, setTagFilter] = useState(savedFilters.tags || []); // array of tag names
  const [namespaceFilter, setNamespaceFilter] = useState(savedFilters.namespaces || []);
  const [reloadTick, setReloadTick] = useState(0); // bump to refetch after delete
  const [duplicatingId, setDuplicatingId] = useState(null);
  const duplicatingRef = useRef(false); // synchronous re-entry guard, see handleDuplicate

  // Server-side filter/sort/pagination (#21). The wrapped include_usage rows
  // each carry { connection, component_usage, component_count }; flatten them
  // so the render reads `_componentCount`/`_componentUsage` instead of the old
  // client-computed maps. Server search matches NAME only (the old client
  // search also matched description/type — acceptable trade-off).
  const {
    rows: connections,
    total,
    loading,
    hasLoadedOnce,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaginatedList({
    fetcher: (q) => apiClient.getConnections(q),
    extract: (resp) => ({
      rows: (resp?.connections || []).map((r) => ({
        ...r.connection,
        _componentCount: r.component_count || 0,
        _componentUsage: r.component_usage || [],
      })),
      total: resp?.total || 0,
      hasMore: resp?.has_more,
    }),
    filters: {
      include_usage: true,
      namespace: namespaceFilter,
      type: typeFilter === 'all' ? '' : typeFilter,
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
    setFilters('connections', {
      search: searchTerm,
      sortKey,
      sortDir: sortDirection,
      view: viewMode,
      type: typeFilter,
      tags: tagFilter,
      namespaces: namespaceFilter,
    });
    // Persist user-level preferences (view mode, sort, page size) — survives reloads
    setListPrefs('connections', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection,
      pageSize,
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, typeFilter, tagFilter, namespaceFilter, pageSize]);

  // Connection types for filter dropdown
  // Keep in sync with server-go/internal/models/datasource.go DatasourceType* constants
  const CONNECTION_TYPES = [
    { id: 'all', text: 'All Types' },
    { id: 'sql', text: 'SQL Database' },
    { id: 'api', text: 'REST API' },
    { id: 'csv', text: 'CSV File' },
    { id: 'socket', text: 'WebSocket' },
    { id: 'mqtt', text: 'MQTT' },
    { id: 'tsstore', text: 'TS-Store' },
    { id: 'prometheus', text: 'Prometheus' },
    { id: 'synology', text: 'Synology DSM' },
    { id: 'edgelake', text: 'EdgeLake' },
    { id: 'frigate', text: 'Frigate' }
  ];

  // Get icon for connection type
  const getTypeIcon = (type) => {
    const icons = {
      'sql': Sql,
      'api': Api,
      'csv': Document,
      'socket': NetworkEnterprise,
      'mqtt': Tree,
      'tsstore': ChartLineSmooth,
      'prometheus': Meter,
      'edgelake': Db2Database,
      'frigate': Video
    };
    return icons[type?.toLowerCase()] || DataBase;
  };

  const handleCreate = () => {
    navigate('/design/connections/new');
  };

  // Duplicate a connection: copy it under a "(copy)" name in the same namespace
  // and stay on the list (mirrors the dashboard duplicate). Secrets are never
  // sent to the frontend — the fetched config carries "********" masks — so the
  // copy is created WITHOUT credentials and a toast tells the user to re-enter
  // them. The copy is otherwise ready to edit.
  const handleDuplicate = async (e, connection) => {
    e.stopPropagation();
    // Ref, not state: state is read from this render's closure, so two clicks
    // dispatched before a re-render would both pass the guard and create two
    // copies. The state still drives the disabled prop.
    if (duplicatingRef.current) return;
    duplicatingRef.current = true;
    setDuplicatingId(connection.id);
    try {
      // The list row omits config; fetch the full record so the copy carries it.
      const full = await apiClient.getConnection(connection.id);
      const existingNames = new Set((connections || []).map((c) => c?.name).filter(Boolean));
      const { payload, droppedSecrets } = buildConnectionCopy(full, existingNames);
      await apiClient.createConnection(payload);
      refetch();
      if (droppedSecrets) {
        pushToast({
          kind: 'info',
          title: 'Re-enter credentials',
          subtitle: `"${payload.name}" was created without secrets (passwords, API keys, tokens) — open it and re-enter them before use.`,
        });
      }
    } catch (err) {
      pushToast({ kind: 'error', title: 'Duplicate failed', subtitle: err.message });
    } finally {
      duplicatingRef.current = false;
      setDuplicatingId(null);
    }
  };

  const handleRowClick = (connection) => {
    navigate(`/design/connections/${connection.id}`);
  };

  const handleDelete = async (e, connection) => {
    e.stopPropagation();
    if (!window.confirm(`Are you sure you want to delete "${connection.name}"?`)) return;
    try {
      await apiClient.deleteConnection(connection.id);
      refetch();
    } catch (err) {
      // Server returns HTTP 409 + { usage: { components, devices } } when
      // the connection still has references. Render a clear toast that
      // names the blocking entities so the user knows what to clean up.
      if (err.status === 409 && err.body?.usage) {
        const u = err.body.usage;
        const parts = [];
        const comps = (u.components || []).map(c => c.name).filter(Boolean);
        const devs = (u.devices || []).map(d => d.name).filter(Boolean);
        if (comps.length) parts.push(`${comps.length} component${comps.length === 1 ? '' : 's'}: ${comps.slice(0, 5).join(', ')}${comps.length > 5 ? `, +${comps.length - 5} more` : ''}`);
        if (devs.length) parts.push(`${devs.length} device${devs.length === 1 ? '' : 's'}: ${devs.slice(0, 5).join(', ')}${devs.length > 5 ? `, +${devs.length - 5} more` : ''}`);
        pushToast({
          kind: 'error',
          title: `Cannot delete "${connection.name}"`,
          subtitle: `Still referenced by ${parts.join('; ')}. Remove those references first.`,
        });
        return;
      }
      pushToast({ kind: 'error', title: 'Delete failed', subtitle: err.message });
    }
  };

  const formatDate = (dateString) => {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
  };

  const getTypeColor = (type) => {
    const colors = {
      'sql': 'blue',
      'api': 'green',
      'csv': 'purple',
      'socket': 'cyan',
      'mqtt': 'teal',
      'tsstore': 'magenta',
      'prometheus': 'red',
      'edgelake': 'blue',
      'frigate': 'warm-gray'
    };
    return colors[type?.toLowerCase()] || 'gray';
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

  // `connections` is already filtered/sorted/paginated server-side (the hook).
  // The 'components' (count) column has no server sort field — marked
  // non-sortable below.
  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    // (tags now render under the name in the name cell — no separate column)
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'type', header: 'Type', isSortable: true },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'components', header: 'Components', isSortable: false },
    { key: 'updated_at', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = connections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    namespace: connection.namespace || 'default',
    type: connection.type,
    components: connection._componentCount || 0,
    tags: connection.tags || [],
    description: connection.description || '',
    updated_at: formatDate(connection.updated_at)
  }));

  const getConnectionById = (id) => connections.find(c => c.id === id);

  // Full-page spinner only on the first load; later refetches keep the page
  // mounted so filtering/paging updates just the table (#21).
  if (loading && connections.length === 0 && !hasLoadedOnce) {
    return (
      <div className="connections-page">
        <Loading description="Loading connections..." withOverlay={false} />
      </div>
    );
  }

  if (error && connections.length === 0) {
    return (
      <div className="connections-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="connections-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Connections</h1>
        <p className="page-description">
          Configure connections to SQL databases, REST APIs, CSV files, and WebSocket streams.
          Connections provide data for components and receive commands from controls.
          {' '}<Link href="/docs/connections-overview" target="_blank" rel="noopener noreferrer">Learn more</Link>.
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
            id="namespace-filter-connections"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <Dropdown
            id="type-filter"
            label="Filter by type"
            titleText=""
            items={CONNECTION_TYPES}
            itemToString={(item) => item?.text || ''}
            selectedItem={CONNECTION_TYPES.find(t => t.id === typeFilter) || CONNECTION_TYPES[0]}
            onChange={({ selectedItem }) => setTypeFilter(selectedItem?.id || 'all')}
            size="md"
          />
          <TagFilter
            entityType="connections"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <ResetFiltersButton
            active={
              !!searchTerm ||
              namespaceFilter.length > 0 ||
              typeFilter !== 'all' ||
              tagFilter.length > 0
            }
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTypeFilter('all');
              setTagFilter([]);
            }}
          />
          {viewMode === 'tile' && (
            <SortMenu
              sortKey={sortKey}
              sortDirection={sortDirection}
              onChange={(k, d) => { setSortKey(k); setSortDirection(d); }}
              options={[
                { key: 'name', label: 'Name', defaultDir: 'asc' },
                { key: 'updated_at', label: 'Last modified', defaultDir: 'desc' },
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
          {/* No "Create with AI" for connections — they're config-driven,
              not code-driven, so omit the onCreateWithAI handler. */}
          <CreateMenu onCreate={handleCreate} />
        </div>
      </div>

      {/* Tile View */}
      {viewMode === 'tile' && (
        <div className="connections-content">
          {connections.length === 0 ? (
            <div className="empty-state">
              <DataBase size={64} />
              <h3>No connections available</h3>
              <p>
                Looks like you haven't added any connections. Click{' '}
                <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                {' '}to get started.
              </p>
            </div>
          ) : (
            <div className="connections-grid">
              {connections.map((connection) => {
                const TypeIcon = getTypeIcon(connection.type);
                return (
                  <Tile
                    key={connection.id}
                    className="connection-tile"
                    onClick={() => handleRowClick(connection)}
                  >
                    {/* Icon Header */}
                    <div className="tile-icon-header">
                      <TypeIcon size={48} />
                    </div>

                    {/* Content */}
                    <div className="tile-content">
                      <div className="tile-header">
                        <h3>{connection.name}</h3>
                        {connection.description && (
                          <Tooltip label={connection.description} align="bottom">
                            <button type="button" className="info-button" onClick={(e) => e.stopPropagation()}>
                              <Information size={16} />
                            </button>
                          </Tooltip>
                        )}
                      </div>

                      <div className="tile-meta">
                        {connection.namespace && (
                          <NamespaceChip name={connection.namespace} />
                        )}
                        <Tag type={getTypeColor(connection.type)} size="sm">
                          {connection.type?.toUpperCase() || 'N/A'}
                        </Tag>
                        {(connection.tags || []).map((t) => (
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

                      {connection._componentCount > 0 && (
                        <div className="tile-components">
                          <ChartLineSmooth size={14} />
                          <span>{connection._componentCount} component{connection._componentCount !== 1 ? 's' : ''}</span>
                        </div>
                      )}

                      <div className="tile-date">
                        Updated: {formatDate(connection.updated_at)}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="tile-actions">
                      <IconButton
                        kind="ghost"
                        className="action-edit"
                        label="Edit"
                        onClick={(e) => { e.stopPropagation(); handleRowClick(connection); }}
                        size="sm"
                      >
                        <Edit size={16} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        label="Duplicate"
                        onClick={(e) => handleDuplicate(e, connection)}
                        size="sm"
                        disabled={duplicatingId === connection.id}
                      >
                        <Copy size={16} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
                        className="action-delete"
                        label="Delete"
                        onClick={(e) => handleDelete(e, connection)}
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
                          <DataBase size={64} />
                          <h3>No connections available</h3>
                          <p>
                            Looks like you haven't added any connections. Click{' '}
                            <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                            {' '}to get started.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      // During a refetch the Carbon DataTable can briefly render
                      // a stale row id that's no longer in `connections` (the
                      // lookup source) — guard so a transient mismatch doesn't
                      // crash on connection.tags etc.
                      const connection = getConnectionById(row.id);
                      if (!connection) return null;
                      return (
                        <TableRow
                          {...getRowProps({ row })}
                          key={row.id}
                          onClick={() => handleRowClick(connection)}
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
                            if (cell.info.header === 'type') {
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={getTypeColor(cell.value)} size="md">
                                    {cell.value?.toUpperCase() || 'N/A'}
                                  </Tag>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'components') {
                              // Server returns component_usage as [{id,name}]
                              // or {unauthorized,kind} placeholders (#4);
                              // toUsageItems maps both to CountListPopover shape.
                              const items = toUsageItems(connection._componentUsage);
                              return (
                                <TableCell key={cell.id} className="components-cell" onClick={(e) => e.stopPropagation()}>
                                  <CountListPopover
                                    count={cell.value}
                                    items={items}
                                    heading="Components"
                                    emptyLabel="No components reference this connection"
                                    className="components-count"
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
                                      label="Duplicate"
                                      onClick={(e) => handleDuplicate(e, connection)}
                                      size="sm"
                                      disabled={duplicatingId === connection.id}
                                    >
                                      <Copy size={16} />
                                    </IconButton>
                                    <IconButton
                                      kind="ghost"
                                      className="action-delete"
                                      label="Delete"
                                      onClick={(e) => handleDelete(e, connection)}
                                      size="sm"
                                    >
                                      <TrashCan size={16} />
                                    </IconButton>
                                  </div>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'name') {
                              const connTags = connection.tags || [];
                              return (
                                <TableCell key={cell.id} className="name-cell">
                                  <div className="name-cell__name">
                                    <span>{cell.value}</span>
                                  </div>
                                  {connTags.length > 0 && (
                                    <div className="name-cell__tags">
                                      {connTags.map((t) => (
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

    </div>
  );
}

export default ConnectionsPage;
