// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import {
  Select,
  SelectItem,
  TextInput,
  TextArea,
  NumberInput,
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  Checkbox,
  Column,
  Grid,
} from '@carbon/react';
import { Play } from '@carbon/icons-react';
import api from '../api/client';
import './EdgeLakeQueryBuilder.scss';

/**
 * EdgeLakeQueryBuilder - Visual query builder for EdgeLake data sources
 *
 * Features:
 * - Cascading database -> table -> column discovery
 * - Column selection for SELECT clause
 * - WHERE clause builder
 * - ORDER BY, LIMIT controls
 * - Extended fields (+ip, +hostname, @table_name)
 * - Generated SQL preview
 * - Execute query
 */

function EdgeLakeQueryBuilder({ connectionId, onQueryChange, onDatabaseChange, onExecute, initialQuery: _initialQuery, initialDatabase }) {
  // Schema state
  const [databases, setDatabases] = useState([]);
  const [tables, setTables] = useState([]);
  const [columns, setColumns] = useState([]);
  const [selectedDatabase, setSelectedDatabase] = useState(initialDatabase || '');
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedColumns, setSelectedColumns] = useState([]);

  // Query options
  const [whereClause, setWhereClause] = useState('');
  const [orderBy, setOrderBy] = useState('');
  const [limit, setLimit] = useState(1000);
  const [includeIp, setIncludeIp] = useState(false);
  const [includeHostname, setIncludeHostname] = useState(false);
  const [includeTableName, setIncludeTableName] = useState(false);

  // Loading/error state
  const [loadingDatabases, setLoadingDatabases] = useState(false);
  const [loadingTables, setLoadingTables] = useState(false);
  const [loadingColumns, setLoadingColumns] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState(null);

  // Fetch databases on mount
  useEffect(() => {
    if (connectionId) {
      fetchDatabases();
    }
  }, [connectionId]);

  // Fetch tables when database changes
  useEffect(() => {
    if (selectedDatabase) {
      fetchTables(selectedDatabase);
    } else {
      setTables([]);
      setSelectedTable('');
      setColumns([]);
      setSelectedColumns([]);
    }
  }, [selectedDatabase]);

  // Fetch columns when table changes
  useEffect(() => {
    if (selectedDatabase && selectedTable) {
      fetchColumns(selectedDatabase, selectedTable);
    } else {
      setColumns([]);
      setSelectedColumns([]);
    }
  }, [selectedTable]);

  // Update query whenever selections change
  useEffect(() => {
    const query = buildQuery();
    if (onQueryChange && query) {
      onQueryChange(query);
    }
  }, [selectedDatabase, selectedTable, selectedColumns, whereClause, orderBy, limit, includeIp, includeHostname, includeTableName]);

  const fetchDatabases = async () => {
    setLoadingDatabases(true);
    setError(null);
    try {
      const response = await api.getEdgeLakeDatabases(connectionId);
      setDatabases(response.databases || []);
    } catch (err) {
      setError(`Failed to fetch databases: ${err.message}`);
      setDatabases([]);
    } finally {
      setLoadingDatabases(false);
    }
  };

  const fetchTables = async (database) => {
    setLoadingTables(true);
    setError(null);
    try {
      const response = await api.getEdgeLakeTables(connectionId, database);
      setTables(response.tables || []);
    } catch (err) {
      setError(`Failed to fetch tables: ${err.message}`);
      setTables([]);
    } finally {
      setLoadingTables(false);
    }
  };

  const fetchColumns = async (database, table) => {
    setLoadingColumns(true);
    setError(null);
    try {
      const response = await api.getEdgeLakeSchema(connectionId, database, table);
      setColumns(response.columns || []);
    } catch (err) {
      setError(`Failed to fetch columns: ${err.message}`);
      setColumns([]);
    } finally {
      setLoadingColumns(false);
    }
  };

  const buildQuery = () => {
    if (!selectedTable) return '';

    let parts = ['SELECT'];

    // Extended fields
    const extendFields = [];
    if (includeIp) extendFields.push('+ip');
    if (includeHostname) extendFields.push('+hostname');
    if (includeTableName) extendFields.push('@table_name');

    if (extendFields.length > 0) {
      parts.push(extendFields.join(', ') + ',');
    }

    // Columns
    if (selectedColumns.length > 0) {
      parts.push(selectedColumns.join(', '));
    } else {
      parts.push('*');
    }

    // FROM
    parts.push('FROM', selectedTable);

    // WHERE
    if (whereClause.trim()) {
      parts.push('WHERE', whereClause.trim());
    }

    // ORDER BY
    if (orderBy.trim()) {
      parts.push('ORDER BY', orderBy.trim());
    }

    // LIMIT
    if (limit > 0) {
      parts.push('LIMIT', String(limit));
    }

    return parts.join(' ');
  };

  const generatedQuery = useMemo(() => buildQuery(), [
    selectedTable, selectedColumns, whereClause, orderBy, limit,
    includeIp, includeHostname, includeTableName
  ]);

  const handleExecute = async () => {
    if (!selectedDatabase || !selectedTable) {
      setError('Please select a database and table');
      return;
    }

    setExecuting(true);
    setError(null);

    try {
      const query = buildQuery();
      const response = await api.queryConnection(connectionId, {
        query: {
          raw: query,
          type: 'edgelake',
          params: { database: selectedDatabase }
        }
      });

      if (onExecute) {
        onExecute(response);
      }
    } catch (err) {
      setError(`Query failed: ${err.message}`);
      if (onExecute) {
        onExecute({ success: false, error: err.message });
      }
    } finally {
      setExecuting(false);
    }
  };

  const toggleColumn = (colName) => {
    setSelectedColumns(prev => {
      if (prev.includes(colName)) {
        return prev.filter(c => c !== colName);
      }
      return [...prev, colName];
    });
  };

  return (
    <div className="edgelake-query-builder">
      {error && (
        <InlineNotification
          kind="error"
          title="Error"
          subtitle={error}
          lowContrast
          hideCloseButton
          onClose={() => setError(null)}
        />
      )}

      <Grid narrow>
        {/* Database selector */}
        <Column lg={6} md={4} sm={4}>
          <div className="field-with-loading">
            <Select
              id="edgelake-database"
              labelText="Database"
              value={selectedDatabase}
              onChange={(e) => {
                setSelectedDatabase(e.target.value);
                setSelectedTable('');
                if (onDatabaseChange) onDatabaseChange(e.target.value);
              }}
              disabled={loadingDatabases || databases.length === 0}
            >
              <SelectItem value="" text={loadingDatabases ? 'Loading...' : 'Select database'} />
              {databases.map(db => (
                <SelectItem key={db} value={db} text={db} />
              ))}
            </Select>
            {loadingDatabases && <InlineLoading description="Loading databases..." />}
          </div>
        </Column>

        {/* Table selector */}
        <Column lg={6} md={4} sm={4}>
          <div className="field-with-loading">
            <Select
              id="edgelake-table"
              labelText="Table"
              value={selectedTable}
              onChange={(e) => setSelectedTable(e.target.value)}
              disabled={!selectedDatabase || loadingTables || tables.length === 0}
            >
              <SelectItem value="" text={loadingTables ? 'Loading...' : 'Select table'} />
              {tables.map(tbl => (
                <SelectItem key={tbl} value={tbl} text={tbl} />
              ))}
            </Select>
            {loadingTables && <InlineLoading description="Loading tables..." />}
          </div>
        </Column>
      </Grid>

      {/* Column selection */}
      {columns.length > 0 && (
        <div className="columns-section">
          <div className="columns-header">
            <span className="columns-label">Columns</span>
            <span className="columns-hint">
              {selectedColumns.length === 0 ? 'All columns (SELECT *)' : `${selectedColumns.length} selected`}
            </span>
          </div>
          <div className="columns-list">
            {columns.map(col => (
              <Tag
                key={col.name}
                type={selectedColumns.includes(col.name) ? 'blue' : 'cool-gray'}
                size="md"
                onClick={() => toggleColumn(col.name)}
                className="column-tag"
              >
                {col.name} <span className="column-type">{col.type}</span>
              </Tag>
            ))}
          </div>
          {loadingColumns && <InlineLoading description="Loading columns..." />}
        </div>
      )}

      {/* WHERE / ORDER BY / LIMIT */}
      {selectedTable && (
        <div className="query-options">
          <TextInput
            id="edgelake-where"
            labelText="WHERE Clause (optional)"
            value={whereClause}
            onChange={(e) => setWhereClause(e.target.value)}
            placeholder="e.g., timestamp > NOW() - 1 hour"
          />

          <Grid narrow>
            <Column lg={8} md={4} sm={4}>
              <TextInput
                id="edgelake-orderby"
                labelText="ORDER BY (optional)"
                value={orderBy}
                onChange={(e) => setOrderBy(e.target.value)}
                placeholder="e.g., timestamp DESC"
              />
            </Column>
            <Column lg={4} md={4} sm={4}>
              <NumberInput
                id="edgelake-limit"
                label="Limit"
                value={limit}
                onChange={(e, { value }) => setLimit(value)}
                min={1}
                max={100000}
              />
            </Column>
          </Grid>

          <div className="extend-fields">
            <span className="extend-label">Extended Fields</span>
            <div className="extend-options">
              <Checkbox
                id="edgelake-extend-ip"
                labelText="Node IP (+ip)"
                checked={includeIp}
                onChange={(_, { checked }) => setIncludeIp(checked)}
              />
              <Checkbox
                id="edgelake-extend-hostname"
                labelText="Hostname (+hostname)"
                checked={includeHostname}
                onChange={(_, { checked }) => setIncludeHostname(checked)}
              />
              <Checkbox
                id="edgelake-extend-tablename"
                labelText="Table name (@table_name)"
                checked={includeTableName}
                onChange={(_, { checked }) => setIncludeTableName(checked)}
              />
            </div>
          </div>
        </div>
      )}

      {/* Generated query preview */}
      {generatedQuery && (
        <div className="query-preview">
          <div className="preview-header">
            <span className="preview-label">Generated Query</span>
            <Button
              kind="tertiary"
              size="sm"
              renderIcon={Play}
              onClick={handleExecute}
              disabled={executing || !selectedTable}
            >
              {executing ? 'Running...' : 'Execute'}
            </Button>
          </div>
          <pre className="preview-code">{generatedQuery}</pre>
        </div>
      )}
    </div>
  );
}

export default EdgeLakeQueryBuilder;
