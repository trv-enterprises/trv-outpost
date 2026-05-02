// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import {
  TextInput,
  ContentSwitcher,
  Switch,
  Tag,
  Button,
  Loading
} from '@carbon/react';
import { Play, Edit, Checkmark, Close } from '@carbon/icons-react';
import Icon from '@mdi/react';
import DynamicComponentLoader from './DynamicComponentLoader';
import { ControlRenderer, CONTROL_TYPE_INFO } from './controls';
import { transformData } from '../utils/dataTransforms';
import apiClient from '../api/client';
import './AIComponentPreview.scss';

// Filter operator labels for display
const FILTER_OP_LABELS = {
  'eq': 'Equals (=)',
  'neq': 'Not Equals',
  'gt': '>',
  'gte': '>=',
  'lt': '<',
  'lte': '<=',
  'contains': 'Contains',
  'startsWith': 'Starts With',
  'endsWith': 'Ends With',
  'in': 'In',
  'notIn': 'Not In',
  'isNull': 'Is Null',
  'isNotNull': 'Is Not Null'
};

/**
 * AIComponentPreview Component
 *
 * Read-only preview of a component configuration created by AI.
 * Similar layout to ComponentEditor but without editing capabilities,
 * except for the component name which can be edited inline.
 */
function AIComponentPreview({ component, onNameChange }) {
  const [activeTab, setActiveTab] = useState(1); // Default to Preview tab
  const [connectionName, setConnectionName] = useState('');
  const [connectionType, setConnectionType] = useState('');
  const [connectionDescription, setConnectionDescription] = useState('');

  // Name editing state — inline-rename UI scaffolding (the
  // _start/_cancel/_confirm helpers below) is wired but no UI
  // currently triggers it. Kept underscore-prefixed so lint
  // doesn't flag unused while we decide whether to surface the
  // rename affordance or drop it.
  const [_editingName, setEditingName] = useState(false);
  const [editNameValue, setEditNameValue] = useState('');
  const [_nameError, setNameError] = useState('');

  // Preview data
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);

  // The wire format calls this `connection_id`; some callers pass it
  // through with the legacy `datasource_id` BSON name. Accept either
  // so the AI Builder preview works regardless of which side is
  // responsible for normalizing.
  const connectionId = component?.connection_id || component?.connection_id;

  // Fetch connection info when component changes
  useEffect(() => {
    const fetchConnectionInfo = async () => {
      if (connectionId) {
        try {
          const connection = await apiClient.getConnection(connectionId);
          setConnectionName(connection.name || connectionId);
          setConnectionType(connection.type || '');
          setConnectionDescription(connection.description || '');
        } catch (err) {
          console.error('Failed to fetch connection:', err);
          setConnectionName(connectionId);
        }
      } else {
        setConnectionName('');
        setConnectionType('');
        setConnectionDescription('');
      }
    };
    fetchConnectionInfo();
  }, [connectionId]);

  // Check if component fetches its own data (has useData embedded)
  // If so, we don't need to fetch data ourselves - the component will do it
  const componentFetchesOwnData = component?.component_code?.includes('useData(');

  // Auto-run query when datasource or query config changes
  // Only fetch if the component expects data as a prop (doesn't have useData embedded)
  useEffect(() => {
    if (connectionId && !componentFetchesOwnData) {
      console.log('[AIComponentPreview] Auto-running query - component expects data as prop');
      runQuery();
    }
  }, [connectionId, component?.query_config?.raw, componentFetchesOwnData]);

  // Handle name editing
  const _startEditName = () => {
    setEditNameValue(component?.name || 'Untitled');
    setNameError('');
    setEditingName(true);
  };

  const _cancelEditName = () => {
    setEditingName(false);
    setEditNameValue('');
    setNameError('');
  };

  const _confirmEditName = async () => {
    const newName = editNameValue.trim();
    if (!newName) {
      setNameError('Name is required');
      return;
    }
    if (newName.toLowerCase().startsWith('untitled')) {
      setNameError('Please provide a proper name');
      return;
    }
    // Check for duplicate names
    try {
      const response = await apiClient.getComponents();
      const charts = response.components || [];
      const duplicate = charts.find(c =>
        c.name.toLowerCase() === newName.toLowerCase() &&
        c.id !== component?.id
      );
      if (duplicate) {
        setNameError('A component with this name already exists');
        return;
      }
    } catch (err) {
      console.error('Error checking component names:', err);
    }

    if (onNameChange) {
      onNameChange(newName);
    }
    setEditingName(false);
    setNameError('');
  };

  // Run query for preview
  const runQuery = async () => {
    if (!connectionId) return;

    setPreviewLoading(true);
    setPreviewError(null);
    try {
      // Use query_config if available, otherwise query with empty/default
      const queryRaw = component?.query_config?.raw || '';
      const queryType = component?.query_config?.type || 'sql';

      const response = await apiClient.queryConnection(connectionId, {
        query: {
          raw: queryRaw,
          type: queryType,
          params: component?.query_config?.params || {}
        }
      });
      if (response.success && response.result_set) {
        setPreviewData(response.result_set);
      } else {
        setPreviewError(response.error || 'Query failed');
      }
    } catch (err) {
      setPreviewError(err.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Transform data with filters/aggregation
  const transformedData = useMemo(() => {
    if (!previewData) return null;

    const dataMapping = component?.data_mapping;
    if (!dataMapping) return previewData;

    const filters = dataMapping.filters || [];
    const aggregation = dataMapping.aggregation;
    const sortBy = dataMapping.sort_by;
    const sortOrder = dataMapping.sort_order || 'desc';
    const limit = dataMapping.limit || 0;

    const hasTransforms = filters.length > 0 || aggregation?.type || sortBy || limit > 0;
    if (!hasTransforms) return previewData;

    const transforms = {
      filters: filters,
      aggregation: aggregation?.type ? aggregation : null,
      sortBy: sortBy || null,
      sortOrder: sortOrder,
      limit: limit
    };

    const result = transformData(previewData, transforms);
    return {
      columns: result.columns,
      rows: result.rows,
      metadata: {
        ...previewData.metadata,
        row_count: result.rows.length,
        filtered: filters.length > 0
      }
    };
  }, [previewData, component?.data_mapping]);

  if (!component) {
    return (
      <div className="ai-chart-preview empty">
        <div className="empty-state">
          <p>Component preview will appear here</p>
          <p className="hint">Start a conversation to create your component</p>
        </div>
      </div>
    );
  }

  const isControl = component.component_type === 'control';

  // Control preview - render actual control component + config details
  if (isControl) {
    const controlConfig = component.control_config || {};
    const controlType = controlConfig.control_type || 'button';
    const typeInfo = CONTROL_TYPE_INFO[controlType] || {};
    const iconPath = typeInfo.icon;
    const uiConfig = controlConfig.ui_config || {};

    return (
      <div className="ai-chart-preview">
        <div className="control-preview">
          {/* Live control preview */}
          <div className="control-preview-live">
            <ControlRenderer control={component} />
          </div>

          {/* Config details below */}
          <div className="control-preview-config">
            <div className="config-section">
              <label>Configuration</label>
              <div className="config-grid">
                <div className="config-item">
                  <span className="config-label">Type</span>
                  <span className="config-value">
                    {iconPath && <Icon path={iconPath} size="16px" color="var(--cds-icon-primary)" />}
                    <Tag type="blue" size="sm">{typeInfo.label || controlType}</Tag>
                  </span>
                </div>
                <div className="config-item">
                  <span className="config-label">Connection</span>
                  <span className="config-value">
                    {connectionName || 'None'}
                    {connectionType && <Tag type="blue" size="sm">{connectionType}</Tag>}
                  </span>
                </div>
                {controlConfig.target && (
                  <div className="config-item">
                    <span className="config-label">Target</span>
                    <code className="config-value">{controlConfig.target}</code>
                  </div>
                )}
                {controlConfig.device_type_id && (
                  <div className="config-item">
                    <span className="config-label">Device Type</span>
                    <Tag type="teal" size="sm">{controlConfig.device_type_id}</Tag>
                  </div>
                )}
              </div>
            </div>

            {Object.keys(uiConfig).length > 0 && (
              <div className="config-section">
                <label>UI Settings</label>
                <div className="config-grid">
                  {Object.entries(uiConfig).map(([key, value]) => (
                    <div className="config-item" key={key}>
                      <span className="config-label">{key}</span>
                      <span className="config-value">{String(value)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Metadata Footer */}
        <div className="metadata-footer">
          <div className="metadata-row">
            <div className="metadata-item">
              <span className="metadata-label">Name</span>
              <span className="metadata-value">{component.name || 'Untitled'}</span>
            </div>
            <div className="metadata-item">
              <span className="metadata-label">Type</span>
              <span className="metadata-value">
                <Tag type="purple" size="sm">Control</Tag>
                <Tag type="blue" size="sm">{typeInfo.label || controlType}</Tag>
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Chart/Display preview - existing tabbed layout
  const dataMapping = component.data_mapping || {};
  const queryConfig = component.query_config || {};
  const filters = dataMapping.filters || [];
  const aggregation = dataMapping.aggregation;

  return (
    <div className="ai-chart-preview">
      {/* Tabs */}
      <div className="preview-switcher-wrapper">
        <ContentSwitcher
          selectedIndex={activeTab}
          onChange={({ index }) => setActiveTab(index)}
          className="preview-switcher"
        >
          <Switch name="connection" text="Connection" />
          <Switch name="preview" text="Preview" />
          <Switch name="code" text="Code" />
        </ContentSwitcher>
      </div>

      <div className="tab-panels">
        {/* Connection Tab */}
        {activeTab === 0 && (
          <div className="tab-content">
            {/* Connection info */}
            <div className="datasource-section">
              <div className="datasource-header">
                <label>Connection</label>
              </div>
              <div className="datasource-display">
                <span className="datasource-name">{connectionName || 'None selected'}</span>
                {connectionType && (
                  <>
                    <Tag type="blue" size="sm">{connectionType}</Tag>
                    {connectionDescription && (
                      <span className="datasource-description">{connectionDescription}</span>
                    )}
                  </>
                )}
              </div>
            </div>

            {/* Query section */}
            {queryConfig.raw && (
              <div className="query-section">
                <div className="query-header">
                  <label>{connectionType === 'api' ? 'API Endpoint Path' : 'Query'}</label>
                  <Button
                    kind="tertiary"
                    size="sm"
                    renderIcon={Play}
                    onClick={runQuery}
                    disabled={previewLoading}
                  >
                    {previewLoading ? 'Running...' : 'Run Query'}
                  </Button>
                </div>
                <div className="query-display">
                  <code>{queryConfig.raw}</code>
                </div>
              </div>
            )}

            {/* Data Mapping */}
            <div className="mapping-section">
              <label>Data Mapping</label>
              <div className="mapping-grid">
                <div className="mapping-item">
                  <span className="mapping-label">X-Axis (Categories)</span>
                  <div className="mapping-value">
                    {dataMapping.x_axis ? (
                      <Tag type="blue" size="sm">{dataMapping.x_axis}</Tag>
                    ) : (
                      <span className="no-value">Not set</span>
                    )}
                  </div>
                </div>
                <div className="mapping-item">
                  <span className="mapping-label">Y-Axis (Values)</span>
                  <div className="mapping-value">
                    {dataMapping.y_axis?.length > 0 ? (
                      dataMapping.y_axis.map((col, i) => (
                        <Tag key={i} type="blue" size="sm">{col}</Tag>
                      ))
                    ) : (
                      <span className="no-value">Not set</span>
                    )}
                  </div>
                </div>
                <div className="mapping-item">
                  <span className="mapping-label">Group By</span>
                  <div className="mapping-value">
                    {dataMapping.group_by ? (
                      <Tag type="blue" size="sm">{dataMapping.group_by}</Tag>
                    ) : (
                      <span className="no-value">None</span>
                    )}
                  </div>
                </div>
              </div>
              {!previewData && (
                <p className="hint-text">Run query to modify column mappings</p>
              )}
            </div>

            {/* Filters */}
            <div className="filters-section">
              <label>Filters (Client-Side)</label>
              {filters.length > 0 ? (
                <div className="filters-list">
                  {filters.map((filter, i) => (
                    <div key={i} className="filter-item">
                      <Tag type="blue" size="sm">{filter.field}</Tag>
                      <Tag type="gray" size="sm">{FILTER_OP_LABELS[filter.op] || filter.op}</Tag>
                      {filter.value !== undefined && filter.value !== '' && (
                        <Tag type="blue" size="sm">{String(filter.value)}</Tag>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="hint-text">Run query to modify filters</p>
              )}
            </div>

            {/* Aggregation */}
            <div className="aggregation-section">
              <label>Aggregation & Sorting</label>
              {aggregation?.type ? (
                <div className="aggregation-display">
                  <span>Type: {aggregation.type}</span>
                  {aggregation.field && <span>Field: {aggregation.field}</span>}
                  {aggregation.count && <span>Count: {aggregation.count}</span>}
                </div>
              ) : (
                <p className="hint-text">No aggregation configured. Run query to add aggregation and sorting.</p>
              )}
            </div>
          </div>
        )}

        {/* Preview Tab */}
        {activeTab === 1 && (
          <div className="tab-content preview-tab">
            {previewLoading ? (
              <div className="loading-container">
                <Loading description="Loading preview..." withOverlay={false} />
              </div>
            ) : previewError ? (
              <div className="error-container">
                <p className="error-text">{previewError}</p>
                <Button kind="tertiary" size="sm" onClick={runQuery}>
                  Retry
                </Button>
              </div>
            ) : component.component_code ? (
              <div className="chart-preview-container">
                <DynamicComponentLoader
                  code={component.component_code}
                  componentMeta={component}
                  props={componentFetchesOwnData ? {} : { data: transformedData }}
                />
              </div>
            ) : (
              <div className="no-preview">
                <p>No component preview available</p>
                <p className="hint">Run query in Connection tab to see preview</p>
              </div>
            )}
          </div>
        )}

        {/* Code Tab */}
        {activeTab === 2 && (
          <div className="tab-content code-tab">
            {component.component_code ? (
              <div className="code-display">
                <pre><code>{component.component_code}</code></pre>
              </div>
            ) : (
              <div className="no-code">
                <p>No component code generated yet</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Metadata Footer */}
      <div className="metadata-footer">
        <div className="metadata-row">
          <div className="metadata-item">
            <span className="metadata-label">Name</span>
            <span className="metadata-value">{component.name || 'Untitled'}</span>
          </div>
          <div className="metadata-item">
            <span className="metadata-label">Connection</span>
            <span className="metadata-value">
              {connectionName || 'None'}
              {connectionType && <Tag type="blue" size="sm">{connectionType}</Tag>}
            </span>
          </div>
        </div>
        {component.description && (
          <div className="metadata-row description-row">
            <div className="metadata-item full-width">
              <span className="metadata-label">Description</span>
              <span className="metadata-value">{component.description}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default AIComponentPreview;
