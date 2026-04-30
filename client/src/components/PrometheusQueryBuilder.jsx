// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import {
  Select,
  SelectItem,
  TextInput,
  Button,
  InlineLoading,
  InlineNotification,
  Tag,
  IconButton,
  Toggle,
  MultiSelect,
  Accordion,
  AccordionItem,
  ComboBox,
} from '@carbon/react';
import { Add, TrashCan, Play, Copy } from '@carbon/icons-react';
import api from '../api/client';
import './PrometheusQueryBuilder.scss';

/**
 * PrometheusQueryBuilder - Visual PromQL query builder
 *
 * Features:
 * - Fetches metrics and labels from Prometheus datasources
 * - Metric selection with search
 * - Label filter builder
 * - Aggregation functions (sum, avg, max, min, count)
 * - Group by labels
 * - Time range and step controls
 * - Generated PromQL preview
 * - Execute query
 */

// Common PromQL aggregation operators
const AGGREGATION_OPERATORS = [
  { id: '', label: 'None' },
  { id: 'sum', label: 'Sum' },
  { id: 'avg', label: 'Average' },
  { id: 'min', label: 'Minimum' },
  { id: 'max', label: 'Maximum' },
  { id: 'count', label: 'Count' },
  { id: 'stddev', label: 'Std Deviation' },
  { id: 'stdvar', label: 'Std Variance' },
  { id: 'topk', label: 'Top K' },
  { id: 'bottomk', label: 'Bottom K' },
];

// Rate/increase functions for counters
const RATE_FUNCTIONS = [
  { id: '', label: 'None' },
  { id: 'rate', label: 'Rate (per-second)' },
  { id: 'irate', label: 'Instant Rate' },
  { id: 'increase', label: 'Increase' },
  { id: 'delta', label: 'Delta' },
];

// Time range presets
const TIME_RANGE_PRESETS = [
  { id: '5m', label: 'Last 5 minutes' },
  { id: '15m', label: 'Last 15 minutes' },
  { id: '30m', label: 'Last 30 minutes' },
  { id: '1h', label: 'Last 1 hour' },
  { id: '3h', label: 'Last 3 hours' },
  { id: '6h', label: 'Last 6 hours' },
  { id: '12h', label: 'Last 12 hours' },
  { id: '24h', label: 'Last 24 hours' },
  { id: '7d', label: 'Last 7 days' },
];

// Step presets
const STEP_PRESETS = [
  { id: '15s', label: '15 seconds' },
  { id: '30s', label: '30 seconds' },
  { id: '1m', label: '1 minute' },
  { id: '5m', label: '5 minutes' },
  { id: '15m', label: '15 minutes' },
  { id: '1h', label: '1 hour' },
];

// Label match operators
const LABEL_OPERATORS = [
  { id: '=', label: 'Equals (=)' },
  { id: '!=', label: 'Not Equals (!=)' },
  { id: '=~', label: 'Regex Match (=~)' },
  { id: '!~', label: 'Regex Not Match (!~)' },
];

