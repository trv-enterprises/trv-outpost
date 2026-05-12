// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback } from 'react';
import {
  Select,
  SelectItem,
  TextInput,
  NumberInput,
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  IconButton,
  Accordion,
  AccordionItem,
} from '@carbon/react';
import { Add, TrashCan, Play, Copy } from '@carbon/icons-react';
import api from '../api/client';
import { copyTextToClipboard } from '../utils/clipboard';
import './SQLQueryBuilder.scss';

/**
 * SQLQueryBuilder - Visual SQL SELECT statement builder
 *
 * Features:
 * - Fetches database schema from SQL datasources
 * - Table and column selection
 * - WHERE clause builder with multiple conditions
 * - ORDER BY support
 * - LIMIT/OFFSET support
 * - Generated SQL preview
 * - Copy to clipboard
 * - Execute query
 */
const SQLQueryBuilder = ({
  connectionId,
  onQueryChange,
  onExecute,
  initialQuery: _initialQuery = '',
  disabled = false
}) => {
  // Schema state
  const [schema, setSchema] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Query builder state
  const [selectedTable, setSelectedTable] = useState('');
  const [selectedColumns, setSelectedColumns] = useState([]); // Array of {column, aggregate} objects
  const [whereConditions, setWhereConditions] = useState([]);
  const [groupByColumns, setGroupByColumns] = useState([]); // Columns to group by
  const [orderBy, setOrderBy] = useState({ column: '', direction: 'ASC' });
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);

  // Generated query
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [queryResults, setQueryResults] = useState(null);
  const [executing, setExecuting] = useState(false);

  // Fetch schema when datasource changes
  useEffect(() => {
    if (connectionId) {
      fetchSchema();
    }
  }, [connectionId]);

  // Build query whenever options change
  useEffect(() => {
    const query = buildQuery();
    setGeneratedQuery(query);
    if (onQueryChange) {
      onQueryChange(query);
    }
  }, [selectedTable, selectedColumns, whereConditions, groupByColumns, orderBy, limit, offset]);

  const fetchSchema = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getConnectionSchema(connectionId);
      if (response.success) {
        setSchema(response.schema);
      } else {
        setError(response.error || 'Failed to fetch schema');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch schema');
    } finally {
      setLoading(false);
    }
  };

  const buildQuery = () => {
    if (!selectedTable) return '';

    // SELECT clause - handle aggregates
    let columnsClause;
    if (selectedColumns.length > 0) {
      columnsClause = selectedColumns.map(col => {
        if (typeof col === 'string') {
          // Legacy format (just column name)
          return col;
        }
        // New format with optional aggregate: {column, aggregate}
        if (col.aggregate && col.aggregate !== '') {
          return `${col.aggregate}(${col.column}) AS ${col.column}_${col.aggregate.toLowerCase()}`;
        }
        return col.column;
      }).join(', ');
    } else {
      columnsClause = '*';
    }

    let query = `SELECT ${columnsClause}\nFROM ${selectedTable}`;

    // WHERE clause
    if (whereConditions.length > 0) {
      const validConditions = whereConditions.filter(c => c.column && c.operator && c.value !== '');
      if (validConditions.length > 0) {
        const whereParts = validConditions.map((c, idx) => {
          const prefix = idx > 0 ? ` ${c.logic || 'AND'} ` : '';
          const value = c.operator === 'IN' || c.operator === 'NOT IN'
            ? `(${c.value})`
            : c.operator === 'IS NULL' || c.operator === 'IS NOT NULL'
            ? ''
            : `'${c.value}'`;
          return `${prefix}${c.column} ${c.operator} ${value}`;
        });
        query += `\nWHERE ${whereParts.join('')}`;
      }
    }

    // GROUP BY clause
    if (groupByColumns.length > 0) {
      query += `\nGROUP BY ${groupByColumns.join(', ')}`;
    }

    // ORDER BY clause
    if (orderBy.column) {
      query += `\nORDER BY ${orderBy.column} ${orderBy.direction}`;
    }

    // LIMIT and OFFSET
    if (limit > 0) {
      query += `\nLIMIT ${limit}`;
      if (offset > 0) {
        query += ` OFFSET ${offset}`;
      }
    }

    return query;
  };

  const handleTableChange = (e) => {
    const tableName = e.target.value;
    setSelectedTable(tableName);
    setSelectedColumns([]);
    setGroupByColumns([]);
    setWhereConditions([]);
    setOrderBy({ column: '', direction: 'ASC' });
  };

  // Add a column with optional aggregate
  const addColumn = (columnName, aggregate = '') => {
    setSelectedColumns(prev => {
      // Check if column already exists
      const exists = prev.some(c =>
        (typeof c === 'string' && c === columnName) ||
        (typeof c === 'object' && c.column === columnName)
      );
      if (exists) return prev;
      return [...prev, { column: columnName, aggregate }];
    });
  };

  // Remove a column
  const removeColumn = (columnName) => {
    setSelectedColumns(prev => prev.filter(c =>
      (typeof c === 'string' ? c : c.column) !== columnName
    ));
  };

  // Update aggregate function for a column
  const updateColumnAggregate = (columnName, aggregate) => {
    setSelectedColumns(prev => prev.map(c => {
      const name = typeof c === 'string' ? c : c.column;
      if (name === columnName) {
        return { column: name, aggregate };
      }
      return typeof c === 'string' ? { column: c, aggregate: '' } : c;
    }));
  };

  // Toggle GROUP BY column
  const toggleGroupByColumn = (columnName) => {
    setGroupByColumns(prev => {
      if (prev.includes(columnName)) {
        return prev.filter(c => c !== columnName);
      }
      return [...prev, columnName];
    });
  };

  const addWhereCondition = () => {
    setWhereConditions([
      ...whereConditions,
      { column: '', operator: '=', value: '', logic: 'AND' }
    ]);
  };

  const updateWhereCondition = (index, field, value) => {
    const updated = [...whereConditions];
    updated[index][field] = value;
    setWhereConditions(updated);
  };

  const removeWhereCondition = (index) => {
    setWhereConditions(whereConditions.filter((_, i) => i !== index));
  };

  const handleExecute = async () => {
    if (!generatedQuery || !connectionId) return;

    setExecuting(true);
    setQueryResults(null);
    try {
      const response = await api.queryConnection(connectionId, {
        query: { raw: generatedQuery, type: 'sql' }
      });
      setQueryResults(response);
      if (onExecute) {
        onExecute(response);
      }
    } catch (err) {
      setQueryResults({ success: false, error: err.message });
    } finally {
      setExecuting(false);
    }
  };

  const copyToClipboard = () => {
    copyTextToClipboard(generatedQuery).catch((err) => {
      console.warn('Copy query failed', err);
    });
  };

  // Get columns for selected table
  const getTableColumns = useCallback(() => {
    if (!schema || !selectedTable) return [];
    const table = schema.tables.find(t => t.name === selectedTable);
    return table ? table.columns : [];
  }, [schema, selectedTable]);

  const columns = getTableColumns();

  // Operators for WHERE conditions
  const operators = [
    { id: '=', label: '=' },
    { id: '!=', label: '!=' },
    { id: '>', label: '>' },
    { id: '<', label: '<' },
    { id: '>=', label: '>=' },
    { id: '<=', label: '<=' },
    { id: 'LIKE', label: 'LIKE' },
    { id: 'NOT LIKE', label: 'NOT LIKE' },
    { id: 'IN', label: 'IN' },
    { id: 'NOT IN', label: 'NOT IN' },
    { id: 'IS NULL', label: 'IS NULL' },
    { id: 'IS NOT NULL', label: 'IS NOT NULL' },
  ];

  if (loading) {
    return (
      <div className="sql-query-builder">
        <InlineLoading description="Loading schema..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="sql-query-builder">
        <InlineNotification
          kind="error"
          title="Schema Error"
          subtitle={error}
          hideCloseButton
        />
      </div>
    );
  }

  if (!schema) {
    return (
      <div className="sql-query-builder">
        <InlineNotification
          kind="info"
          title="No Schema"
          subtitle="Select a SQL datasource to build queries"
          hideCloseButton
        />
      </div>
    );
  }

  return (
    <div className="sql-query-builder">
      <div className="builder-sections">
        {/* Table Selection */}
        <div className="builder-section">
          <h4>Table</h4>
          <Select
            id="table-select"
            labelText="Select table"
            value={selectedTable}
            onChange={handleTableChange}
            disabled={disabled}
          >
            <SelectItem value="" text="Choose a table..." />
            {schema.tables.map(table => (
              <SelectItem
                key={table.name}
                value={table.name}
                text={table.schema ? `${table.schema}.${table.name}` : table.name}
              />
            ))}
          </Select>
        </div>

        {/* Column Selection with Aggregates */}
        {selectedTable && (
          <div className="builder-section">
            <div className="section-header">
              <h4>Columns</h4>
              <span className="section-hint">
                {selectedColumns.length === 0 ? 'All columns (*)' : `${selectedColumns.length} selected`}
              </span>
            </div>

            {/* Add column dropdown */}
            <div className="add-column-row">
              <Select
                id="add-column-select"
                labelText=""
                hideLabel
                size="sm"
                value=""
                onChange={(e) => {
                  if (e.target.value) {
                    addColumn(e.target.value);
                  }
                }}
                disabled={disabled}
              >
                <SelectItem value="" text="Add column..." />
                {columns
                  .filter(col => !selectedColumns.some(sc =>
                    (typeof sc === 'string' ? sc : sc.column) === col.name
                  ))
                  .map(col => (
                    <SelectItem key={col.name} value={col.name} text={`${col.name} (${col.type})`} />
                  ))}
              </Select>
            </div>

            {/* Selected columns with aggregate options */}
            {selectedColumns.length > 0 && (
              <div className="selected-columns-list">
                {selectedColumns.map((col) => {
                  const columnName = typeof col === 'string' ? col : col.column;
                  const aggregate = typeof col === 'string' ? '' : (col.aggregate || '');
                  return (
                    <div key={columnName} className="selected-column-row">
                      <span className="column-name">{columnName}</span>
                      <Select
                        id={`agg-${columnName}`}
                        labelText=""
                        hideLabel
                        size="sm"
                        value={aggregate}
                        onChange={(e) => updateColumnAggregate(columnName, e.target.value)}
                        disabled={disabled}
                        className="aggregate-select"
                      >
                        <SelectItem value="" text="No aggregate" />
                        <SelectItem value="COUNT" text="COUNT" />
                        <SelectItem value="SUM" text="SUM" />
                        <SelectItem value="AVG" text="AVG" />
                        <SelectItem value="MIN" text="MIN" />
                        <SelectItem value="MAX" text="MAX" />
                      </Select>
                      <IconButton
                        kind="ghost"
                        size="sm"
                        label="Remove"
                        onClick={() => removeColumn(columnName)}
                        disabled={disabled}
                      >
                        <TrashCan />
                      </IconButton>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* GROUP BY */}
        {selectedTable && selectedColumns.length > 0 && (
          <div className="builder-section">
            <div className="section-header">
              <h4>GROUP BY</h4>
              <span className="section-hint">
                {groupByColumns.length > 0 ? `${groupByColumns.length} columns` : 'None'}
              </span>
            </div>
            <div className="group-by-columns">
              {selectedColumns.map((col) => {
                const columnName = typeof col === 'string' ? col : col.column;
                const aggregate = typeof col === 'string' ? '' : (col.aggregate || '');
                // Only show non-aggregated columns as GROUP BY options
                if (aggregate) return null;
                return (
                  <Tag
                    key={columnName}
                    type={groupByColumns.includes(columnName) ? 'blue' : 'gray'}
                    size="sm"
                    onClick={() => !disabled && toggleGroupByColumn(columnName)}
                    className="group-by-tag"
                  >
                    {columnName}
                  </Tag>
                );
              })}
              {selectedColumns.every(col => (typeof col === 'string' ? '' : col.aggregate)) && (
                <span className="no-columns-hint">Add non-aggregated columns to enable GROUP BY</span>
              )}
            </div>
          </div>
        )}

        {/* WHERE Conditions */}
        {selectedTable && (
          <div className="builder-section">
            <div className="section-header">
              <h4>WHERE Conditions</h4>
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Add}
                onClick={addWhereCondition}
                disabled={disabled}
              >
                Add condition
              </Button>
            </div>
            {whereConditions.map((condition, index) => (
              <div key={index} className="where-condition">
                {index > 0 && (
                  <Select
                    id={`logic-${index}`}
                    labelText=""
                    hideLabel
                    size="sm"
                    value={condition.logic}
                    onChange={(e) => updateWhereCondition(index, 'logic', e.target.value)}
                    disabled={disabled}
                    className="logic-select"
                  >
                    <SelectItem value="AND" text="AND" />
                    <SelectItem value="OR" text="OR" />
                  </Select>
                )}
                <Select
                  id={`column-${index}`}
                  labelText=""
                  hideLabel
                  size="sm"
                  value={condition.column}
                  onChange={(e) => updateWhereCondition(index, 'column', e.target.value)}
                  disabled={disabled}
                  className="column-select"
                >
                  <SelectItem value="" text="Column..." />
                  {columns.map(col => (
                    <SelectItem key={col.name} value={col.name} text={col.name} />
                  ))}
                </Select>
                <Select
                  id={`operator-${index}`}
                  labelText=""
                  hideLabel
                  size="sm"
                  value={condition.operator}
                  onChange={(e) => updateWhereCondition(index, 'operator', e.target.value)}
                  disabled={disabled}
                  className="operator-select"
                >
                  {operators.map(op => (
                    <SelectItem key={op.id} value={op.id} text={op.label} />
                  ))}
                </Select>
                {condition.operator !== 'IS NULL' && condition.operator !== 'IS NOT NULL' && (
                  <TextInput
                    id={`value-${index}`}
                    labelText=""
                    hideLabel
                    size="sm"
                    placeholder="Value..."
                    value={condition.value}
                    onChange={(e) => updateWhereCondition(index, 'value', e.target.value)}
                    disabled={disabled}
                    className="value-input"
                  />
                )}
                <IconButton
                  kind="ghost"
                  size="sm"
                  label="Remove"
                  onClick={() => removeWhereCondition(index)}
                  disabled={disabled}
                >
                  <TrashCan />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        {/* ORDER BY */}
        {selectedTable && (
          <div className="builder-section">
            <h4>ORDER BY</h4>
            <div className="order-by-row">
              <Select
                id="orderby-column"
                labelText=""
                hideLabel
                size="sm"
                value={orderBy.column}
                onChange={(e) => setOrderBy({ ...orderBy, column: e.target.value })}
                disabled={disabled}
              >
                <SelectItem value="" text="None" />
                {columns.map(col => (
                  <SelectItem key={col.name} value={col.name} text={col.name} />
                ))}
              </Select>
              <Select
                id="orderby-direction"
                labelText=""
                hideLabel
                size="sm"
                value={orderBy.direction}
                onChange={(e) => setOrderBy({ ...orderBy, direction: e.target.value })}
                disabled={disabled || !orderBy.column}
              >
                <SelectItem value="ASC" text="Ascending" />
                <SelectItem value="DESC" text="Descending" />
              </Select>
            </div>
          </div>
        )}

        {/* LIMIT / OFFSET */}
        {selectedTable && (
          <div className="builder-section">
            <h4>LIMIT</h4>
            <div className="limit-row">
              <NumberInput
                id="limit"
                label="Limit"
                size="sm"
                min={0}
                max={10000}
                value={limit}
                onChange={(e, { value }) => setLimit(value)}
                disabled={disabled}
                className="compact-limit-input"
              />
              <NumberInput
                id="offset"
                label="Offset"
                size="sm"
                min={0}
                value={offset}
                onChange={(e, { value }) => setOffset(value)}
                disabled={disabled}
                className="compact-limit-input"
              />
            </div>
          </div>
        )}
      </div>

      {/* Generated SQL Preview */}
      {generatedQuery && (
        <div className="query-preview">
          <div className="preview-header">
            <h4>Generated SQL</h4>
            <div className="preview-actions">
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Copy}
                onClick={copyToClipboard}
              >
                Copy
              </Button>
              <Button
                kind="primary"
                size="sm"
                renderIcon={Play}
                onClick={handleExecute}
                disabled={executing || !connectionId}
              >
                {executing ? 'Executing...' : 'Execute'}
              </Button>
            </div>
          </div>
          <pre className="sql-code">{generatedQuery}</pre>
        </div>
      )}

      {/* Query Results */}
      {queryResults && (
        <Accordion>
          <AccordionItem title={`Results (${queryResults.success ? queryResults.result_set?.rows?.length || 0 : 'Error'} rows)`}>
            {queryResults.success ? (
              <div className="results-table-wrapper">
                <table className="results-table">
                  <thead>
                    <tr>
                      {queryResults.result_set?.columns?.map(col => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {queryResults.result_set?.rows?.slice(0, 20).map((row, idx) => (
                      <tr key={idx}>
                        {row.map((cell, cellIdx) => (
                          <td key={cellIdx}>{cell !== null ? String(cell) : 'NULL'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {queryResults.result_set?.rows?.length > 20 && (
                  <p className="results-truncated">
                    Showing 20 of {queryResults.result_set.rows.length} rows
                  </p>
                )}
              </div>
            ) : (
              <InlineNotification
                kind="error"
                title="Query Error"
                subtitle={queryResults.error}
                hideCloseButton
              />
            )}
          </AccordionItem>
        </Accordion>
      )}
    </div>
  );
};

export default SQLQueryBuilder;
