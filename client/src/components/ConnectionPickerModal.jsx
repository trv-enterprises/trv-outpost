// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import PropTypes from 'prop-types';
import {
  Modal,
  DataTable,
  Table,
  TableHead,
  TableRow,
  TableHeader,
  TableBody,
  TableCell,
  Search,
  Dropdown,
  Tag,
  Loading,
} from '@carbon/react';
import apiClient from '../api/client';
import TagFilter from './shared/TagFilter';
import NamespaceFilter from './shared/NamespaceFilter';
import NamespaceChip from './shared/NamespaceChip';
import ResetFiltersButton from './shared/ResetFiltersButton';
import { connectionTypeLabel, connectionTypeColor } from '../utils/connectionTypeMeta';
import './ConnectionPickerModal.scss';

// Type filter options. Mirrors the connections list page; 'all' first.
const TYPE_FILTER_ITEMS = [
  { id: 'all', text: 'All Types' },
  { id: 'sql', text: 'SQL Database' },
  { id: 'api', text: 'REST API' },
  { id: 'csv', text: 'CSV File' },
  { id: 'socket', text: 'WebSocket' },
  { id: 'mqtt', text: 'MQTT' },
  { id: 'tsstore', text: 'ts-store' },
  { id: 'prometheus', text: 'Prometheus' },
  { id: 'edgelake', text: 'EdgeLake' },
  { id: 'frigate', text: 'Frigate' },
];

/**
 * ConnectionPickerModal — pick a connection for the component editor.
 *
 * Modeled on the connections list screen (list view): a sortable DataTable
 * with the same filters (search, namespace, type, tag). Trimmed for picking:
 * no Components / Last-modified / delete columns, no tile view. Description is
 * truncated to fit. Clicking a row selects that connection and closes.
 *
 * @param {boolean}  open
 * @param {Function} onClose
 * @param {Function} onSelect       (connection) => void
 * @param {string}   selectedId     currently-selected connection id (row highlight)
 */
