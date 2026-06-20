// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
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
  Pagination
} from '@carbon/react';
import { TrashCan, UserMultiple, List, Grid, Edit } from '@carbon/icons-react';
import apiClient from '../api/client';
import { getListPrefs, setListPrefs } from '../utils/listPrefs';
import usePaginatedList from '../hooks/usePaginatedList';
import './UsersListPage.scss';

const PAGE_SIZES = [25, 50, 100];

/**
 * UsersListPage Component
 *
 * Displays list of all users with IBM Cloud-style design:
 * - Page header with title and description
 * - Search bar with filtering
 * - Sortable columns
 * - Click on row to edit, trash icon to delete
 */
function UsersListPage() {
  const navigate = useNavigate();
  const savedPrefs = getListPrefs('users');
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState(savedPrefs.sortKey || 'name');
  const [sortDirection, setSortDirection] = useState(savedPrefs.sortDir || 'asc');
  const [viewMode, setViewMode] = useState(savedPrefs.view || 'list'); // 'list' or 'tile'
  const [reloadTick, setReloadTick] = useState(0); // bump to refetch after delete

  // Server-side filter/sort/pagination (#21). The 'capabilities' sort key is
  // client-only (no server field); map it to the closest server sort so the
  // request stays valid, then the column still highlights.
  const serverSortKey = sortKey === 'capabilities' ? 'name' : sortKey;
  const {
    rows: users,
    total,
    loading,
    hasLoadedOnce,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaginatedList({
    fetcher: (q) => apiClient.getUsers(q),
    extract: (resp) => ({ rows: resp?.users || [], total: resp?.total || 0, hasMore: resp?.has_more }),
    filters: {},
    sortKey: serverSortKey,
    sortDir: sortDirection,
    initialPageSize: savedPrefs.pageSize || 25,
    search: searchTerm,
    searchKey: 'name',
    reloadTick,
  });

  // Persist user-level preferences to user config
  useEffect(() => {
    setListPrefs('users', { view: viewMode, sortKey, sortDir: sortDirection, pageSize });
  }, [viewMode, sortKey, sortDirection, pageSize]);

  // Get color for capability tag
  const getCapabilityColor = (capability) => {
    const colors = {
      'view': 'gray',
      'design': 'blue',
      'manage': 'purple'
    };
    return colors[capability?.toLowerCase()] || 'gray';
  };

  const refetch = useCallback(() => setReloadTick((t) => t + 1), []);

  const handleCreate = () => {
    navigate('/manage/users/new');
  };

  const handleRowClick = (user) => {
    navigate(`/manage/users/${user.id}`);
  };

  const handleDelete = async (e, user) => {
    e.stopPropagation();
    const msg =
      `Delete user "${user.name}"?\n\n` +
      `This will also delete:\n` +
      `  • all of this user's API keys (any active tokens stop working immediately)\n` +
      `  • this user's saved preferences (active namespace, dashboard view settings, etc.)\n\n` +
      `Components, dashboards, and connections this user created stay in place.`;
    if (window.confirm(msg)) {
      try {
        await apiClient.deleteUser(user.id);
        refetch();
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

  // Handle column sorting
  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  // `users` is already filtered/sorted/paginated server-side (the hook).
  // 'capabilities' is not a server sort field (it's array-derived) so it's
  // marked non-sortable below.
  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'email', header: 'Email', isSortable: true },
    { key: 'capabilities', header: 'Capabilities', isSortable: false },
    { key: 'active', header: 'Status', isSortable: false },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email || '',
    capabilities: user.capabilities || [],
    active: user.active,
    updated: formatDate(user.updated)
  }));

  const getUserById = (id) => users.find(u => u.id === id);

  // Full-page spinner only on the first load; later refetches keep the page
  // mounted so filtering/paging updates just the table (#21).
  if (loading && users.length === 0 && !hasLoadedOnce) {
    return (
      <div className="users-page">
        <Loading description="Loading users..." withOverlay={false} />
      </div>
    );
  }

  if (error && users.length === 0) {
    return (
      <div className="users-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="users-page">
      {/* Page Header */}
      <div className="page-header">
        <h1>Users</h1>
        <p className="page-description">
          Manage user accounts and their access capabilities.
          Users can have View, Design, and/or Manage permissions.
          {' '}<Link href="/docs/user-management" target="_blank" rel="noopener noreferrer">Learn more</Link>.
        </p>
      </div>

      {/* Toolbar */}
      <div className="page-toolbar">
        <div className="toolbar-left">
          <TableToolbarSearch
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search"
            persistent
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
        <div className="users-content">
          {users.length === 0 ? (
            <div className="empty-state">
              <UserMultiple size={64} />
              <h3>No users available</h3>
              <p>
                Looks like you haven't added any users. Click{' '}
                <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                {' '}to get started.
              </p>
            </div>
          ) : (
            <div className="users-grid">
              {users.map((user) => (
                <Tile
                  key={user.id}
                  className="user-tile"
                  onClick={() => handleRowClick(user)}
                >
                  {/* Icon Header */}
                  <div className="tile-icon-header">
                    <UserMultiple size={48} />
                  </div>

                  {/* Content */}
                  <div className="tile-content">
                    <div className="tile-header">
                      <h3>{user.name}</h3>
                      <Tag type={user.active ? 'green' : 'gray'} size="sm">
                        {user.active ? 'Active' : 'Inactive'}
                      </Tag>
                    </div>

                    {user.email && (
                      <div className="tile-email">{user.email}</div>
                    )}

                    <div className="tile-capabilities">
                      {(user.capabilities || []).map((cap) => (
                        <Tag key={cap} type={getCapabilityColor(cap)} size="sm">
                          {cap.toUpperCase()}
                        </Tag>
                      ))}
                    </div>

                    <div className="tile-date">
                      Updated: {formatDate(user.updated)}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="tile-actions">
                    <IconButton
                      kind="ghost"
                      label="Edit"
                      onClick={(e) => { e.stopPropagation(); handleRowClick(user); }}
                      size="sm"
                    >
                      <Edit size={16} />
                    </IconButton>
                    <IconButton
                      kind="ghost"
                      label="Delete"
                      onClick={(e) => handleDelete(e, user)}
                      size="sm"
                    >
                      <TrashCan size={16} />
                    </IconButton>
                  </div>
                </Tile>
              ))}
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
                          <UserMultiple size={64} />
                          <h3>No users available</h3>
                          <p>
                            Looks like you haven't added any users. Click{' '}
                            <Link href="#" onClick={(e) => { e.preventDefault(); handleCreate(); }}>Create</Link>
                            {' '}to get started.
                          </p>
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : (
                    rows.map((row) => {
                      const user = getUserById(row.id);
                      if (!user) return null; // guard transient refetch row/lookup mismatch
                      return (
                        <TableRow
                          {...getRowProps({ row })}
                          key={row.id}
                          onClick={() => handleRowClick(user)}
                          className="clickable-row"
                        >
                          {row.cells.map((cell) => {
                            if (cell.info.header === 'capabilities') {
                              return (
                                <TableCell key={cell.id}>
                                  <div className="capabilities-cell">
                                    {(cell.value || []).map((cap) => (
                                      <Tag key={cap} type={getCapabilityColor(cap)} size="sm">
                                        {cap.toUpperCase()}
                                      </Tag>
                                    ))}
                                  </div>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'active') {
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={cell.value ? 'green' : 'gray'} size="sm">
                                    {cell.value ? 'Active' : 'Inactive'}
                                  </Tag>
                                </TableCell>
                              );
                            }
                            if (cell.info.header === 'actions') {
                              return (
                                <TableCell key={cell.id} className="actions-cell">
                                  <IconButton
                                    kind="ghost"
                                    label="Delete"
                                    onClick={(e) => handleDelete(e, user)}
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

export default UsersListPage;
