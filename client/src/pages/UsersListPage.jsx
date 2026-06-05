// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
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
  Toggle
} from '@carbon/react';
import { TrashCan, UserMultiple, List, Grid, Edit } from '@carbon/icons-react';
import apiClient from '../api/client';
import { getListPrefs, setListPrefs } from '../utils/listPrefs';
import './UsersListPage.scss';

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
  const [users, setUsers] = useState([]);
  const savedPrefs = getListPrefs('users');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState(savedPrefs.sortKey || 'name');
  const [sortDirection, setSortDirection] = useState(savedPrefs.sortDir || 'asc');
  const [viewMode, setViewMode] = useState(savedPrefs.view || 'list'); // 'list' or 'tile'

  // Persist user-level preferences to user config
  useEffect(() => {
    setListPrefs('users', { view: viewMode, sortKey, sortDir: sortDirection });
  }, [viewMode, sortKey, sortDirection]);

  // Get color for capability tag
  const getCapabilityColor = (capability) => {
    const colors = {
      'view': 'gray',
      'design': 'blue',
      'manage': 'purple'
    };
    return colors[capability?.toLowerCase()] || 'gray';
  };

  // Fetch users from API
  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const data = await apiClient.getUsers();

      if (data.users) {
        setUsers(data.users);
      } else if (data.error) {
        setError(data.error);
      } else {
        setUsers([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

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
        fetchUsers();
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

  // Filter and sort users
  const filteredAndSortedUsers = useMemo(() => {
    let result = [...users];

    // Filter by search term
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(user =>
        user.name?.toLowerCase().includes(term) ||
        user.email?.toLowerCase().includes(term) ||
        user.capabilities?.some(c => c.toLowerCase().includes(term))
      );
    }

    // Sort
    result.sort((a, b) => {
      let aVal = a[sortKey] || '';
      let bVal = b[sortKey] || '';

      // Handle date sorting
      if (sortKey === 'updated') {
        aVal = new Date(aVal).getTime() || 0;
        bVal = new Date(bVal).getTime() || 0;
      } else if (sortKey === 'capabilities') {
        aVal = (a.capabilities || []).join(',');
        bVal = (b.capabilities || []).join(',');
      } else {
        aVal = String(aVal).toLowerCase();
        bVal = String(bVal).toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });

    return result;
  }, [users, searchTerm, sortKey, sortDirection]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'email', header: 'Email', isSortable: true },
    { key: 'capabilities', header: 'Capabilities', isSortable: true },
    { key: 'active', header: 'Status', isSortable: true },
    { key: 'updated', header: 'Last modified', isSortable: true },
    { key: 'actions', header: '', isSortable: false }
  ];

  const rows = filteredAndSortedUsers.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email || '',
    capabilities: user.capabilities || [],
    active: user.active,
    updated: formatDate(user.updated)
  }));

  const getUserById = (id) => users.find(u => u.id === id);

  if (loading) {
    return (
      <div className="users-page">
        <Loading description="Loading users..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
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
          {filteredAndSortedUsers.length === 0 ? (
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
              {filteredAndSortedUsers.map((user) => (
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
            </TableContainer>
          )}
        </DataTable>
      )}
    </div>
  );
}

export default UsersListPage;
