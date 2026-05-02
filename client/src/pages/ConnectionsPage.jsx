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
  Tooltip,
  Dropdown
} from '@carbon/react';
import { TrashCan, DataBase, List, Grid, Edit, Information, Sql, Api, Document, NetworkEnterprise, ChartLineSmooth, Meter, Db2Database, Tree, Video } from '@carbon/icons-react';
import apiClient from '../api/client';
import TagFilter from '../components/shared/TagFilter';
import NamespaceChip from '../components/shared/NamespaceChip';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import './ConnectionsPage.scss';

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

  // Get saved filters from session store
  const savedFilters = { ...getListPrefs('connections'), ...getFilters('connections') };

  const [connections, setConnections] = useState([]);
  const [chartCounts, setChartCounts] = useState({}); // Map of connection_id -> chart count
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState(savedFilters.search || '');
  const [sortKey, setSortKey] = useState(savedFilters.sortKey || 'updated_at');
  const [sortDirection, setSortDirection] = useState(savedFilters.sortDir || 'desc');
  const [viewMode, setViewMode] = useState(savedFilters.view || 'list'); // 'list' or 'tile'
  const [typeFilter, setTypeFilter] = useState(savedFilters.type || 'all'); // 'all' or specific type
  const [tagFilter, setTagFilter] = useState(savedFilters.tags || []); // array of tag names
  const [namespaceFilter, setNamespaceFilter] = useState(savedFilters.namespaces || []);

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
    // Persist user-level preferences (view mode, sort) to user config — survives reloads
    setListPrefs('connections', {
      view: viewMode,
      sortKey,
      sortDir: sortDirection
    });
  }, [searchTerm, sortKey, sortDirection, viewMode, typeFilter, tagFilter, namespaceFilter]);

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

  // Fetch connections from API
  useEffect(() => {
    fetchConnections();
  }, []);

  const fetchConnections = async () => {
    try {
      setLoading(true);
      // Fetch connections and charts in parallel
      const [connectionsData, chartsData] = await Promise.all([
        apiClient.getConnections(),
        apiClient.getComponents()
      ]);

      if (connectionsData.connections) {
        setConnections(connectionsData.connections);
      } else if (connectionsData.error) {
        setError(connectionsData.error);
      } else {
        setConnections([]);
      }

      // Build component count map by connection_id. A single component can
      // reference a connection through multiple fields (top-level connection_id
      // for charts/controls, display_config.frigate_connection_id and
      // display_config.mqtt_connection_id for Frigate/weather displays). De-dupe
      // per component so referencing the same connection twice still counts once.
      if (chartsData.components) {
        const counts = {};
        chartsData.components.forEach(component => {
          const refs = new Set();
          if (component.connection_id) refs.add(component.connection_id);
          const dc = component.display_config;
          if (dc?.frigate_connection_id) refs.add(dc.frigate_connection_id);
          if (dc?.mqtt_connection_id) refs.add(dc.mqtt_connection_id);
          refs.forEach(connId => {
            counts[connId] = (counts[connId] || 0) + 1;
          });
        });
        setChartCounts(counts);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = () => {
    navigate('/design/connections/new');
  };

  const handleRowClick = (connection) => {
    navigate(`/design/connections/${connection.id}`);
  };

  const handleDelete = async (e, connection) => {
    e.stopPropagation();
    if (window.confirm(`Are you sure you want to delete "${connection.name}"?`)) {
      try {
        await apiClient.deleteConnection(connection.id);
        fetchConnections();
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

  // Filter and sort connections
  const filteredAndSortedConnections = useMemo(() => {
    let result = [...connections];

    // Multi-select namespace filter; empty = no filter.
    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      result = result.filter((c) => !c.namespace || wanted.has(c.namespace));
    }

    // Filter by type
    if (typeFilter !== 'all') {
      result = result.filter(connection => connection.type?.toLowerCase() === typeFilter);
    }

    // Filter by tags (OR semantics: match any selected tag)
    if (tagFilter.length > 0) {
      result = result.filter(connection => {
        const connTags = connection.tags || [];
        return tagFilter.some(t => connTags.includes(t));
      });
    }

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(connection =>
        connection.name?.toLowerCase().includes(term) ||
        connection.description?.toLowerCase().includes(term) ||
        connection.type?.toLowerCase().includes(term)
      );
    }

    // Sort
    result.sort((a, b) => {
      let aVal, bVal;

      // Handle charts count sorting
      if (sortKey === 'charts') {
        aVal = chartCounts[a.id] || 0;
        bVal = chartCounts[b.id] || 0;
      } else {
        aVal = a[sortKey] || '';
        bVal = b[sortKey] || '';
      }

      // Handle date sorting
      if (sortKey === 'updated_at') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else if (sortKey !== 'charts') {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [connections, chartCounts, searchTerm, sortKey, sortDirection, typeFilter, tagFilter, namespaceFilter]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'type', header: 'Type', isSortable: true },
    { key: 'charts', header: 'Charts', isSortable: true },
    { key: 'tags', header: 'Tags', isSortable: false },
    { key: 'description', header: 'Description', isSortable: false },
    { key: 'updated_at', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = filteredAndSortedConnections.map((connection) => ({
    id: connection.id,
    name: connection.name,
    namespace: connection.namespace || 'default',
    type: connection.type,
    charts: chartCounts[connection.id] || 0,
    tags: connection.tags || [],
    description: connection.description || '',
    updated_at: formatDate(connection.updated_at)
  }));

  const getConnectionById = (id) => connections.find(c => c.id === id);

  if (loading) {
    return (
      <div className="connections-page">
        <Loading description="Loading connections..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
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
          Connections provide data for charts and receive commands from controls.
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
          <Button
            onClick={handleCreate}
            size="md"
            kind="primary"
          >
            Create
          </Button>
        </div>
      </div>

      {/* Tile View */}
      {viewMode === 'tile' && (
        <div className="connections-content">
          {filteredAndSortedConnections.length === 0 ? (
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
              {filteredAndSortedConnections.map((connection) => {
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

                      {chartCounts[connection.id] > 0 && (
                        <div className="tile-charts">
                          <ChartLineSmooth size={14} />
                          <span>{chartCounts[connection.id]} chart{chartCounts[connection.id] !== 1 ? 's' : ''}</span>
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
                        label="Edit"
                        onClick={(e) => { e.stopPropagation(); handleRowClick(connection); }}
                        size="sm"
                      >
                        <Edit size={16} />
                      </IconButton>
                      <IconButton
                        kind="ghost"
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
                      const connection = getConnectionById(row.id);
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
                            if (cell.info.header === 'tags') {
                              const cellTags = Array.isArray(cell.value) ? cell.value : [];
                              return (
                                <TableCell key={cell.id} className="tags-cell">
                                  {cellTags.map((t) => (
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
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id} className="actions-cell">
                                  <IconButton
                                    kind="ghost"
                                    label="Delete"
                                    onClick={(e) => handleDelete(e, connection)}
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
    </div>
  );
}

export default ConnectionsPage;
