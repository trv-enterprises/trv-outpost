// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
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
  InlineNotification,
} from '@carbon/react';
import { TrashCan, Password } from '@carbon/icons-react';
import apiClient from '../api/client';
import ApiKeyCreateModal from '../components/ApiKeyCreateModal';
import './ApiKeysListPage.scss';

/**
 * ApiKeysListPage
 *
 * Per-user API keys for non-browser callers (the dashboard-agent
 * CLI, MCP clients, scripts). Each key carries the full capability
 * set of its owner — there are no per-key scopes today; that's a
 * future enhancement called out in the v0.10.0 plan.
 *
 * The plaintext token is shown exactly once (in the create modal)
 * and never returned again. Only the bcrypt hash and a short
 * plaintext prefix live in the database.
 */
function ApiKeysListPage() {
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortKey, setSortKey] = useState('created');
  const [sortDirection, setSortDirection] = useState('desc');
  const [createModalOpen, setCreateModalOpen] = useState(false);

  useEffect(() => {
    fetchKeys();
  }, []);

  const fetchKeys = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await apiClient.getAPIKeys();
      setKeys(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleRevoke = async (e, key) => {
    e.stopPropagation();
    const confirmMsg = `Revoke API key "${key.name}"? Anything using it will immediately stop working.`;
    if (!window.confirm(confirmMsg)) return;
    try {
      await apiClient.revokeAPIKey(key.id);
      fetchKeys();
    } catch (err) {
      setError(err.message);
    }
  };

  const handleCreated = () => {
    setCreateModalOpen(false);
    fetchKeys();
  };

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDirection(key === 'name' ? 'asc' : 'desc');
    }
  };

  const formatDate = (value) => {
    if (!value) return '—';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  };

  const filteredAndSortedKeys = useMemo(() => {
    let result = [...keys];
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (k) =>
          k.name?.toLowerCase().includes(term) ||
          k.prefix?.toLowerCase().includes(term),
      );
    }
    result.sort((a, b) => {
      let aVal = a[sortKey];
      let bVal = b[sortKey];
      if (sortKey === 'created' || sortKey === 'last_used' || sortKey === 'expires_at') {
        aVal = aVal ? new Date(aVal).getTime() : 0;
        bVal = bVal ? new Date(bVal).getTime() : 0;
      } else {
        aVal = String(aVal || '').toLowerCase();
        bVal = String(bVal || '').toLowerCase();
      }
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return result;
  }, [keys, searchTerm, sortKey, sortDirection]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'prefix', header: 'Prefix', isSortable: false },
    { key: 'status', header: 'Status', isSortable: false },
    { key: 'created', header: 'Created', isSortable: true },
    { key: 'last_used', header: 'Last used', isSortable: true },
    { key: 'expires_at', header: 'Expires', isSortable: true },
    { key: 'actions', header: '', isSortable: false },
  ];

  const rows = filteredAndSortedKeys.map((k) => ({
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    status: k.revoked ? 'revoked' : 'active',
    created: formatDate(k.created),
    last_used: formatDate(k.last_used),
    expires_at: k.expires_at ? formatDate(k.expires_at) : 'Never',
  }));

  const getKeyById = (id) => keys.find((k) => k.id === id);

  if (loading) {
    return (
      <div className="api-keys-page">
        <Loading description="Loading API keys..." withOverlay={false} />
      </div>
    );
  }

  return (
    <div className="api-keys-page">
      <div className="page-header">
        <h1>API Keys</h1>
        <p className="page-description">
          Personal authentication tokens for non-browser callers — the
          dashboard-agent CLI, MCP clients, and scripts. Pass the token
          as <code>Authorization: Bearer &lt;token&gt;</code>. Each key
          inherits the full capability set of your user account.{' '}
          <Link href="/docs/mcp" target="_blank" rel="noopener noreferrer">
            Learn more
          </Link>
          .
        </p>
      </div>

      {error && (
        <div className="page-error">
          <InlineNotification
            kind="error"
            title="Failed to load API keys"
            subtitle={error}
            onCloseButtonClick={() => setError(null)}
            lowContrast
          />
        </div>
      )}

      <div className="page-toolbar">
        <div className="toolbar-left">
          <TableToolbarSearch
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Search"
            persistent
          />
        </div>
        <div className="toolbar-actions">
          <Button onClick={() => setCreateModalOpen(true)} size="md" kind="primary">
            New API key
          </Button>
        </div>
      </div>

      <DataTable rows={rows} headers={headers} isSortable>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer>
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => (
                    <TableHeader
                      {...getHeaderProps({ header })}
                      key={header.key}
                      isSortable={header.isSortable}
                      isSortHeader={sortKey === header.key}
                      sortDirection={
                        sortKey === header.key ? sortDirection.toUpperCase() : 'NONE'
                      }
                      onClick={() => header.isSortable && handleSort(header.key)}
                    >
                      {header.header}
                    </TableHeader>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={headers.length}>
                      <div className="empty-state">
                        <Password size={64} />
                        <h3>No API keys yet</h3>
                        <p>
                          Click{' '}
                          <Link
                            href="#"
                            onClick={(e) => {
                              e.preventDefault();
                              setCreateModalOpen(true);
                            }}
                          >
                            New API key
                          </Link>{' '}
                          to create one. The plaintext token will be shown once and
                          can't be recovered later.
                        </p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  tableRows.map((row) => {
                    const key = getKeyById(row.id);
                    return (
                      <TableRow {...getRowProps({ row })} key={row.id}>
                        {row.cells.map((cell) => {
                          if (cell.info.header === 'prefix') {
                            return (
                              <TableCell key={cell.id}>
                                <code className="prefix-code">trve_{cell.value}…</code>
                              </TableCell>
                            );
                          }
                          if (cell.info.header === 'status') {
                            return (
                              <TableCell key={cell.id}>
                                <Tag type={cell.value === 'active' ? 'green' : 'gray'} size="sm">
                                  {cell.value === 'active' ? 'Active' : 'Revoked'}
                                </Tag>
                              </TableCell>
                            );
                          }
                          if (cell.info.header === 'actions') {
                            return (
                              <TableCell key={cell.id} className="actions-cell">
                                {!key.revoked && (
                                  <IconButton
                                    kind="ghost"
                                    label="Revoke"
                                    onClick={(e) => handleRevoke(e, key)}
                                    size="sm"
                                  >
                                    <TrashCan size={16} />
                                  </IconButton>
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

      {createModalOpen && (
        <ApiKeyCreateModal
          onClose={() => setCreateModalOpen(false)}
          onCreated={handleCreated}
        />
      )}
    </div>
  );
}

export default ApiKeysListPage;