function ConnectionPickerModal({ open, onClose, onSelect, selectedId = '' }) {
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState([]);
  const [namespaceFilter, setNamespaceFilter] = useState([]);
  const [sortKey, setSortKey] = useState('name');
  const [sortDirection, setSortDirection] = useState('asc');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    // Reset transient filter state each open so a reopened picker starts clean.
    setSearchTerm('');
    setTypeFilter('all');
    setTagFilter([]);
    setNamespaceFilter([]);
    apiClient
      .getConnections({ page: 1, page_size: 500 })
      .then((res) => {
        if (cancelled) return;
        setConnections(res?.connections || res?.Connections || []);
      })
      .catch(() => { if (!cancelled) setConnections([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const headers = [
    { key: 'name', header: 'Name', isSortable: true },
    { key: 'namespace', header: 'Namespace', isSortable: true },
    { key: 'type', header: 'Type', isSortable: true },
    { key: 'tags', header: 'Tags', isSortable: false },
    { key: 'description', header: 'Description', isSortable: false },
  ];

  const filtered = useMemo(() => {
    let result = [...connections];
    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      result = result.filter((c) => !c.namespace || wanted.has(c.namespace));
    }
    if (typeFilter !== 'all') {
      result = result.filter((c) => c.type?.toLowerCase() === typeFilter);
    }
    if (tagFilter.length > 0) {
      result = result.filter((c) => {
        const t = c.tags || [];
        return tagFilter.some((x) => t.includes(x));
      });
    }
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter((c) =>
        c.name?.toLowerCase().includes(term) ||
        c.description?.toLowerCase().includes(term) ||
        c.type?.toLowerCase().includes(term));
    }
    result.sort((a, b) => {
      let aVal = String(a[sortKey] || '').toLowerCase();
      let bVal = String(b[sortKey] || '').toLowerCase();
      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
    return result;
  }, [connections, searchTerm, typeFilter, tagFilter, namespaceFilter, sortKey, sortDirection]);

  // Map to DataTable rows; keep the raw connection alongside for selection.
  // Tags stay an array so cells render chips (not a joined string).
  const byId = useMemo(() => {
    const m = {};
    connections.forEach((c) => { m[c.id] = c; });
    return m;
  }, [connections]);

  const rows = filtered.map((c) => ({
    id: c.id,
    name: c.name,
    namespace: c.namespace || 'default',
    type: c.type,
    tags: Array.isArray(c.tags) ? c.tags : [],
    description: c.description || '',
  }));

  const filtersActive = !!searchTerm || namespaceFilter.length > 0 || typeFilter !== 'all' || tagFilter.length > 0;

  const handleRowClick = (id) => {
    const conn = byId[id];
    if (conn) onSelect?.(conn);
    onClose?.();
  };

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDirection('asc');
    }
  };

  return (
    <Modal
      open={open}
      onRequestClose={onClose}
      modalHeading="Select a connection"
      passiveModal
      size="lg"
      className="connection-picker-modal"
    >
      {/* Toolbar is a SEPARATE area above the table (mirrors the connections
          list page's .page-toolbar) — NOT inside Carbon's TableToolbar, which
          cramped the filters, clipped the namespace popover, and added a stray
          border under the search row. Filters are left-aligned; search is the
          same modest width as the editor's. */}
      <div className="conn-picker-toolbar">
        <div className="conn-picker-toolbar-left">
          <Search
            id="conn-picker-search"
            labelText=""
            size="md"
            placeholder="Search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          <NamespaceFilter
            id="conn-picker-namespace-filter"
            selected={namespaceFilter}
            onChange={setNamespaceFilter}
          />
          <Dropdown
            id="conn-picker-type-filter"
            label="Filter by type"
            titleText=""
            items={TYPE_FILTER_ITEMS}
            itemToString={(item) => item?.text || ''}
            selectedItem={TYPE_FILTER_ITEMS.find((t) => t.id === typeFilter) || TYPE_FILTER_ITEMS[0]}
            onChange={({ selectedItem }) => setTypeFilter(selectedItem?.id || 'all')}
            size="md"
          />
          <TagFilter
            entityType="connections"
            selected={tagFilter}
            onChange={setTagFilter}
          />
          <ResetFiltersButton
            active={filtersActive}
            onReset={() => {
              setSearchTerm('');
              setNamespaceFilter([]);
              setTypeFilter('all');
              setTagFilter([]);
            }}
          />
        </div>
      </div>

      {loading ? (
        <div className="conn-picker-loading"><Loading withOverlay={false} /></div>
      ) : (
        <DataTable rows={rows} headers={headers}>
          {({ rows: dtRows, headers: dtHeaders, getHeaderProps, getRowProps, getTableProps }) => (
            <div className="conn-picker-table-container">
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {dtHeaders.map((header) => {
                      const { key, ...headerProps } = getHeaderProps({ header });
                      return (
                        <TableHeader
                          key={key}
                          {...headerProps}
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
                  {dtRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={headers.length} className="conn-picker-empty">
                        No connections match the filters.
                      </TableCell>
                    </TableRow>
                  ) : (
                    dtRows.map((row) => {
                      const { key, ...rowProps } = getRowProps({ row });
                      return (
                        <TableRow
                          key={key}
                          {...rowProps}
                          onClick={() => handleRowClick(row.id)}
                          className={`conn-picker-row${row.id === selectedId ? ' conn-picker-row--selected' : ''}`}
                        >
                          {row.cells.map((cell) => {
                            const colKey = cell.info.header;
                            if (colKey === 'namespace') {
                              return (
                                <TableCell key={cell.id} className="conn-picker-namespace-cell">
                                  <NamespaceChip name={cell.value} />
                                </TableCell>
                              );
                            }
                            if (colKey === 'type') {
                              return (
                                <TableCell key={cell.id}>
                                  <Tag type={connectionTypeColor(cell.value)} size="md">
                                    {connectionTypeLabel(cell.value)}
                                  </Tag>
                                </TableCell>
                              );
                            }
                            if (colKey === 'tags') {
                              const tags = Array.isArray(cell.value) ? cell.value : [];
                              return (
                                <TableCell key={cell.id} className="conn-picker-tags-cell">
                                  {tags.slice(0, 3).map((t) => (
                                    <Tag key={t} type="blue" size="sm">{t}</Tag>
                                  ))}
                                  {tags.length > 3 && <span className="conn-picker-tags-more">+{tags.length - 3}</span>}
                                </TableCell>
                              );
                            }
                            if (colKey === 'description') {
                              return (
                                <TableCell key={cell.id} className="conn-picker-desc-cell" title={cell.value}>
                                  {cell.value}
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
            </div>
          )}
        </DataTable>
      )}
    </Modal>
  );
}

ConnectionPickerModal.propTypes = {
  open: PropTypes.bool,
  onClose: PropTypes.func,
  onSelect: PropTypes.func,
  selectedId: PropTypes.string,
};

export default ConnectionPickerModal;