const PrometheusQueryBuilder = ({
  datasourceId,
  onQueryChange,
  onParamsChange,
  onExecute,
  initialQuery: _initialQuery = '',
  disabled = false
}) => {
  // Schema state
  const [schema, setSchema] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [labelValues, setLabelValues] = useState({}); // Cache of label -> values

  // Query builder state
  const [selectedMetric, setSelectedMetric] = useState('');
  const [labelFilters, setLabelFilters] = useState([]); // Array of {label, operator, value}
  const [aggregation, setAggregation] = useState('');
  const [aggregationParam, setAggregationParam] = useState(''); // For topk/bottomk
  const [groupByLabels, setGroupByLabels] = useState([]);
  const [rateFunction, setRateFunction] = useState('');
  const [rateWindow, setRateWindow] = useState('5m');

  // Query type and time range
  const [queryType, setQueryType] = useState('range'); // 'range' or 'instant'
  const [timeRange, setTimeRange] = useState('1h');
  const [step, setStep] = useState('1m');

  // Generated query
  const [generatedQuery, setGeneratedQuery] = useState('');
  const [executing, setExecuting] = useState(false);

  // Metric search filter
  const [metricSearch, setMetricSearch] = useState('');

  // Fetch schema when datasource changes
  useEffect(() => {
    if (datasourceId) {
      fetchSchema();
    }
  }, [datasourceId]);

  // Build query whenever options change
  useEffect(() => {
    const query = buildQuery();
    setGeneratedQuery(query);
    if (onQueryChange) {
      onQueryChange(query);
    }
    if (onParamsChange) {
      onParamsChange({
        query_type: queryType,
        start: `now-${timeRange}`,
        end: 'now',
        step: step,
      });
    }
  }, [selectedMetric, labelFilters, aggregation, aggregationParam, groupByLabels,
      rateFunction, rateWindow, queryType, timeRange, step]);

  const fetchSchema = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.getDatasourceSchema(datasourceId);
      if (response.success && response.prometheus_schema) {
        setSchema(response.prometheus_schema);
      } else {
        setError(response.error || 'Failed to fetch Prometheus schema');
      }
    } catch (err) {
      setError(err.message || 'Failed to fetch schema');
    } finally {
      setLoading(false);
    }
  };

  // Fetch label values when a label is selected for filtering
  const fetchLabelValues = async (labelName) => {
    if (labelValues[labelName]) return; // Already cached

    try {
      const response = await api.getPrometheusLabelValues(datasourceId, labelName);
      if (response && response.values && Array.isArray(response.values)) {
        setLabelValues(prev => ({ ...prev, [labelName]: response.values }));
      }
    } catch (err) {
      console.error(`Failed to fetch values for label ${labelName}:`, err);
    }
  };

  const buildQuery = () => {
    if (!selectedMetric) return '';

    let query = selectedMetric;

    // Add label filters
    if (labelFilters.length > 0) {
      const filterParts = labelFilters
        .filter(f => f.label && f.value)
        .map(f => {
          // Quote the value appropriately
          const value = f.operator.includes('~') ? f.value : `"${f.value}"`;
          return `${f.label}${f.operator}${value}`;
        });

      if (filterParts.length > 0) {
        query = `${selectedMetric}{${filterParts.join(', ')}}`;
      }
    }

    // Apply rate/increase function if selected (for counters)
    if (rateFunction) {
      query = `${rateFunction}(${query}[${rateWindow}])`;
    }

    // Apply aggregation
    if (aggregation) {
      if (['topk', 'bottomk'].includes(aggregation) && aggregationParam) {
        query = `${aggregation}(${aggregationParam}, ${query})`;
      } else if (groupByLabels.length > 0) {
        query = `${aggregation} by (${groupByLabels.join(', ')}) (${query})`;
      } else {
        query = `${aggregation}(${query})`;
      }
    }

    return query;
  };

  // Filter metrics based on search
  const filteredMetrics = useMemo(() => {
    if (!schema?.metrics) return [];
    if (!metricSearch) return schema.metrics;

    const search = metricSearch.toLowerCase();
    return schema.metrics.filter(m =>
      m.name.toLowerCase().includes(search)
    );
  }, [schema?.metrics, metricSearch]);

  // Add a new label filter
  const addLabelFilter = () => {
    setLabelFilters([...labelFilters, { label: '', operator: '=', value: '' }]);
  };

  // Update a label filter
  const updateLabelFilter = (index, field, value) => {
    const updated = [...labelFilters];
    updated[index] = { ...updated[index], [field]: value };
    setLabelFilters(updated);

    // Fetch label values when label is selected
    if (field === 'label' && value) {
      fetchLabelValues(value);
    }
  };

  // Remove a label filter
  const removeLabelFilter = (index) => {
    setLabelFilters(labelFilters.filter((_, i) => i !== index));
  };

  // Execute query
  const handleExecute = async () => {
    if (!generatedQuery || !datasourceId) return;

    setExecuting(true);
    try {
      const response = await api.queryDatasource(datasourceId, {
        query: {
          raw: generatedQuery,
          type: 'prometheus',
          params: {
            query_type: queryType,
            start: `now-${timeRange}`,
            end: 'now',
            step: step,
          }
        }
      });

      if (onExecute) {
        onExecute(response);
      }
    } catch (err) {
      console.error('Query execution failed:', err);
      if (onExecute) {
        onExecute({ success: false, error: err.message });
      }
    } finally {
      setExecuting(false);
    }
  };

  // Copy query to clipboard
  const copyQuery = () => {
    navigator.clipboard.writeText(generatedQuery);
  };

  if (loading) {
    return (
      <div className="prometheus-query-builder loading">
        <InlineLoading description="Loading Prometheus schema..." />
      </div>
    );
  }

  if (error) {
    return (
      <div className="prometheus-query-builder error">
        <InlineNotification
          kind="error"
          title="Schema Error"
          subtitle={error}
          hideCloseButton
        />
        <Button size="sm" onClick={fetchSchema}>Retry</Button>
      </div>
    );
  }

  if (!schema) {
    return (
      <div className="prometheus-query-builder empty">
        <p>Select a Prometheus datasource to build queries</p>
      </div>
    );
  }

  return (
    <div className="prometheus-query-builder">
      {/* Metric Selection */}
      <div className="builder-section">
        <h5>Metric</h5>
        <ComboBox
          id="metric-select"
          titleText=""
          placeholder="Search and select a metric..."
          items={schema?.metrics || []}
          itemToString={(item) => item?.name || ''}
          selectedItem={schema?.metrics?.find(m => m.name === selectedMetric) || null}
          onChange={({ selectedItem }) => setSelectedMetric(selectedItem?.name || '')}
          onInputChange={(inputValue) => setMetricSearch(inputValue || '')}
          shouldFilterItem={({ item, inputValue }) => {
            if (!inputValue) return true;
            return item?.name?.toLowerCase().includes(inputValue.toLowerCase());
          }}
          disabled={disabled}
        />
        {schema.metrics.length > 0 && metricSearch && (
          <div className="metric-count">
            {filteredMetrics.length} of {schema.metrics.length} metrics
          </div>
        )}
      </div>

      {/* Label Filters */}
      <div className="builder-section">
        <div className="section-header">
          <h5>Label Filters</h5>
          <IconButton
            kind="ghost"
            size="sm"
            label="Add filter"
            onClick={addLabelFilter}
            disabled={disabled}
          >
            <Add />
          </IconButton>
        </div>

        {labelFilters.map((filter, index) => (
          <div key={index} className="label-filter-row">
            <Select
              id={`label-${index}`}
              labelText=""
              value={filter.label}
              onChange={(e) => updateLabelFilter(index, 'label', e.target.value)}
              disabled={disabled}
            >
              <SelectItem value="" text="Select label..." />
              {schema.labels.map(label => (
                <SelectItem key={label} value={label} text={label} />
              ))}
            </Select>

            <Select
              id={`operator-${index}`}
              labelText=""
              value={filter.operator}
              onChange={(e) => updateLabelFilter(index, 'operator', e.target.value)}
              disabled={disabled}
            >
              {LABEL_OPERATORS.map(op => (
                <SelectItem key={op.id} value={op.id} text={op.label} />
              ))}
            </Select>

            {labelValues[filter.label] ? (
              <ComboBox
                id={`value-${index}`}
                titleText=""
                placeholder="Select or type value..."
                items={labelValues[filter.label] || []}
                itemToString={(item) => item || ''}
                selectedItem={filter.value}
                onChange={({ selectedItem }) => updateLabelFilter(index, 'value', selectedItem || '')}
                disabled={disabled}
              />
            ) : (
              <TextInput
                id={`value-${index}`}
                labelText=""
                placeholder="Value..."
                value={filter.value}
                onChange={(e) => updateLabelFilter(index, 'value', e.target.value)}
                disabled={disabled}
              />
            )}

            <IconButton
              kind="ghost"
              size="sm"
              label="Remove filter"
              onClick={() => removeLabelFilter(index)}
              disabled={disabled}
            >
              <TrashCan />
            </IconButton>
          </div>
        ))}
      </div>

      {/* Rate/Increase Functions (for counters) */}
      <div className="builder-section">
        <h5>Rate Function</h5>
        <div className="rate-row">
          <Select
            id="rate-function"
            labelText=""
            value={rateFunction}
            onChange={(e) => setRateFunction(e.target.value)}
            disabled={disabled}
          >
            {RATE_FUNCTIONS.map(fn => (
              <SelectItem key={fn.id} value={fn.id} text={fn.label} />
            ))}
          </Select>

          {rateFunction && (
            <Select
              id="rate-window"
              labelText=""
              value={rateWindow}
              onChange={(e) => setRateWindow(e.target.value)}
              disabled={disabled}
            >
              <SelectItem value="1m" text="1m window" />
              <SelectItem value="5m" text="5m window" />
              <SelectItem value="10m" text="10m window" />
              <SelectItem value="15m" text="15m window" />
              <SelectItem value="30m" text="30m window" />
              <SelectItem value="1h" text="1h window" />
            </Select>
          )}
        </div>
        <div className="helper-text">
          Use rate() or increase() for counter metrics to calculate per-second rate or total increase
        </div>
      </div>

      {/* Aggregation */}
      <div className="builder-section">
        <h5>Aggregation</h5>
        <div className="aggregation-row">
          <Select
            id="aggregation"
            labelText=""
            value={aggregation}
            onChange={(e) => setAggregation(e.target.value)}
            disabled={disabled}
          >
            {AGGREGATION_OPERATORS.map(op => (
              <SelectItem key={op.id} value={op.id} text={op.label} />
            ))}
          </Select>

          {['topk', 'bottomk'].includes(aggregation) && (
            <TextInput
              id="aggregation-param"
              labelText=""
              placeholder="K value"
              type="number"
              value={aggregationParam}
              onChange={(e) => setAggregationParam(e.target.value)}
              disabled={disabled}
            />
          )}
        </div>

        {aggregation && !['topk', 'bottomk'].includes(aggregation) && (
          <div className="group-by-section">
            <label>Group By</label>
            <MultiSelect
              id="group-by"
              titleText=""
              label="Select labels to group by..."
              items={schema.labels}
              itemToString={(item) => item}
              selectedItems={groupByLabels}
              onChange={({ selectedItems }) => setGroupByLabels(selectedItems)}
              disabled={disabled}
            />
          </div>
        )}
      </div>

      {/* Query Type & Time Range */}
      <div className="builder-section">
        <h5>Query Settings</h5>
        <div className="query-settings-row">
          <Toggle
            id="query-type-toggle"
            labelText="Query Type"
            labelA="Instant"
            labelB="Range"
            toggled={queryType === 'range'}
            onToggle={(checked) => setQueryType(checked ? 'range' : 'instant')}
            disabled={disabled}
          />

          <Select
            id="time-range"
            labelText="Time Range"
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value)}
            disabled={disabled}
          >
            {TIME_RANGE_PRESETS.map(preset => (
              <SelectItem key={preset.id} value={preset.id} text={preset.label} />
            ))}
          </Select>

          {queryType === 'range' && (
            <Select
              id="step"
              labelText="Resolution"
              value={step}
              onChange={(e) => setStep(e.target.value)}
              disabled={disabled}
            >
              {STEP_PRESETS.map(preset => (
                <SelectItem key={preset.id} value={preset.id} text={preset.label} />
              ))}
            </Select>
          )}
        </div>
      </div>

      {/* Generated Query Preview */}
      <div className="builder-section query-preview">
        <div className="section-header">
          <h5>Generated PromQL</h5>
          <div className="preview-actions">
            <IconButton
              kind="ghost"
              size="sm"
              label="Copy query"
              onClick={copyQuery}
              disabled={!generatedQuery}
            >
              <Copy />
            </IconButton>
            <Button
              kind="primary"
              size="sm"
              renderIcon={Play}
              onClick={handleExecute}
              disabled={!generatedQuery || executing || disabled}
            >
              {executing ? 'Executing...' : 'Execute'}
            </Button>
          </div>
        </div>
        <pre className="query-code">
          {generatedQuery || '# Select a metric to build query'}
        </pre>
      </div>
    </div>
  );
};

export default PrometheusQueryBuilder;
