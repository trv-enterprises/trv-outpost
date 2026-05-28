// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  TextInput,
  TextArea,
  Toggle,
  Select,
  SelectItem,
  MultiSelect,
  Column,
  Grid,
  ContentSwitcher,
  Switch,
  Tag,
  InlineNotification,
  NotificationActionButton,
  Button,
  NumberInput,
  IconButton,
  Slider,
  Modal,
  Checkbox,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
  Tooltip
} from '@carbon/react';
import { Play, Add, TrashCan, Close, Renew, ChartBar, ChartLine, ChartArea, ChartPie, ChartScatter, Meter, Code, TableSplit, StringInteger, CaretUp, CaretDown, Information } from '@carbon/icons-react';
import DynamicComponentLoader from './DynamicComponentLoader';
import { API_BASE } from '../api/client';
import SQLQueryBuilder from './SQLQueryBuilder';
import PrometheusQueryBuilder from './PrometheusQueryBuilder';
import EdgeLakeQueryBuilder from './EdgeLakeQueryBuilder';
import MQTTTopicSelector from './MQTTTopicSelector';
import ControlEditor from './ControlEditor';
import DisplayEditor from './DisplayEditor';
import { transformData, formatCellValue } from '../utils/dataTransforms';
import apiClient from '../api/client';
import TagInput from './shared/TagInput';
import { useEnabledTypes } from '../context/EnabledTypesContext';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceSelect from './shared/NamespaceSelect';
import ConnectionGuidanceHint from './shared/ConnectionGuidanceHint';
import './ComponentEditor.scss';

// Chart types available
const CHART_TYPES = [
  { id: 'bar', label: 'Bar Chart', description: 'Compare values across categories', icon: ChartBar },
  { id: 'line', label: 'Line Chart', description: 'Show trends over time', icon: ChartLine },
  { id: 'area', label: 'Area Chart', description: 'Line chart with filled area beneath', icon: ChartArea },
  { id: 'pie', label: 'Pie Chart', description: 'Show proportions of a whole', icon: ChartPie },
  { id: 'scatter', label: 'Scatter Plot', description: 'Plot data points on two axes', icon: ChartScatter },
  { id: 'gauge', label: 'Gauge', description: 'Display a single value on a dial', icon: Meter },
  { id: 'number', label: 'Number', description: 'Display a single value as a large number with optional unit', icon: StringInteger },
  { id: 'dataview', label: 'Data Table', description: 'Tabular view of raw data', icon: TableSplit },
  { id: 'banded_bar', label: 'Banded Bar Chart', description: 'Levey-Jennings / control-chart style — time-series with horizontal reference bands', icon: ChartBar },
  { id: 'custom', label: 'Custom Component', description: 'Write custom React/ECharts code', icon: Code }
];

// Filter operators
const FILTER_OPERATORS = [
  { id: 'eq', label: 'Equals (=)' },
  { id: 'neq', label: 'Not Equals (≠)' },
  { id: 'gt', label: 'Greater Than (>)' },
  { id: 'gte', label: 'Greater or Equal (≥)' },
  { id: 'lt', label: 'Less Than (<)' },
  { id: 'lte', label: 'Less or Equal (≤)' },
  { id: 'contains', label: 'Contains' },
  { id: 'startsWith', label: 'Starts With' },
  { id: 'endsWith', label: 'Ends With' },
  { id: 'in', label: 'In List' },
  { id: 'notIn', label: 'Not In List' },
  { id: 'isNull', label: 'Is Null' },
  { id: 'isNotNull', label: 'Is Not Null' }
];

// Aggregation types
const AGGREGATION_TYPES = [
  { id: '', label: 'None' },
  { id: 'first', label: 'First Row', needsSort: true },
  { id: 'last', label: 'Last Row', needsSort: true },
  { id: 'min', label: 'Minimum', needsField: true },
  { id: 'max', label: 'Maximum', needsField: true },
  { id: 'avg', label: 'Average', needsField: true },
  { id: 'sum', label: 'Sum', needsField: true },
  { id: 'count', label: 'Count' },
  { id: 'limit', label: 'Limit Rows', needsCount: true }
];

// Chart type configuration - defines which fields are applicable for each chart type
const CHART_TYPE_CONFIG = {
  bar: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: true,
    hasSeriesColumn: true,
    hasAxisLabels: true,
    hasXAxisFormat: true,
    hasTimeBucket: true,
    hasSortLimit: true,
    xAxisLabel: 'X-Axis (Categories)',
    yAxisLabel: 'Y-Axis (Values)',
  },
  line: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: true,
    hasSeriesColumn: true,
    hasAxisLabels: true,
    hasXAxisFormat: true,
    hasTimeBucket: true,
    hasSortLimit: true,
    xAxisLabel: 'X-Axis (Categories)',
    yAxisLabel: 'Y-Axis (Values)',
  },
  area: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: true,
    hasSeriesColumn: true,
    hasAxisLabels: true,
    hasXAxisFormat: true,
    hasTimeBucket: true,
    hasSortLimit: true,
    xAxisLabel: 'X-Axis (Categories)',
    yAxisLabel: 'Y-Axis (Values)',
  },
  pie: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: true,
    hasTimeBucket: false,
    hasSortLimit: true,
    xAxisLabel: 'Category Column',
    yAxisLabel: 'Value Column',
  },
  scatter: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: true,
    hasXAxisFormat: false,
    hasTimeBucket: false,
    hasSortLimit: true,
    xAxisLabel: 'X-Axis (Numeric)',
    yAxisLabel: 'Y-Axis (Numeric)',
  },
  gauge: {
    hasXAxis: false,
    hasYAxis: true,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: false,
    hasTimeBucket: true,
    hasSortLimit: false,
    xAxisLabel: '',
    yAxisLabel: 'Value Column',
  },
  // "Number" is gauge's visual twin: same data contract (single value from
  // one Y column on the first row), no axes, no X column. Differs only in
  // presentation — a big typographic number instead of a dial — so everything
  // downstream (aggregation, time-bucket, filters) mirrors gauge exactly.
  number: {
    hasXAxis: false,
    hasYAxis: true,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: false,
    hasTimeBucket: true,
    hasSortLimit: false,
    xAxisLabel: '',
    yAxisLabel: 'Value Column',
  },
  dataview: {
    hasXAxis: false,
    hasYAxis: false,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: false,
    hasTimeBucket: false,
    hasSortLimit: true,
    hasVisibleColumns: true,
    xAxisLabel: '',
    yAxisLabel: '',
  },
  // banded_bar (Levey-Jennings) is per-row only — every row carries its
  // own mean + ±1/±2 SD columns. The dedicated "Band Columns" section
  // handles all of the per-row mapping; the generic Y-axis picker, axis
  // labels, series column, aggregation, and sort/limit don't apply.
  // Time bucket is also off — the data is already aggregated per row.
  banded_bar: {
    hasXAxis: true,
    hasYAxis: false,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: true,
    hasTimeBucket: false,
    hasSortLimit: false,
    hasAggregation: false,
    xAxisLabel: 'Timestamp Column',
    yAxisLabel: '',
  },
  custom: {
    hasXAxis: true,
    hasYAxis: true,
    multipleYAxis: true,
    hasSeriesColumn: true,
    hasAxisLabels: true,
    hasXAxisFormat: true,
    hasTimeBucket: true,
    hasSortLimit: true,
    xAxisLabel: 'X-Axis',
    yAxisLabel: 'Y-Axis',
  },
};

/**
 * ComponentEditor Component
 *
 * Shared editor for creating/editing charts. Used by both:
 * - ComponentEditorModal (for dashboard inline editing)
 * - ComponentDetailPage (for standalone chart editing)
 *
 * Features:
 * - Chart type selection
 * - Description field
 * - Data source selection and query configuration
 * - Data mapping (columns to axes)
 * - Filters and aggregation
 * - Live preview with real data
 * - Custom code editor for advanced charts
 */
const ComponentEditor = forwardRef(function ComponentEditor({
  chart,
  onSave,
  onCancel,
  saving = false,
  showActions = true,
  className = '',
  onValidityChange,
  onDirtyChange
}, ref) {
  // Basic info
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [title, setTitle] = useState(''); // Display title (defaults to name)
  const { activeNamespace } = useNamespaces();
  const [namespace, setNamespace] = useState('');
  const [description, setDescription] = useState('');
  const { isChartTypeEnabled, enabledDisplayTypes, enabledControlTypes } = useEnabledTypes();
  const [tags, setTags] = useState([]);
  const [componentType, setComponentType] = useState('chart'); // 'chart', 'control', or 'display'
  const [chartType, setChartType] = useState('bar');
  const [chartTypeModalOpen, setChartTypeModalOpen] = useState(false);

  // Control configuration (when componentType === 'control')
  const [controlConfig, setControlConfig] = useState(null);

  // Display configuration (when componentType === 'display')
  const [displayConfig, setDisplayConfig] = useState(null);

  // Data source configuration
  const [connections, setConnections] = useState([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState('');
  const [selectedDatasource, setSelectedDatasource] = useState(null);

  // Query configuration
  const [queryRaw, setQueryRaw] = useState('');
  const [queryType, setQueryType] = useState('sql');

  // Data mapping
  const [xAxisColumn, setXAxisColumn] = useState('');
  const [xAxisLabel, setXAxisLabel] = useState(''); // Custom label for X axis
  const [xAxisFormat, setXAxisFormat] = useState('chart'); // Default format for timestamp display
  const [yAxisColumns, setYAxisColumns] = useState([]);
  const [yAxisLabel, setYAxisLabel] = useState(''); // Legacy single y-axis label — kept for back-compat; use yAxisLabels for new code.
  const [yAxisLabels, setYAxisLabels] = useState([]); // Per-column y-axis labels. Index matches yAxisColumns. Empty entries fall back to column name.
  const [groupByColumn, setGroupByColumn] = useState('');
  const [seriesColumn, setSeriesColumn] = useState(''); // Column that identifies each series (e.g., location) - used for time bucket partitioning

  // Filters and aggregation
  const [filters, setFilters] = useState([]);
  const [aggregation, setAggregation] = useState({ type: '', sortBy: '', field: '', count: 10 });
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState('desc');
  const [limitRows, setLimitRows] = useState(0);
  const [columnAliases, setColumnAliases] = useState({}); // For dataview: column name -> display name
  // For dataview: which columns to render as table columns. Stored as an
  // explicit whitelist — null/empty means "show all" (default, back-compat).
  // When non-null, the table filters data.columns through this list.
  const [visibleColumns, setVisibleColumns] = useState(null);

  // Sliding window for time-series data
  const [slidingWindowEnabled, setSlidingWindowEnabled] = useState(false);
  const [slidingWindowDuration, setSlidingWindowDuration] = useState(300); // Default 5 minutes
  const [slidingWindowTimestampCol, setSlidingWindowTimestampCol] = useState('');

  // Banded-bar column mapping — only used when chart_type === 'banded_bar'.
  // The chart is per-row only: each row carries its own mean + SD columns
  // and the renderer draws a per-row envelope. This object maps each
  // band role to a row-column name.
  const [bandColumns, setBandColumns] = useState({ mean: '', plus_1sd: '', minus_1sd: '', plus_2sd: '', minus_2sd: '' });
  const [bandedBarStyle, setBandedBarStyle] = useState('time_series');

  // Time bucket aggregation for streaming data (socket datasources only)
  const [timeBucketEnabled, setTimeBucketEnabled] = useState(false);
  const [timeBucketInterval, setTimeBucketInterval] = useState(60); // Default 1 minute
  const [timeBucketFunction, setTimeBucketFunction] = useState('avg');
  const [timeBucketValueCols, setTimeBucketValueCols] = useState([]);
  const [timeBucketTimestampCol, setTimeBucketTimestampCol] = useState('');

  // TSStore query configuration
  const [tsstoreQueryType, setTsstoreQueryType] = useState('since'); // since, newest, oldest
  const [tsstoreLimit, setTsstoreLimit] = useState(100);
  const [tsstoreSinceDuration, setTsstoreSinceDuration] = useState('1h'); // e.g., "30m", "2h", "7d"

  // EdgeLake query configuration (for raw mode database param)
  const [edgelakeDatabase, setEdgelakeDatabase] = useState('');

  // MQTT topic selection
  const [mqttTopics, setMqttTopics] = useState([]);
  const [mqttTopicsLoading, setMqttTopicsLoading] = useState(false);
  const [mqttSelectedTopic, setMqttSelectedTopic] = useState('');
  const [mqttSampling, setMqttSampling] = useState(false);

  // Stream parser config (per-component data extraction for MQTT/streaming)
  const [parserPreset, setParserPreset] = useState('none'); // 'none', 'tsstore', 'custom'
  const [parserDataPath, setParserDataPath] = useState('');
  const [parserTimestampField, setParserTimestampField] = useState('');
  const [parserTimestampScale, setParserTimestampScale] = useState(''); // 's', 'ms', 'ns', or '' for auto
  const [parserSampleInput, setParserSampleInput] = useState(''); // Sample JSON for testing parser
  const mqttRawRecordsRef = useRef([]); // Raw MQTT records for re-parsing when parser changes

  // Helper: apply parser config to a raw record
  const applyParserToRaw = useCallback((raw) => {
    if (parserPreset === 'none' || (!parserDataPath && !parserTimestampField)) return { ...raw };
    const result = {};
    if (parserTimestampField) {
      const parts = parserTimestampField.split('.');
      let ts = raw; for (const p of parts) { ts = ts?.[p]; }
      if (ts != null && typeof ts === 'number') {
        if (parserTimestampScale === 'ns') ts = ts / 1e9;
        else if (parserTimestampScale === 'ms') ts = ts / 1e3;
        else if (!parserTimestampScale) { if (ts > 1e15) ts = ts / 1e9; else if (ts > 1e12) ts = ts / 1e3; }
        result.timestamp = ts;
      }
    }
    if (parserDataPath) {
      const parts = parserDataPath.split('.');
      let nested = raw; for (const p of parts) { nested = nested?.[p]; }
      if (nested && typeof nested === 'object') Object.assign(result, nested);
    }
    return Object.keys(result).length > 0 ? result : { ...raw };
  }, [parserPreset, parserDataPath, parserTimestampField, parserTimestampScale]);

  // When sample input or parser config changes, extract columns and rebuild query results
  useEffect(() => {
    if (!parserSampleInput.trim()) return;
    try {
      const parsed = applyParserToRaw(JSON.parse(parserSampleInput));
      const cols = Object.keys(parsed);
      if (cols.length > 0) {
        setAvailableColumns(cols);
        if (!xAxisColumn) setXAxisColumn(cols[0]);
        if (yAxisColumns.length === 0 && cols.length > 1) setYAxisColumns([cols[1]]);
      }
    } catch { /* invalid JSON, ignore */ }

    // Rebuild preview table from stored raw MQTT records if available
    const rawRecords = mqttRawRecordsRef.current;
    if (rawRecords.length > 0) {
      const processedRecords = rawRecords.map(applyParserToRaw);
      const columns = Object.keys(processedRecords[0]);
      const rows = processedRecords.map(r => columns.map(c => r[c]));
      setPreviewData({ columns, rows, metadata: { row_count: rows.length } });
      if (columns.length > 0) {
        setAvailableColumns(columns);
      }
    }
  }, [parserSampleInput, applyParserToRaw]);
  const mqttCaptureRef = useRef(null); // EventSource ref for cancellable MQTT capture

  // Preview data
  const [previewData, setPreviewData] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [availableColumns, setAvailableColumns] = useState([]);

  // Code editor
  const [componentCode, setComponentCode] = useState('');
  const [showCustomCode, setShowCustomCode] = useState(false);

  // Chart-specific options (gauge thresholds, pie radius, etc.)
  const [chartOptions, setChartOptions] = useState({
    // Gauge options
    gaugeMin: 0,
    gaugeMax: 100,
    gaugeWarningThreshold: 70,  // Where yellow zone starts (%)
    gaugeDangerThreshold: 90,   // Where red zone starts (%)
    gaugeUnit: '',              // Unit suffix (e.g., '°F', '%')
    // Number (single-value display) options.
    // numberSize stays unset on create so the editor can lazy-populate it
    // from the admin default (default_numeric_chart_number_size). Once the
    // user saves or edits, it's always a concrete number.
    numberSize: null,           // px size of the value text
    numberUnit: '',             // Unit suffix (same size as value, inline)
    // Pie options
    pieInnerRadius: 0,          // 0 = pie, >0 = donut
    pieShowLabels: true,
    // Bar/Line/Area options
    chartStacked: false,
    chartSmooth: true,
    chartShowDataLabels: false,
    // Zoom slider — renders a draggable range bar under the x-axis
    // plus inside (wheel/pinch) zoom on the plot itself. Off by
    // default; the small adopted-from-the-AI-version pattern that
    // gives users a way to drill into a noisy long time-series.
    chartShowZoomSlider: false,
  });

  // Query mode: 'visual' for SQLQueryBuilder, 'raw' for TextArea
  const [queryMode, setQueryMode] = useState('raw');

  // UI state
  const [activeTab, setActiveTab] = useState(0);
  const [hasChanges, setHasChanges] = useState(false);
  const [initialState, setInitialState] = useState(null);

  // Get current chart type configuration
  const chartTypeConfig = useMemo(() => {
    return CHART_TYPE_CONFIG[chartType] || CHART_TYPE_CONFIG.custom;
  }, [chartType]);

  // Clear irrelevant fields when chart type changes
  const handleChartTypeChange = (newType) => {
    const newConfig = CHART_TYPE_CONFIG[newType] || CHART_TYPE_CONFIG.custom;

    // Clear X-axis fields if not applicable
    if (!newConfig.hasXAxis) {
      setXAxisColumn('');
      setXAxisLabel('');
      setXAxisFormat('chart');
    }

    // Clear Y-axis to single value if multiple not allowed
    if (!newConfig.multipleYAxis && yAxisColumns.length > 1) {
      setYAxisColumns(yAxisColumns.slice(0, 1));
    }

    // Clear series column if not applicable
    if (!newConfig.hasSeriesColumn) {
      setSeriesColumn('');
    }

    // Clear axis labels if not applicable
    if (!newConfig.hasAxisLabels) {
      setXAxisLabel('');
      setYAxisLabel('');
      setYAxisLabels([]);
    }

    // Clear time bucket if not applicable
    if (!newConfig.hasTimeBucket) {
      setTimeBucketEnabled(false);
    }

    // Clear sort/limit if not applicable
    if (!newConfig.hasSortLimit) {
      setSortBy('');
      setSortOrder('desc');
      setLimitRows(0);
    }

    setChartType(newType);
  };

  // Update a single chart option
  const updateChartOption = (key, value) => {
    setChartOptions(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // Check for duplicate chart name on blur
  const checkDuplicateChartName = async (nameToCheck) => {
    if (!nameToCheck || !nameToCheck.trim()) {
      setNameError('');
      return;
    }
    try {
      const result = await apiClient.getComponents();
      const charts = result.components || [];
      const duplicate = charts.find(c =>
        c.name.toLowerCase() === nameToCheck.trim().toLowerCase() &&
        c.id !== chart?.id
      );
      if (duplicate) {
        setNameError(`A chart with this name already exists`);
      } else {
        setNameError('');
      }
    } catch (err) {
      console.error('Error checking chart name:', err);
      setNameError('');
    }
  };

  // Fetch datasources on mount
  useEffect(() => {
    fetchDatasources();
  }, []);

  // Pull the admin default for number-chart value size so new charts
  // render at the deployment's preferred size instead of a hard-coded
  // constant. Only applies when numberSize is still null (i.e. unsaved).
  useEffect(() => {
    if (chartOptions.numberSize != null) return;
    let cancelled = false;
    apiClient.getSetting('default_numeric_chart_number_size')
      .then((s) => {
        if (cancelled) return;
        const n = Number(s?.value);
        if (Number.isFinite(n) && n > 0) {
          setChartOptions((prev) => prev.numberSize == null ? { ...prev, numberSize: n } : prev);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [chartOptions.numberSize]);

  // Initialize form when chart changes
  useEffect(() => {
    if (chart) {
      // Editing existing chart
      setName(chart.name || '');
      setTitle(chart.title || '');
      setDescription(chart.description || '');
      setNamespace(chart.namespace || 'default');
      setTags(chart.tags || []);
      setComponentType(chart.component_type || 'chart');
      setChartType(chart.chart_type || 'bar');
      const loadedControlConfig = chart.control_config || null;
      // Ensure connection_id is in control_config for ControlEditor
      if (loadedControlConfig && chart.connection_id && !loadedControlConfig.connection_id) {
        loadedControlConfig.connection_id = chart.connection_id;
      }
      setControlConfig(loadedControlConfig);
      setDisplayConfig(chart.display_config || null);
      setSelectedConnectionId(chart.connection_id || chart.connection_id || '');
      setQueryRaw(chart.query_config?.raw || '');
      setQueryType(chart.query_config?.type || 'sql');
      setXAxisColumn(chart.data_mapping?.x_axis || '');
      setXAxisLabel(chart.data_mapping?.x_axis_label || '');
      setXAxisFormat(chart.data_mapping?.x_axis_format || 'chart');
      setYAxisColumns(chart.data_mapping?.y_axis || []);
      setYAxisLabel(chart.data_mapping?.y_axis_label || '');
      // Prefer the new per-column array; fall back to seeding from the legacy
      // single label (position 0) so existing charts keep their label.
      const loadedLabels = chart.data_mapping?.y_axis_labels;
      if (Array.isArray(loadedLabels) && loadedLabels.length > 0) {
        setYAxisLabels(loadedLabels);
      } else if (chart.data_mapping?.y_axis_label) {
        setYAxisLabels([chart.data_mapping.y_axis_label]);
      } else {
        setYAxisLabels([]);
      }
      setGroupByColumn(chart.data_mapping?.group_by || '');
      setSeriesColumn(chart.data_mapping?.series || '');
      setFilters(chart.data_mapping?.filters || []);
      setAggregation(chart.data_mapping?.aggregation || { type: '', sortBy: '', field: '', count: 10 });
      setSortBy(chart.data_mapping?.sort_by || '');
      setSortOrder(chart.data_mapping?.sort_order || 'desc');
      setLimitRows(chart.data_mapping?.limit || 0);
      setColumnAliases(chart.data_mapping?.column_aliases || {});
      // Visible columns: null means "show all" (default). Only populated when
      // the admin has actively hidden some.
      const loadedVisible = chart.data_mapping?.visible_columns;
      setVisibleColumns(Array.isArray(loadedVisible) && loadedVisible.length > 0 ? loadedVisible : null);
      // Sliding window initialization
      const sw = chart.data_mapping?.sliding_window;
      setSlidingWindowEnabled(sw?.duration > 0 && !!sw?.timestamp_col);
      setSlidingWindowDuration(sw?.duration || 300);
      setSlidingWindowTimestampCol(sw?.timestamp_col || '');
      // Banded-bar column mapping. Empty defaults — the user picks
      // columns from the schema dropdown. Migrating an old chart that
      // still has reference_levels: keep it loaded so the chart keeps
      // rendering; the new editor section just shows empty pickers,
      // which is a clean prompt to re-pick.
      const savedBandCols = chart.data_mapping?.band_columns;
      if (savedBandCols && typeof savedBandCols === 'object') {
        setBandColumns({
          mean: savedBandCols.mean || '',
          plus_1sd: savedBandCols.plus_1sd || '',
          minus_1sd: savedBandCols.minus_1sd || '',
          plus_2sd: savedBandCols.plus_2sd || '',
          minus_2sd: savedBandCols.minus_2sd || '',
        });
      } else {
        setBandColumns({ mean: '', plus_1sd: '', minus_1sd: '', plus_2sd: '', minus_2sd: '' });
      }
      setBandedBarStyle(chart.options?.bandedBarStyle || 'time_series');
      // Time bucket initialization (for socket datasources)
      // Load condition must match save condition: all three fields required
      const tb = chart.data_mapping?.time_bucket;
      const hasValidTimeBucket = tb?.interval > 0 && !!tb?.timestamp_col && (tb?.value_cols?.length || 0) > 0;
      setTimeBucketEnabled(hasValidTimeBucket);
      setTimeBucketInterval(tb?.interval || 60);
      setTimeBucketFunction(tb?.function || 'avg');
      setTimeBucketValueCols(tb?.value_cols || []);
      setTimeBucketTimestampCol(tb?.timestamp_col || '');
      // Parser initialization (per-component data extraction for streaming)
      const p = chart.data_mapping?.parser;
      if (p?.data_path || p?.timestamp_field) {
        setParserDataPath(p.data_path || '');
        setParserTimestampField(p.timestamp_field || '');
        setParserTimestampScale(p.timestamp_scale || '');
        // Detect preset. ts-store covers both MQTT and WebSocket transports
        // because both ts-store push paths use the same envelope shape.
        if (p.data_path === 'data' && p.timestamp_field === 'timestamp' && p.timestamp_scale === 'ns') {
          setParserPreset('tsstore');
        } else {
          setParserPreset('custom');
        }
      } else {
        setParserPreset('none');
        setParserDataPath('');
        setParserTimestampField('');
        setParserTimestampScale('');
      }
      // Debug logging for time bucket load
      if (tb) {
        console.log('[ComponentEditor] Loading time_bucket:', { tb, hasValidTimeBucket });
      }
      // TSStore query config initialization. We dispatch on the
      // saved raw shape (since:DURATION / newest / oldest) rather
      // than on query_config.type, because the type field is
      // documentary for tsstore — agent-built charts often save
      // type:"api" while still using the tsstore DSL on raw. The
      // shape of raw is the source of truth for which control to
      // restore.
      const rawQuery = chart.query_config?.raw || '';
      if (rawQuery.startsWith('since:')) {
        setTsstoreQueryType('since');
        setTsstoreSinceDuration(rawQuery.substring(6));
        setTsstoreLimit(chart.query_config?.params?.limit || 100);
      } else if (rawQuery === 'newest' || rawQuery === 'oldest') {
        setTsstoreQueryType(rawQuery);
        setTsstoreSinceDuration('1h');
        setTsstoreLimit(chart.query_config?.params?.limit || 100);
      }
      // EdgeLake query config initialization
      if (chart.query_config?.type === 'edgelake') {
        setEdgelakeDatabase(chart.query_config?.params?.database || '');
      }
      // MQTT initialization — restore selected topic and discover topics + schema
      if (chart.query_config?.type === 'mqtt') {
        const savedTopic = chart.query_config?.raw || '';
        setMqttSelectedTopic(savedTopic);
        // Discover topics from broker
        const dsId = chart.connection_id || chart.connection_id || '';
        if (dsId) {
          setMqttTopicsLoading(true);
          apiClient.getMQTTTopics(dsId).then(result => {
            setMqttTopics(result.topics || []);
          }).catch(() => {}).finally(() => {
            setMqttTopicsLoading(false);
          });
          // Sample the saved topic to get schema
          if (savedTopic) {
            setMqttSampling(true);
            apiClient.sampleMQTTTopic(dsId, savedTopic).then(result => {
              if (result.columns?.length > 0) {
                setAvailableColumns(result.columns);
                const sampleRow = result.columns.map(col => result.sample?.[col] ?? null);
                setPreviewData({ columns: result.columns, rows: [sampleRow] });
              }
            }).catch(() => {}).finally(() => {
              setMqttSampling(false);
            });
          }
        }
      }
      setComponentCode(chart.component_code || '');
      const usingCustomCode = chart.use_custom_code ?? (chart.chart_type === 'custom');
      setShowCustomCode(usingCustomCode);
      // Land on the Code tab for custom-code charts — that's the only meaningful
      // editing surface in this mode. With the data-mapping form hidden, the Code
      // tab is index 1 (Preview, Code) instead of 2.
      if (usingCustomCode) {
        setActiveTab(1);
      }
      // Initialize chart options from saved data
      if (chart.options) {
        setChartOptions(prev => ({
          ...prev,
          ...chart.options
        }));
      }
      // Snapshot mirrors the post-load values for every field in the diff —
      // including the legacy y_axis_label → y_axis_labels seeding and the
      // default aggregation shape — so the form doesn't read as dirty on
      // entry. Must list every field handleSave reads into the payload;
      // anything missing here silently won't trip the Save button.
      const loadedYAxisLabels = (() => {
        const arr = chart.data_mapping?.y_axis_labels;
        if (Array.isArray(arr) && arr.length > 0) return arr;
        if (chart.data_mapping?.y_axis_label) return [chart.data_mapping.y_axis_label];
        return [];
      })();
      const loadedVisibleSnap = chart.data_mapping?.visible_columns;
      const loadedTb = chart.data_mapping?.time_bucket;
      const loadedTbValid = loadedTb?.interval > 0 && !!loadedTb?.timestamp_col && (loadedTb?.value_cols?.length || 0) > 0;
      const loadedSw = chart.data_mapping?.sliding_window;
      const loadedParser = chart.data_mapping?.parser;
      const loadedParserPreset = (() => {
        if (!loadedParser?.data_path && !loadedParser?.timestamp_field) return 'none';
        if (loadedParser.data_path === 'data' && loadedParser.timestamp_field === 'timestamp' && loadedParser.timestamp_scale === 'ns') return 'tsstore';
        return 'custom';
      })();
      const loadedQueryType = chart.query_config?.type || 'sql';
      const loadedTsRaw = loadedQueryType === 'tsstore' ? (chart.query_config?.raw || 'newest') : '';
      const loadedTsstoreQueryType = loadedTsRaw.startsWith('since:') ? 'since' : (loadedTsRaw || 'since');
      const loadedTsstoreSinceDuration = loadedTsRaw.startsWith('since:') ? loadedTsRaw.substring(6) : '1h';
      const loadedTsstoreLimit = chart.query_config?.params?.limit || 100;
      const loadedEdgelakeDatabase = loadedQueryType === 'edgelake' ? (chart.query_config?.params?.database || '') : '';
      const loadedControlConfigSnap = chart.control_config || null;
      if (loadedControlConfigSnap && chart.connection_id && !loadedControlConfigSnap.connection_id) {
        loadedControlConfigSnap.connection_id = chart.connection_id;
      }
      setInitialState(JSON.stringify({
        name: chart.name || '',
        title: chart.title || '',
        description: chart.description || '',
        namespace: chart.namespace || 'default',
        tags: chart.tags || [],
        componentType: chart.component_type || 'chart',
        chartType: chart.chart_type || 'bar',
        controlConfig: loadedControlConfigSnap,
        displayConfig: chart.display_config || null,
        connectionId: chart.connection_id || '',
        queryRaw: chart.query_config?.raw || '',
        queryType: loadedQueryType,
        tsstoreQueryType: loadedTsstoreQueryType,
        tsstoreSinceDuration: loadedTsstoreSinceDuration,
        tsstoreLimit: loadedTsstoreLimit,
        edgelakeDatabase: loadedEdgelakeDatabase,
        xAxisColumn: chart.data_mapping?.x_axis || '',
        xAxisLabel: chart.data_mapping?.x_axis_label || '',
        xAxisFormat: chart.data_mapping?.x_axis_format || 'chart',
        yAxisColumns: chart.data_mapping?.y_axis || [],
        yAxisLabel: chart.data_mapping?.y_axis_label || '',
        yAxisLabels: loadedYAxisLabels,
        groupByColumn: chart.data_mapping?.group_by || '',
        seriesColumn: chart.data_mapping?.series || '',
        filters: chart.data_mapping?.filters || [],
        aggregation: chart.data_mapping?.aggregation || { type: '', sortBy: '', field: '', count: 10 },
        slidingWindowEnabled: loadedSw?.duration > 0 && !!loadedSw?.timestamp_col,
        slidingWindowDuration: loadedSw?.duration || 300,
        slidingWindowTimestampCol: loadedSw?.timestamp_col || '',
        timeBucketEnabled: loadedTbValid,
        timeBucketInterval: loadedTb?.interval || 60,
        timeBucketFunction: loadedTb?.function || 'avg',
        timeBucketValueCols: loadedTb?.value_cols || [],
        timeBucketTimestampCol: loadedTb?.timestamp_col || '',
        sortBy: chart.data_mapping?.sort_by || '',
        sortOrder: chart.data_mapping?.sort_order || 'desc',
        limitRows: chart.data_mapping?.limit || 0,
        columnAliases: chart.data_mapping?.column_aliases || {},
        visibleColumns: Array.isArray(loadedVisibleSnap) && loadedVisibleSnap.length > 0 ? loadedVisibleSnap : null,
        parserPreset: loadedParserPreset,
        parserDataPath: loadedParser?.data_path || '',
        parserTimestampField: loadedParser?.timestamp_field || '',
        parserTimestampScale: loadedParser?.timestamp_scale || '',
        bandColumns: chart.data_mapping?.band_columns || { mean: '', plus_1sd: '', minus_1sd: '', plus_2sd: '', minus_2sd: '' },
        bandedBarStyle: chart.options?.bandedBarStyle || 'time_series',
        // Capture chartOptions snapshot AS MERGED with defaults so it
        // matches whatever the state ends up holding after the
        // setChartOptions spread above. Otherwise dirty fires
        // immediately because the saved record carries fewer keys
        // than the state's defaults.
        chartOptions: { ...chartOptions, ...(chart.options || {}) },
        componentCode: chart.component_code || '',
        showCustomCode: chart.use_custom_code ?? (chart.chart_type === 'custom' || !!chart.component_code),
      }));
    } else {
      // New chart - reset to defaults; snapshot mirrors them. chartOptions
      // is intentionally NOT in the snapshot: numberSize lazy-loads from an
      // admin setting after mount, which would otherwise dirty the form on
      // its own. Edits to chart options that come from user interaction
      // travel via setState calls that pair with another tracked field
      // changing (chartType selection, etc.), so this is safe in practice.
      resetForm();
      setInitialState(JSON.stringify({
        name: '',
        title: '',
        description: '',
        namespace: activeNamespace || 'default',
        tags: [],
        componentType: 'chart',
        chartType: 'bar',
        controlConfig: null,
        displayConfig: null,
        connectionId: '',
        queryRaw: '',
        queryType: 'sql',
        tsstoreQueryType: 'newest',
        tsstoreSinceDuration: '1h',
        tsstoreLimit: 100,
        edgelakeDatabase: '',
        xAxisColumn: '',
        xAxisLabel: '',
        xAxisFormat: 'chart',
        yAxisColumns: [],
        yAxisLabel: '',
        yAxisLabels: [],
        groupByColumn: '',
        seriesColumn: '',
        filters: [],
        aggregation: { type: '', sortBy: '', field: '', count: 10 },
        slidingWindowEnabled: false,
        slidingWindowDuration: 300,
        slidingWindowTimestampCol: '',
        timeBucketEnabled: false,
        timeBucketInterval: 60,
        timeBucketFunction: 'avg',
        timeBucketValueCols: [],
        timeBucketTimestampCol: '',
        sortBy: '',
        sortOrder: 'desc',
        limitRows: 0,
        columnAliases: {},
        visibleColumns: null,
        parserPreset: 'none',
        parserDataPath: '',
        parserTimestampField: '',
        parserTimestampScale: '',
        bandColumns: { mean: '', plus_1sd: '', minus_1sd: '', plus_2sd: '', minus_2sd: '' },
        bandedBarStyle: 'time_series',
        // Snapshot current chartOptions state so the diff doesn't read
        // as dirty before the user touches anything. The lazy load of
        // numberSize from admin settings may mutate this after mount,
        // causing a one-time false-dirty on new charts — acceptable
        // tradeoff for getting toggles to actually enable Save.
        chartOptions,
        componentCode: '',
        showCustomCode: false,
      }));
    }
    setHasChanges(false);
  }, [chart]);

  // Track changes. Every field handleSave reads into the payload must
  // appear in BOTH the snapshot above and this diff, otherwise edits to
  // it silently won't dirty the form. chartOptions is included so the
  // chart-options toggles (Stacked, Smooth, Show Data Labels, Zoom
  // Slider, gauge/number/pie tweaks) actually enable Save. Earlier
  // versions excluded it to avoid false-dirty on chart-type-driven
  // default shifts — but the initial snapshot now captures chartOptions
  // at load time, so the diff only fires when the user actually changed
  // something.
  useEffect(() => {
    if (!initialState) return;
    const currentState = JSON.stringify({
      name,
      title,
      description,
      namespace,
      tags,
      componentType,
      chartType,
      controlConfig,
      displayConfig,
      connectionId: selectedConnectionId,
      queryRaw,
      queryType,
      tsstoreQueryType,
      tsstoreSinceDuration,
      tsstoreLimit,
      edgelakeDatabase,
      xAxisColumn,
      xAxisLabel,
      xAxisFormat,
      yAxisColumns,
      yAxisLabel,
      yAxisLabels,
      groupByColumn,
      seriesColumn,
      filters,
      aggregation,
      slidingWindowEnabled,
      slidingWindowDuration,
      slidingWindowTimestampCol,
      timeBucketEnabled,
      timeBucketInterval,
      timeBucketFunction,
      timeBucketValueCols,
      timeBucketTimestampCol,
      sortBy,
      sortOrder,
      limitRows,
      columnAliases,
      visibleColumns,
      parserPreset,
      parserDataPath,
      parserTimestampField,
      parserTimestampScale,
      bandColumns,
      bandedBarStyle,
      chartOptions,
      componentCode,
      showCustomCode,
    });
    const dirty = currentState !== initialState;
    setHasChanges(dirty);
    if (onDirtyChange) onDirtyChange(dirty);
  }, [
    name, title, description, namespace, tags, componentType, chartType,
    controlConfig, displayConfig, selectedConnectionId, queryRaw, queryType,
    tsstoreQueryType, tsstoreSinceDuration, tsstoreLimit, edgelakeDatabase,
    xAxisColumn, xAxisLabel, xAxisFormat, yAxisColumns, yAxisLabel, yAxisLabels,
    groupByColumn, seriesColumn, filters, aggregation,
    slidingWindowEnabled, slidingWindowDuration, slidingWindowTimestampCol,
    timeBucketEnabled, timeBucketInterval, timeBucketFunction, timeBucketValueCols, timeBucketTimestampCol,
    sortBy, sortOrder, limitRows, columnAliases, visibleColumns,
    parserPreset, parserDataPath, parserTimestampField, parserTimestampScale,
    bandColumns, bandedBarStyle, chartOptions,
    componentCode, showCustomCode, initialState, onDirtyChange,
  ]);

  // Notify parent of validity changes
  useEffect(() => {
    if (onValidityChange) {
      onValidityChange(!!name.trim());
    }
  }, [name, onValidityChange]);

  // Update selectedDatasource when ID changes
  useEffect(() => {
    if (selectedConnectionId && connections.length > 0) {
      const ds = connections.find(d => d.id === selectedConnectionId);
      setSelectedDatasource(ds || null);
    } else {
      setSelectedDatasource(null);
    }
  }, [selectedConnectionId, connections]);

  // Derived datasource type flags (used in multiple places)
  const isTSStore = selectedDatasource?.type === 'tsstore';

  // Connection types whose query language already expresses what
  // the client-side Filters / Aggregation / Sliding Window
  // sections do — SQL has WHERE/GROUP BY natively, EdgeLake's
  // AnyLog SQL covers the same ground. For these, the client-side
  // controls add cognitive load without earning their keep, so we
  // hide them. REST and Prometheus keep them (thinner query
  // languages), as do all streaming types where client-side
  // slicing of accumulated data is the primary use case.
  const queryLanguageOwnsClientSideOps =
    selectedDatasource?.type === 'sql' ||
    selectedDatasource?.type === 'edgelake';
  const isTSStoreStreaming = isTSStore && selectedDatasource?.config?.tsstore?.transport === 'streaming';
  const isSocket = selectedDatasource?.type === 'socket';
  const isMQTT = selectedDatasource?.type === 'mqtt';
  const isAPI = selectedDatasource?.type === 'api';

  const handleDatasourceChange = (newDatasourceId) => {
    setSelectedConnectionId(newDatasourceId);

    if (newDatasourceId && connections.length > 0) {
      const ds = connections.find(d => d.id === newDatasourceId);
      if (ds) {
        switch (ds.type) {
          case 'sql':
            setQueryType('sql');
            setQueryMode('visual'); // Default to visual query builder for SQL
            break;
          case 'api':
            setQueryType('api');
            setQueryMode('raw');
            break;
          case 'csv':
            setQueryType('csv_filter');
            setQueryMode('raw');
            break;
          case 'socket':
            setQueryType('stream_filter');
            setQueryMode('raw');
            break;
          case 'mqtt':
            setQueryType('mqtt');
            setQueryMode('visual');
            setQueryRaw('');
            setMqttSelectedTopic('');
            setMqttTopics([]);
            setAvailableColumns([]);
            setPreviewData(null);
            // Discover topics from broker
            setMqttTopicsLoading(true);
            apiClient.getMQTTTopics(newDatasourceId).then(result => {
              setMqttTopics(result.topics || []);
            }).catch(err => {
              console.error('[ComponentEditor] Failed to discover MQTT topics:', err);
            }).finally(() => {
              setMqttTopicsLoading(false);
            });
            break;
          case 'tsstore':
            setQueryType('tsstore');
            setQueryMode('raw');
            if (ds.config?.tsstore?.transport === 'streaming') {
              // Streaming transport — no REST query needed
              setQueryRaw('');
            } else {
              // REST transport — set default query
              setQueryRaw('newest');
              setTsstoreQueryType('newest');
              setTsstoreLimit(100);
              setTsstoreSinceDuration('1h');
            }
            break;
          case 'edgelake':
            setQueryType('edgelake');
            setQueryMode('visual');
            break;
          case 'prometheus':
            setQueryType('prometheus');
            setQueryMode('visual');
            break;
        }
      }
    }
  };

  // Handle MQTT topic selection — sample the topic to discover schema
  const handleMQTTTopicSelect = async (topic) => {
    setMqttSelectedTopic(topic);
    setQueryRaw(topic);
    setAvailableColumns([]);
    setPreviewData(null);
    setPreviewError(null);

    if (!topic) return;

    setMqttSampling(true);
    try {
      const result = await apiClient.sampleMQTTTopic(selectedConnectionId, topic);
      if (result.columns && result.columns.length > 0) {
        setAvailableColumns(result.columns);

        // Build a preview row from the sample
        const sampleRow = result.columns.map(col => result.sample?.[col] ?? null);
        setPreviewData({
          columns: result.columns,
          rows: [sampleRow]
        });

        // Auto-select first column as x-axis if not set
        if (!xAxisColumn && result.columns.length > 0) {
          // Prefer 'timestamp' as x-axis for MQTT
          const tsCol = result.columns.find(c => c === 'timestamp');
          setXAxisColumn(tsCol || result.columns[0]);
        }
        // Auto-select numeric-looking columns as y-axis if not set
        if (yAxisColumns.length === 0 && result.columns.length > 1) {
          // Skip timestamp and topic, pick first other column
          const candidates = result.columns.filter(c => c !== 'timestamp' && c !== 'topic');
          if (candidates.length > 0) {
            setYAxisColumns([candidates[0]]);
          }
        }
      } else if (result.timeout) {
        setPreviewError('No messages received from this topic within 3 seconds. The device may be inactive.');
      }
    } catch (err) {
      setPreviewError(`Failed to sample topic: ${err.message}`);
    } finally {
      setMqttSampling(false);
    }
  };

  const resetForm = () => {
    setName('');
    setDescription('');
    setNamespace(activeNamespace || 'default');
    setChartType('bar');
    setSelectedConnectionId('');
    setSelectedDatasource(null);
    setQueryRaw('');
    setQueryType('sql');
    setXAxisColumn('');
    setXAxisLabel('');
    setXAxisFormat('chart');
    setYAxisColumns([]);
    setYAxisLabel('');
    setYAxisLabels([]);
    setGroupByColumn('');
    setSeriesColumn('');
    setFilters([]);
    setAggregation({ type: '', sortBy: '', field: '', count: 10 });
    setSortBy('');
    setSortOrder('desc');
    setLimitRows(0);
    setSlidingWindowEnabled(false);
    setSlidingWindowDuration(300);
    setSlidingWindowTimestampCol('');
    setBandColumns({ mean: '', plus_1sd: '', minus_1sd: '', plus_2sd: '', minus_2sd: '' });
    setBandedBarStyle('time_series');
    setTimeBucketEnabled(false);
    setTimeBucketInterval(60);
    setTimeBucketFunction('avg');
    setTimeBucketValueCols([]);
    setTimeBucketTimestampCol('');
    setTsstoreQueryType('newest');
    setTsstoreLimit(100);
    setTsstoreSinceDuration('1h');
    setEdgelakeDatabase('');
    setComponentCode('');
    setShowCustomCode(false);
    setPreviewData(null);
    setPreviewError(null);
    setAvailableColumns([]);
  };

  const fetchDatasources = async () => {
    try {
      // Must go through apiClient — raw fetch() sends no auth headers,
      // which 401s under the session-token model. apiClient attaches
      // the access JWT (or API key) automatically.
      const data = await apiClient.getConnections({ page: 1, page_size: 100 });
      if (data?.connections) {
        setConnections(data.connections);
      }
    } catch (err) {
      console.error('Failed to fetch connections:', err);
    }
  };

  const fetchPreviewData = async () => {
    if (!selectedConnectionId) {
      setPreviewError('Please select a connection');
      return;
    }

    // Socket, API, and TSStore datasources don't require manual query entry
    if (!isSocket && !isMQTT && !isAPI && !isTSStore && !queryRaw.trim()) {
      setPreviewError('Please enter a query');
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null); // Clear previous results on every new capture/query

    // Cancel any in-progress MQTT capture
    if (mqttCaptureRef.current) {
      mqttCaptureRef.current.close();
      mqttCaptureRef.current = null;
    }

    // MQTT: capture from SSE stream on the frontend (no REST query support for MQTT)
    // Stays open until data arrives + 2s buffer, or user clicks "Stop Capture", or 5 min max timeout.
    // NOTE: This block is outside try/catch/finally so setPreviewLoading stays true until finishCapture.
    if (isMQTT) {
        // EventSource auth: access JWT rides ?st= (the apiClient
        // helper centralizes the query-string shape).
        const authParam = apiClient.streamAuthQuery();
        const topicParam = queryRaw ? `&topics=${encodeURIComponent(queryRaw)}` : '';
        const sseUrl = `${API_BASE}/api/connections/${selectedConnectionId}/stream?${authParam}${topicParam}`;
        const es = new EventSource(sseUrl);
        mqttCaptureRef.current = es;
        const rawRecords = [];
        const records = [];

        const activeParser = parserPreset !== 'none' && (parserDataPath || parserTimestampField)
          ? { dataPath: parserDataPath, timestampField: parserTimestampField, timestampScale: parserTimestampScale }
          : null;

        const applyParserToRecord = (raw) => {
          if (!activeParser) return { ...raw };
          const parsed = {};
          if (activeParser.timestampField) {
            const parts = activeParser.timestampField.split('.');
            let ts = raw; for (const p of parts) { ts = ts?.[p]; }
            if (ts != null && typeof ts === 'number') {
              if (activeParser.timestampScale === 'ns') ts = ts / 1e9;
              else if (activeParser.timestampScale === 'ms') ts = ts / 1e3;
              else if (!activeParser.timestampScale) { if (ts > 1e15) ts = ts / 1e9; else if (ts > 1e12) ts = ts / 1e3; }
              parsed.timestamp = ts;
            }
          }
          if (activeParser.dataPath) {
            const parts = activeParser.dataPath.split('.');
            let nested = raw; for (const p of parts) { nested = nested?.[p]; }
            if (nested && typeof nested === 'object') Object.assign(parsed, nested);
          }
          return Object.keys(parsed).length > 0 ? parsed : { ...raw };
        };

        let firstRecordTimer = null;

        const finishCapture = () => {
          es.close();
          mqttCaptureRef.current = null;
          if (firstRecordTimer) clearTimeout(firstRecordTimer);

          if (rawRecords.length === 0) {
            setPreviewError('No messages received. The topic may not be publishing or try pasting a sample above.');
            setPreviewLoading(false);
            return;
          }

          // Store raw records for re-parsing when parser changes
          mqttRawRecordsRef.current = rawRecords;

          // Populate sample input with first raw record for parser testing
          setParserSampleInput(JSON.stringify(rawRecords[0], null, 2));

          // Build preview from parsed (or raw) records
          const displayRecords = records.length > 0 ? records : rawRecords;
          const columns = Object.keys(displayRecords[0]);
          const rows = displayRecords.map(r => columns.map(c => r[c]));
          setPreviewData({ columns, rows, metadata: { row_count: rows.length } });
          if (columns.length > 0) {
            setAvailableColumns(columns);
            if (!xAxisColumn) setXAxisColumn(columns[0]);
            if (yAxisColumns.length === 0 && columns.length > 1) setYAxisColumns([columns[1]]);
          }
          setPreviewLoading(false);
        };

        es.addEventListener('record', (event) => {
          try {
            const raw = JSON.parse(event.data);
            rawRecords.push(raw);
            records.push(applyParserToRecord(raw));

            if (rawRecords.length === 1) {
              firstRecordTimer = setTimeout(finishCapture, 2000);
            }
          } catch { /* ignore parse errors */ }
        });

        es.onerror = () => {
          if (mqttCaptureRef.current === null) {
            finishCapture();
          }
        };

        setTimeout(() => {
          if (mqttCaptureRef.current === es) {
            finishCapture();
          }
        }, 300000); // 5 minute max timeout

      return; // Don't fall through to the REST query path
    }

    try {
      // Build query params based on datasource type
      let queryParams = {};
      let rawQuery = queryRaw;

      if (isSocket || isTSStoreStreaming) {
        rawQuery = ''; // Streaming doesn't need a query string — fetch newest for schema discovery
      } else if (isTSStore) {
        // Build TSStore query: 'newest', 'oldest', or 'since:DURATION'
        if (tsstoreQueryType === 'since') {
          // For 'since' queries, don't limit - fetch all data in time window
          rawQuery = `since:${tsstoreSinceDuration}`;
          queryParams = {};
        } else {
          // For 'newest' or 'oldest', use the configured limit
          rawQuery = tsstoreQueryType;
          queryParams = { limit: tsstoreLimit };
        }
      } else if (selectedDatasource?.type === 'edgelake' && edgelakeDatabase) {
        queryParams = { database: edgelakeDatabase };
      }

      // Must go through apiClient — raw fetch() sends no auth headers
      // and 401s under session-token auth. apiClient attaches the
      // access JWT (or API key) and throws an Error with .status / .body
      // on non-2xx, so the existing error handling works unchanged.
      const data = await apiClient.queryConnection(selectedConnectionId, {
        raw: rawQuery,
        type: queryType,
        params: queryParams,
      });

      setPreviewData(data.result_set);

      if (data.result_set?.columns) {
        setAvailableColumns(data.result_set.columns);

        if (!xAxisColumn && data.result_set.columns.length > 0) {
          setXAxisColumn(data.result_set.columns[0]);
        }
        if (yAxisColumns.length === 0 && data.result_set.columns.length > 1) {
          setYAxisColumns([data.result_set.columns[1]]);
        }
      }
    } catch (err) {
      setPreviewError(err.message);
      setPreviewData(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const generatedCode = useMemo(() => {
    if (showCustomCode && componentCode) {
      return componentCode;
    }

    if (!selectedConnectionId) {
      return getStaticChartCode(chartType);
    }

    // Build queryParams based on datasource type (same logic as fetchPreview)
    let queryParams = {};
    let rawQuery = queryRaw;
    if (isTSStoreStreaming) {
      // Streaming TS-STORE — no query needed, data arrives via SSE
      rawQuery = '';
      queryParams = {};
    } else if (isTSStore) {
      if (tsstoreQueryType === 'since') {
        // For 'since' queries, don't limit - fetch all data in time window
        rawQuery = `since:${tsstoreSinceDuration}`;
        queryParams = {};
      } else {
        // For 'newest' or 'oldest', use the configured limit
        rawQuery = tsstoreQueryType;
        queryParams = { limit: tsstoreLimit };
      }
    } else if (selectedDatasource?.type === 'edgelake' && edgelakeDatabase) {
      queryParams = { database: edgelakeDatabase };
    }

    const transforms = {
      filters,
      aggregation: aggregation.type ? aggregation : null,
      sortBy,
      sortOrder,
      limit: limitRows || 0,
      xAxisFormat: xAxisFormat || 'chart',
      xAxisLabel: xAxisLabel || '',
      yAxisLabel: yAxisLabel || '',
      yAxisLabels: yAxisLabels || [],
      visibleColumns: Array.isArray(visibleColumns) ? visibleColumns : null,
      chartName: title || name || '', // Display Title takes precedence, falls back to Chart Name
      bandColumns: chartType === 'banded_bar' ? bandColumns : null,
      bandedBarStyle,
    };

    const slidingWindow = slidingWindowEnabled && slidingWindowTimestampCol
      ? { duration: slidingWindowDuration, timestampCol: slidingWindowTimestampCol }
      : null;

    const activeParser = parserPreset !== 'none' && (parserDataPath || parserTimestampField)
      ? { dataPath: parserDataPath, timestampField: parserTimestampField, timestampScale: parserTimestampScale }
      : null;

    return getDataDrivenChartCode(chartType, selectedConnectionId, rawQuery, queryType, xAxisColumn, yAxisColumns, transforms, chartOptions, queryParams, seriesColumn, columnAliases, isTSStoreStreaming || isMQTT, slidingWindow, activeParser, chart?.id || '', isTSStoreStreaming);
  }, [chartType, selectedConnectionId, queryRaw, queryType, xAxisColumn, xAxisLabel, xAxisFormat, yAxisColumns, yAxisLabel, yAxisLabels, filters, aggregation, sortBy, sortOrder, limitRows, showCustomCode, componentCode, name, title, chartOptions, selectedDatasource, tsstoreLimit, tsstoreQueryType, tsstoreSinceDuration, seriesColumn, edgelakeDatabase, columnAliases, visibleColumns, isTSStoreStreaming, isMQTT, slidingWindowEnabled, slidingWindowDuration, slidingWindowTimestampCol, parserPreset, parserDataPath, parserTimestampField, parserTimestampScale, bandColumns, bandedBarStyle]);

  const filteredPreviewData = useMemo(() => {
    if (!previewData) return null;

    // Only include filters that are "complete" (have field, operator, and value if needed)
    const completeFilters = filters.filter(f => {
      if (!f.field || !f.op) return false;
      // isNull and isNotNull don't need a value
      if (f.op === 'isNull' || f.op === 'isNotNull') return true;
      // All other operators need a non-empty value
      return f.value !== '' && f.value !== undefined && f.value !== null;
    });

    const hasTransforms = completeFilters.length > 0 || aggregation?.type || sortBy || limitRows > 0;
    if (!hasTransforms) return previewData;

    const parsedFilters = completeFilters.map(f => ({
      field: f.field,
      op: f.op,
      value: (f.op === 'in' || f.op === 'notIn') && typeof f.value === 'string'
        ? f.value.split(',').map(v => v.trim())
        : f.value
    }));

    const transforms = {
      filters: parsedFilters,
      aggregation: aggregation?.type ? aggregation : null,
      sortBy: sortBy || null,
      sortOrder: sortOrder || 'desc',
      limit: limitRows || 0
    };

    const result = transformData(previewData, transforms);
    return {
      columns: result.columns,
      rows: result.rows,
      metadata: {
        ...previewData.metadata,
        row_count: result.rows.length,
        original_row_count: previewData.rows?.length || 0,
        filtered: completeFilters.length > 0
      }
    };
  }, [previewData, filters, aggregation, sortBy, sortOrder, limitRows]);

  const handleSave = () => {
    if (!name.trim()) {
      alert('Please enter a chart name');
      return;
    }

    // Sliding window requires a timestamp column to be meaningful. If
    // the toggle is on but the column is empty, the save would silently
    // strip the sliding_window block entirely (see line below where
    // both flags are required to persist), and the user would see the
    // toggle flip back off on reload. Block save instead so they pick
    // a column or turn the toggle off explicitly.
    if (slidingWindowEnabled && !slidingWindowTimestampCol) {
      alert('Sliding Window is enabled but no Timestamp Column is selected. Pick a timestamp column or turn off Sliding Window before saving.');
      return;
    }

    const chartPayload = {
      name: name.trim(),
      title: title.trim() || name.trim(), // Default to name if no title provided
      description: description.trim(),
      namespace,
      tags,
      component_type: componentType,
      chart_type: componentType === 'chart' ? chartType : '',
      control_config: componentType === 'control' ? controlConfig : null,
      display_config: componentType === 'display' ? displayConfig : null,
      connection_id: componentType === 'control' ? (controlConfig?.connection_id || '') : (selectedConnectionId || ''),
      query_config: selectedConnectionId ? {
        raw: selectedDatasource?.type === 'tsstore'
          ? (tsstoreQueryType === 'since' ? `since:${tsstoreSinceDuration}` : tsstoreQueryType)
          : queryRaw,
        type: queryType,
        params: selectedDatasource?.type === 'tsstore'
          ? (tsstoreQueryType === 'since' ? {} : { limit: tsstoreLimit })
          : selectedDatasource?.type === 'edgelake' && edgelakeDatabase
            ? { database: edgelakeDatabase }
            : {}
      } : null,
      data_mapping: selectedConnectionId ? {
        x_axis: xAxisColumn,
        x_axis_label: xAxisLabel || '',
        x_axis_format: xAxisFormat || 'chart',
        y_axis: yAxisColumns,
        // y_axis_label kept for back-compat; y_axis_labels is the new per-column source of truth.
        y_axis_label: (yAxisLabels && yAxisLabels[0]) || yAxisLabel || '',
        y_axis_labels: yAxisLabels && yAxisLabels.length > 0 ? yAxisLabels : undefined,
        group_by: groupByColumn || '',
        series: seriesColumn || '', // Column for series partitioning in time buckets
        filters: filters.length > 0 ? filters : [],
        aggregation: aggregation.type ? aggregation : null,
        sliding_window: slidingWindowEnabled && slidingWindowTimestampCol ? {
          duration: slidingWindowDuration,
          timestamp_col: slidingWindowTimestampCol
        } : null,
        time_bucket: (() => {
          const willSave = timeBucketEnabled && timeBucketTimestampCol && timeBucketValueCols.length > 0;
          // Debug logging for time bucket save
          if (timeBucketEnabled) {
            console.log('[ComponentEditor] Time bucket save check:', {
              timeBucketEnabled,
              timeBucketTimestampCol,
              timeBucketValueCols,
              timeBucketInterval,
              timeBucketFunction,
              willSave,
              reason: !timeBucketTimestampCol ? 'Missing timestamp column' :
                      timeBucketValueCols.length === 0 ? 'No value columns selected' : 'OK'
            });
          }
          return willSave ? {
            interval: timeBucketInterval,
            function: timeBucketFunction,
            value_cols: timeBucketValueCols,
            timestamp_col: timeBucketTimestampCol
          } : null;
        })(),
        sort_by: sortBy || '',
        sort_order: sortOrder || 'desc',
        limit: limitRows || 0,
        column_aliases: Object.keys(columnAliases).length > 0 ? columnAliases : null,
        visible_columns: Array.isArray(visibleColumns) && visibleColumns.length > 0 ? visibleColumns : undefined,
        parser: parserPreset !== 'none' && (parserDataPath || parserTimestampField) ? {
          data_path: parserDataPath || undefined,
          timestamp_field: parserTimestampField || undefined,
          timestamp_scale: parserTimestampScale || undefined
        } : null,
        // Banded-bar column mapping — only persisted for chart_type 'banded_bar'.
        // Each row in the data must carry the named columns; the renderer
        // reads each row's own values to draw a per-row envelope.
        band_columns: chartType === 'banded_bar' && bandColumns?.mean ? bandColumns : undefined
      } : null,
      component_code: showCustomCode ? componentCode : generatedCode,
      use_custom_code: showCustomCode,
      options: chartType === 'banded_bar'
        ? { ...chartOptions, bandedBarStyle }
        : chartOptions,
    };

    onSave(chartPayload);
  };

  const _handleYAxisToggle = (column) => {
    setYAxisColumns(prev => {
      if (prev.includes(column)) {
        return prev.filter(c => c !== column);
      } else {
        return [...prev, column];
      }
    });
  };

  const addFilter = () => {
    setFilters(prev => [...prev, { field: availableColumns[0] || '', op: 'eq', value: '' }]);
  };

  const updateFilter = (index, field, value) => {
    setFilters(prev => prev.map((f, i) => i === index ? { ...f, [field]: value } : f));
  };

  const removeFilter = (index) => {
    setFilters(prev => prev.filter((_, i) => i !== index));
  };

  const updateAggregation = (field, value) => {
    setAggregation(prev => ({ ...prev, [field]: value }));
  };

  // Expose methods via ref for modal usage. Route every call through a
  // latest-value ref so the imperative methods always read the freshest
  // closure — without this, useImperativeHandle's deps array would freeze
  // handleSave at whatever state existed last time `name` or `hasChanges`
  // changed, dropping connection_id / data_mapping edits made afterward.
  const latestRef = useRef({ handleSave, name, hasChanges });
  latestRef.current = { handleSave, name, hasChanges };
  useImperativeHandle(ref, () => ({
    save: () => latestRef.current.handleSave(),
    getName: () => latestRef.current.name,
    isValid: () => !!latestRef.current.name.trim(),
    hasUnsavedChanges: () => latestRef.current.hasChanges,
  }), []);

  return (
    <div className={`component-editor ${className}`}>
      {/* Custom code mode banner — replaces the data-mapping form with the code editor.
          Action button gives the user a one-click escape back to generated mode. */}
      {showCustomCode && componentType === 'chart' && (
        <InlineNotification
          kind="warning"
          title="Custom Code Mode"
          subtitle="Data mapping is bypassed — the chart renders the code below verbatim. Switch to generated code to edit the mapping form again."
          lowContrast
          hideCloseButton
          className="custom-code-warning"
          actions={
            <NotificationActionButton
              onClick={() => {
                setShowCustomCode(false);
                setActiveTab(0);
              }}
            >
              Switch to Generated Code
            </NotificationActionButton>
          }
        />
      )}

      {/* Component type selector - Chart vs Display vs Control.
          Tabs hide entirely when no enabled subtypes exist for that category
          in this deployment. The current component's category is always shown
          (so editing an existing Display component still works even if all
          display types are now disabled). */}
      <div className="component-type-section">
        {(() => {
          const hasEnabledDisplays = (enabledDisplayTypes?.filter((t) => !t.hidden).length || 0) > 0;
          const hasEnabledControls = (enabledControlTypes?.filter((t) => !t.hidden).length || 0) > 0;
          const tabs = [{ name: 'chart', text: 'Chart' }];
          if (hasEnabledDisplays || componentType === 'display') {
            tabs.push({ name: 'display', text: 'Display' });
          }
          if (hasEnabledControls || componentType === 'control') {
            tabs.push({ name: 'control', text: 'Control' });
          }
          // If the current selection got hidden (e.g., admin disabled all
          // displays while we were on the Display tab without an existing
          // component), fall back to chart so the selector index resolves.
          const visibleNames = tabs.map((t) => t.name);
          const effectiveType = visibleNames.includes(componentType) ? componentType : 'chart';
          const selectedIndex = visibleNames.indexOf(effectiveType);
          if (effectiveType !== componentType) {
            // Schedule a state correction once on render — no infinite loop
            // because the next render's componentType will match.
            setTimeout(() => setComponentType(effectiveType), 0);
          }
          // Custom-code charts must stay on the chart subtype — switching to
          // display/control would orphan the user's code, since those subtypes
          // ignore component_code entirely. The non-chart switches render
          // disabled so the user can see the alternatives exist but can't
          // navigate into them without first switching back to generated code.
          const lockedToChart = showCustomCode && componentType === 'chart';
          return (
            <ContentSwitcher
              selectedIndex={Math.max(0, selectedIndex)}
              onChange={({ index }) => {
                const newType = tabs[index]?.name;
                if (!newType) return;
                if (lockedToChart && newType !== 'chart') return;
                setComponentType(newType);
                if (newType === 'control' && !controlConfig) {
                  const firstEnabled = enabledControlTypes?.find((t) => !t.hidden)?.subtype || 'button';
                  setControlConfig({
                    control_type: firstEnabled,
                    command_config: { action: '', target: '', payload_template: {} },
                    ui_config: { label: 'Execute', kind: 'primary' }
                  });
                }
                if (newType === 'display' && !displayConfig) {
                  const firstEnabled = enabledDisplayTypes?.[0]?.subtype;
                  if (firstEnabled) setDisplayConfig({ display_type: firstEnabled });
                }
              }}
              className="component-type-switcher"
            >
              {tabs.map((t) => (
                <Switch
                  key={t.name}
                  name={t.name}
                  text={t.text}
                  disabled={lockedToChart && t.name !== 'chart'}
                />
              ))}
            </ContentSwitcher>
          );
        })()}
      </div>

      {/* Header form for the chart sub-tab. Layout:
            row 1: Name (1/2)     Title (1/2)
            row 2: Description (full)
            row 3: Namespace (1/4) Tags (3/4)
          Reference width = the section's max-width (set in SCSS to
          the same value Title used to occupy). Nothing in this form
          overflows that width — see component-editor-header-form-
          rearrange memory. */}
      <div className="chart-metadata-section">
        <div className="metadata-row metadata-row--split">
          <div className="metadata-col metadata-col--half">
            <TextInput
              id="chart-name"
              labelText={componentType === 'control' ? 'Control Name' : componentType === 'display' ? 'Display Name' : 'Chart Name'}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError('');
              }}
              onBlur={(e) => checkDuplicateChartName(e.target.value)}
              placeholder={componentType === 'control' ? 'Enter control name' : componentType === 'display' ? 'Enter display name' : 'Enter chart name'}
              size="md"
              invalid={!!nameError}
              invalidText={nameError}
              helperText="Internal identifier; must be unique within the namespace"
            />
          </div>
          <div className="metadata-col metadata-col--half">
            <TextInput
              id="chart-title"
              labelText="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={name || (componentType === 'control' ? 'Defaults to control name' : 'Defaults to chart name')}
              size="md"
              helperText={componentType === 'control' ? 'Title shown on dashboards (defaults to control name)' : 'Title shown on dashboards (defaults to chart name)'}
            />
          </div>
        </div>
        <div className="metadata-row">
          <div className="metadata-col metadata-col--full">
            <TextInput
              id="chart-description"
              labelText="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={componentType === 'control' ? 'Enter control description' : 'Enter chart description'}
              size="md"
            />
          </div>
        </div>
        <div className="metadata-row metadata-row--split">
          <div className="metadata-col metadata-col--quarter">
            <NamespaceSelect
              id="chart-namespace"
              value={namespace}
              onChange={setNamespace}
            />
          </div>
          <div className="metadata-col metadata-col--three-quarters">
            <TagInput
              id="chart-tags"
              label="Tags"
              value={tags}
              onChange={setTags}
            />
          </div>
        </div>
      </div>

      {/* Chart Type section — shown when componentType is 'chart'.
          Hidden in custom-code mode since the chart type drives the
          generated code, which is bypassed when the user supplies
          their own. Wrapped in `.mapping-section` so it visually
          matches the DATA MAPPING section below (bordered card,
          labeled header, full reference width). */}
      {componentType === 'chart' && !showCustomCode && (() => {
        const currentChartType = CHART_TYPES.find(t => t.id === chartType) || CHART_TYPES[0];
        const TypeIcon = currentChartType.icon;
        return (
          <div className="mapping-section type-card-section">
            <h4>Chart Type</h4>
            <div className="type-card-current" onClick={() => setChartTypeModalOpen(true)}>
              <Button kind="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setChartTypeModalOpen(true); }}>
                Change
              </Button>
              {TypeIcon && <TypeIcon size={20} />}
              <div className="type-card-info">
                <span className="type-card-label">{currentChartType.label}</span>
                <span className="type-card-description">{currentChartType.description}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Chart Type Selection Modal — portaled to body to escape parent modal */}
      {chartTypeModalOpen && createPortal(
        <Modal
          open
          onRequestClose={() => setChartTypeModalOpen(false)}
          onRequestSubmit={() => setChartTypeModalOpen(false)}
          modalHeading="Select Chart Type"
          primaryButtonText="Close"
          size="sm"
          className="type-selection-modal"
        >
          <div className="type-selection-grid">
            {/* Disabled chart types are hidden, but the active type stays
                visible so editing existing charts of that type still works. */}
            {CHART_TYPES.filter(t => isChartTypeEnabled(t.id) || t.id === chartType).map(type => {
              const TypeIcon = type.icon;
              return (
                <div
                  key={type.id}
                  className={`type-selection-item ${chartType === type.id ? 'selected' : ''}`}
                  onClick={() => {
                    handleChartTypeChange(type.id);
                    setShowCustomCode(type.id === 'custom');
                    setChartTypeModalOpen(false);
                  }}
                >
                  {TypeIcon && <TypeIcon size={24} />}
                  <div className="type-selection-info">
                    <span className="type-selection-label">{type.label}</span>
                    <span className="type-selection-description">{type.description}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </Modal>,
        document.body
      )}

      {/* Control Editor - shown when componentType is 'control' */}
      {componentType === 'control' && (
        <ControlEditor
          controlConfig={controlConfig}
          connectionId={controlConfig?.connection_id || selectedConnectionId || ''}
          displayTitle={title}
          onControlConfigChange={(newConfig) => setControlConfig(newConfig)}
          onConnectionIdChange={(connId) => setControlConfig(prev => ({ ...prev, connection_id: connId }))}
        />
      )}

      {/* Display Editor - shown when componentType is 'display' */}
      {componentType === 'display' && (
        <DisplayEditor
          displayConfig={displayConfig}
          onDisplayConfigChange={(newConfig) => setDisplayConfig(newConfig)}
        />
      )}

      {/* Chart Configuration - shown when componentType is 'chart'.
          The Connection tab stays visible in custom-code mode because the
          connection + query + parser + sliding window all govern what
          `data` looks like at runtime — those fields aren't in the React
          code but they shape its input. Inside the tab, the data-mapping
          and chart-options subsections hide themselves when in custom-
          code mode (the user controls those things directly in their
          JSX, so the form values are no longer load-bearing). */}
      {componentType === 'chart' && (() => {
        // In custom-code mode the Details tab is misleading — the
        // connection + query are already shown inline inside the
        // custom-code section above, and the Details tab's
        // Fetch Data button doesn't drive custom code anyway. If
        // the user wants to modify the data path they switch to
        // generated code. Drop the tab entirely in this mode.
        const tabs = showCustomCode
          ? [
              { key: 'preview', label: 'Preview' },
              { key: 'code', label: 'Code' },
            ]
          : [
              { key: 'datasource', label: 'Details' },
              { key: 'preview', label: 'Preview' },
              { key: 'code', label: 'Code' },
            ];
        const activeKey = tabs[Math.min(activeTab, tabs.length - 1)]?.key || tabs[0].key;
        const isOnTab = (key) => activeKey === key;
        return (
        <>
          <div className="component-editor-switcher-wrapper">
            <ContentSwitcher
              selectedIndex={Math.min(activeTab, tabs.length - 1)}
              onChange={({ index }) => setActiveTab(index)}
              className="component-editor-switcher"
            >
              {tabs.map((t) => (
                <Switch key={t.key} name={t.key} text={t.label} />
              ))}
            </ContentSwitcher>
          </div>

          <div className="tab-panels">
        {/* Connection Tab */}
        {isOnTab('datasource') && (
          <div className="tab-content">
            {/* Connection picker tile + per-type guidance side-by-
                side. Left tile holds the Select (with an info
                Toggletip exposing the connection's description) and
                a tag row below (type chip + the connection's user
                tags). Right column holds the ConnectionGuidanceHint
                so the cheat-sheet sits adjacent to the picker. */}
            <div className="connection-row">
              <div className="connection-row__picker mapping-section">
                <div className="connection-picker-header">
                  <h4>Connection</h4>
                  {selectedDatasource?.description && (
                    <Tooltip
                      align="bottom"
                      label={selectedDatasource.description}
                      className="connection-picker-info-tooltip"
                    >
                      <button
                        type="button"
                        className="connection-picker-info-trigger"
                        aria-label="Connection description"
                      >
                        <Information size={16} />
                      </button>
                    </Tooltip>
                  )}
                </div>
                <Select
                  id="datasource-select"
                  labelText=""
                  hideLabel
                  value={selectedConnectionId}
                  onChange={(e) => handleDatasourceChange(e.target.value)}
                >
                  <SelectItem value="" text="Select a connection..." />
                  {connections.map(ds => (
                    <SelectItem
                      key={ds.id}
                      value={ds.id}
                      text={`${ds.name} (${ds.type})`}
                    />
                  ))}
                </Select>
                {selectedDatasource && (() => {
                  // Compose tag chip list: type chip first, then
                  // the connection's user-defined tags. Truncate
                  // to keep the row from wrapping wider than the
                  // tile; surface the full list in a tooltip on
                  // the "+N more" overflow.
                  const userTags = Array.isArray(selectedDatasource.tags) ? selectedDatasource.tags : [];
                  const chips = [
                    { label: selectedDatasource.type, kind: 'type' },
                    ...userTags.map(t => ({ label: t, kind: 'user' })),
                  ];
                  const VISIBLE_TAG_CAP = 4;
                  const visible = chips.slice(0, VISIBLE_TAG_CAP);
                  const overflow = chips.slice(VISIBLE_TAG_CAP);
                  return (
                    <div className="connection-tags-row">
                      {visible.map((chip, i) => (
                        <Tag
                          key={`${chip.kind}-${chip.label}-${i}`}
                          type={chip.kind === 'type' ? 'blue' : 'gray'}
                          size="sm"
                        >
                          {chip.label}
                        </Tag>
                      ))}
                      {overflow.length > 0 && (
                        <Toggletip align="bottom">
                          <ToggletipButton label={`Show ${overflow.length} more tag${overflow.length === 1 ? '' : 's'}`}>
                            <span className="connection-tags-overflow">+{overflow.length}…</span>
                          </ToggletipButton>
                          <ToggletipContent>
                            <p>
                              {chips.map(c => c.label).join(', ')}
                            </p>
                          </ToggletipContent>
                        </Toggletip>
                      )}
                    </div>
                  );
                })()}
              </div>
              <div className="connection-row__guidance">
                {selectedDatasource && (
                  <ConnectionGuidanceHint typeId={selectedDatasource.type} />
                )}
              </div>
            </div>

            {selectedDatasource && (
              <>
                {/* Query + Guidance row. Two cards side-by-side at
                    half the reference width each: the Query
                    configuration on the left, and the connection-
                    type Query Conventions hint on the right. The
                    guidance card stretches to match the query
                    card's height and scrolls internally when
                    expanded, so it never pushes the form taller
                    than the query controls require. */}
                <div className="query-row">
                <div className="query-section mapping-section query-row__query">
                  <div className="query-header">
                    <h4>{selectedDatasource.type === 'socket' ? 'Stream Capture' : selectedDatasource.type === 'mqtt' ? 'Topic Selection' : 'Query'}</h4>
                    <div className="query-header-actions">
                      {selectedDatasource.type === 'sql' && (
                        <ContentSwitcher
                          size="sm"
                          selectedIndex={queryMode === 'visual' ? 0 : 1}
                          onChange={(e) => setQueryMode(e.name)}
                          className="query-mode-switcher"
                        >
                          <Switch name="visual" text="Visual" />
                          <Switch name="raw" text="Raw SQL" />
                        </ContentSwitcher>
                      )}
                      {selectedDatasource.type === 'prometheus' && (
                        <ContentSwitcher
                          size="sm"
                          selectedIndex={queryMode === 'visual' ? 0 : 1}
                          onChange={(e) => setQueryMode(e.name)}
                          className="query-mode-switcher"
                        >
                          <Switch name="visual" text="Visual" />
                          <Switch name="raw" text="PromQL" />
                        </ContentSwitcher>
                      )}
                      {selectedDatasource.type === 'mqtt' && (
                        <ContentSwitcher
                          size="sm"
                          selectedIndex={queryMode === 'visual' ? 0 : 1}
                          onChange={(e) => setQueryMode(e.name)}
                          className="query-mode-switcher"
                          style={{ minWidth: '200px' }}
                        >
                          <Switch name="visual" text="Topic List" />
                          <Switch name="raw" text="Manual" />
                        </ContentSwitcher>
                      )}
                      {selectedDatasource.type === 'edgelake' && (
                        <ContentSwitcher
                          size="sm"
                          selectedIndex={queryMode === 'visual' ? 0 : 1}
                          onChange={(e) => setQueryMode(e.name)}
                          className="query-mode-switcher"
                        >
                          <Switch name="visual" text="Visual" />
                          <Switch name="raw" text="Raw SQL" />
                        </ContentSwitcher>
                      )}
                      {/* Unified "Fetch Data" button across all
                          connection types — see component-editor
                          terminology audit (2026-05-27). The only
                          exception is MQTT mid-capture, which keeps
                          a dedicated "Stop Capture" affordance
                          (different semantics, different handler).
                          Per-type disabled logic preserved verbatim. */}
                      {selectedDatasource.type === 'socket' || isTSStoreStreaming ? (
                        <Button
                          kind="tertiary"
                          size="sm"
                          renderIcon={Play}
                          onClick={fetchPreviewData}
                          disabled={previewLoading}
                        >
                          {previewLoading ? 'Fetching…' : 'Fetch Data'}
                        </Button>
                      ) : isMQTT ? (
                        previewLoading ? (
                          <Button
                            kind="danger--tertiary"
                            size="sm"
                            renderIcon={Close}
                            onClick={() => {
                              if (mqttCaptureRef.current) {
                                mqttCaptureRef.current.close();
                                mqttCaptureRef.current = null;
                              }
                            }}
                          >
                            Stop Capture
                          </Button>
                        ) : (
                          <Button
                            kind="tertiary"
                            size="sm"
                            renderIcon={Play}
                            onClick={fetchPreviewData}
                          >
                            Fetch Data
                          </Button>
                        )
                      ) : isTSStore ? (
                        <Button
                          kind="tertiary"
                          size="sm"
                          renderIcon={Play}
                          onClick={fetchPreviewData}
                          disabled={previewLoading}
                        >
                          {previewLoading ? 'Fetching…' : 'Fetch Data'}
                        </Button>
                      ) : queryMode === 'raw' && (
                        <Button
                          kind="tertiary"
                          size="sm"
                          renderIcon={Play}
                          onClick={fetchPreviewData}
                          disabled={previewLoading || (selectedDatasource?.type !== 'api' && !queryRaw.trim())}
                        >
                          {previewLoading ? 'Fetching…' : 'Fetch Data'}
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Socket/streaming datasource - show info message instead of unused filter field */}
                  {selectedDatasource.type === 'socket' || isTSStoreStreaming ? (
                    <div className="socket-capture-info">
                      <InlineNotification
                        kind="info"
                        title="Stream Preview"
                        subtitle="Click Fetch Data to collect 5 seconds of stream data for preview. This helps discover the data schema for mapping. Use client-side filters below to filter the captured data."
                        hideCloseButton
                        lowContrast
                      />
                    </div>
                  ) : isMQTT ? (
                    <div className="mqtt-section">
                      {/* MQTT Topic Selector — visual mode shows topic list, raw mode shows text input */}
                      {queryMode === 'visual' ? (
                        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '0.5rem' }}>
                          <Select
                            id="mqtt-topic-dropdown"
                            labelText="MQTT Topic"
                            value={queryRaw || ''}
                            onChange={(e) => setQueryRaw(e.target.value)}
                            disabled={mqttTopicsLoading}
                          >
                            <SelectItem value="" text={mqttTopicsLoading ? 'Loading topics...' : 'Select a topic...'} />
                            {mqttTopics.map(t => <SelectItem key={t} value={t} text={t} />)}
                          </Select>
                          <IconButton
                            kind="ghost"
                            size="sm"
                            label="Refresh topics"
                            onClick={() => {
                              setMqttTopicsLoading(true);
                              apiClient.getMQTTTopics(selectedConnectionId).then(result => {
                                setMqttTopics(result.topics || []);
                              }).catch(err => console.error('Failed to discover MQTT topics:', err))
                                .finally(() => setMqttTopicsLoading(false));
                            }}
                            disabled={mqttTopicsLoading}
                          >
                            <Renew size={16} />
                          </IconButton>
                        </div>
                      ) : (
                        <TextInput
                          id="mqtt-raw-topic"
                          labelText="MQTT Topic"
                          value={queryRaw}
                          onChange={(e) => setQueryRaw(e.target.value)}
                          placeholder="e.g., sensors/temperature or home/living-room/status"
                          helperText="Enter the MQTT topic to subscribe to"
                          size="md"
                        />
                      )}

                      {/* Data Parser Configuration — bordered box matching WebSocket connection editor style */}
                      <div className="parser-config-box">
                        <h4>Data Parser Configuration</h4>
                        <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', marginBottom: '0.75rem' }}>
                          Configure how to extract data fields from incoming messages.
                        </p>

                        <div className="parser-fields-row">
                          <Select
                            id="parser-preset"
                            labelText="Preset"
                            value={parserPreset}
                            onChange={(e) => {
                              const preset = e.target.value;
                              setParserPreset(preset);
                              if (preset === 'tsstore') {
                                setParserDataPath('data');
                                setParserTimestampField('timestamp');
                                setParserTimestampScale('ns');
                              } else if (preset === 'none') {
                                setParserDataPath('');
                                setParserTimestampField('');
                                setParserTimestampScale('');
                              }
                            }}
                          >
                            <SelectItem value="none" text="None (flat JSON)" />
                            <SelectItem value="tsstore" text="ts-store" />
                            <SelectItem value="custom" text="Custom" />
                          </Select>
                          <TextInput
                            id="parser-data-path"
                            labelText="Data Path"
                            value={parserDataPath}
                            onChange={(e) => { setParserDataPath(e.target.value); if (parserPreset !== 'none') setParserPreset('custom'); }}
                            placeholder="data, payload.readings"
                            helperText="Path to the data object containing metrics"
                            size="md"
                            disabled={parserPreset === 'none'}
                          />
                          <TextInput
                            id="parser-timestamp-field"
                            labelText="Timestamp Field"
                            value={parserTimestampField}
                            onChange={(e) => { setParserTimestampField(e.target.value); if (parserPreset !== 'none') setParserPreset('custom'); }}
                            placeholder="timestamp"
                            helperText="Path to the timestamp (extracted before data path)"
                            size="md"
                            disabled={parserPreset === 'none'}
                          />
                        </div>

                        {/* Test Parser — sample input + parsed output side by side */}
                        <div className="parse-preview-section">
                          <h5>Test Parser</h5>
                          <p style={{ fontSize: '0.75rem', color: 'var(--cds-text-helper)', marginBottom: '0.5rem' }}>
                            Paste a sample message to test the data path extraction. First captured message auto-populates this field.
                          </p>
                          <div className="preview-columns">
                            <div className="preview-column">
                              <label className="preview-label">Sample Input (JSON)</label>
                              <TextArea
                                id="parser-sample-input"
                                value={parserSampleInput}
                                onChange={(e) => setParserSampleInput(e.target.value)}
                                rows={8}
                                className="preview-textarea"
                                placeholder={'{\n  "type": "data",\n  "timestamp": 1707012345678901234,\n  "data": {\n    "temperature": 72.5,\n    "humidity": 45.2\n  }\n}'}
                              />
                            </div>
                            <div className="preview-column">
                              <label className="preview-label">
                                Extracted Output {parserDataPath && <span className="path-badge">path: {parserDataPath}</span>}
                              </label>
                              {(() => {
                                if (!parserSampleInput.trim()) return <pre className="preview-output preview-empty">Paste a sample message or capture from stream</pre>;
                                try {
                                  let parsed = JSON.parse(parserSampleInput);
                                  if (parserPreset !== 'none' && (parserDataPath || parserTimestampField)) {
                                    const result = {};
                                    if (parserTimestampField) {
                                      const parts = parserTimestampField.split('.');
                                      let ts = parsed;
                                      for (const p of parts) { ts = ts?.[p]; }
                                      if (ts != null && typeof ts === 'number') {
                                        if (parserTimestampScale === 'ns') ts = ts / 1e9;
                                        else if (parserTimestampScale === 'ms') ts = ts / 1e3;
                                        else if (!parserTimestampScale) { if (ts > 1e15) ts = ts / 1e9; else if (ts > 1e12) ts = ts / 1e3; }
                                        result.timestamp = ts;
                                      }
                                    }
                                    if (parserDataPath) {
                                      const parts = parserDataPath.split('.');
                                      let nested = parsed;
                                      for (const p of parts) { nested = nested?.[p]; }
                                      if (nested && typeof nested === 'object') Object.assign(result, nested);
                                    }
                                    parsed = Object.keys(result).length > 0 ? result : parsed;
                                  }
                                  const cols = Object.keys(parsed);
                                  // Show extracted fields as tags
                                  return (
                                    <>
                                      <pre className="preview-output preview-success">{JSON.stringify(parsed, null, 2)}</pre>
                                      <div className="preview-fields">
                                        Fields: {cols.map(c => <Tag key={c} type="cool-gray" size="sm">{c}</Tag>)}
                                      </div>
                                    </>
                                  );
                                } catch (err) {
                                  return <pre className="preview-output preview-error">Parse error: {err.message}</pre>;
                                }
                              })()}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : isTSStore ? (
                    <div className="tsstore-query-section">
                      {/* Flex row inside the half-width query card.
                          Each control takes half the row, fully
                          filling the card horizontally — Carbon's
                          16-col Grid was producing 33% columns
                          inside the narrow card and truncating the
                          dropdown labels. */}
                      <div className="tsstore-query-row">
                        <div className="tsstore-query-row__col">
                          <Select
                            id="tsstore-query-type"
                            labelText="Query Type"
                            value={tsstoreQueryType}
                            onChange={(e) => {
                              setTsstoreQueryType(e.target.value);
                              setQueryRaw(e.target.value);
                            }}
                          >
                            <SelectItem value="newest" text="Newest Records" />
                            <SelectItem value="oldest" text="Oldest Records" />
                            <SelectItem value="since" text="Time Range (Last...)" />
                          </Select>
                        </div>
                        {tsstoreQueryType === 'since' ? (
                          <div className="tsstore-query-row__col">
                            <Select
                              id="tsstore-since-duration"
                              labelText="Time Period"
                              value={tsstoreSinceDuration}
                              onChange={(e) => setTsstoreSinceDuration(e.target.value)}
                            >
                              <SelectItem value="5m" text="Last 5 minutes" />
                              <SelectItem value="15m" text="Last 15 minutes" />
                              <SelectItem value="30m" text="Last 30 minutes" />
                              <SelectItem value="1h" text="Last 1 hour" />
                              <SelectItem value="2h" text="Last 2 hours" />
                              <SelectItem value="6h" text="Last 6 hours" />
                              <SelectItem value="12h" text="Last 12 hours" />
                              <SelectItem value="24h" text="Last 24 hours" />
                              <SelectItem value="2d" text="Last 2 days" />
                              <SelectItem value="7d" text="Last 7 days" />
                              <SelectItem value="1w" text="Last 1 week" />
                            </Select>
                          </div>
                        ) : (
                          <div className="tsstore-query-row__col">
                            <NumberInput
                              id="tsstore-limit"
                              label="Number of Records"
                              value={tsstoreLimit}
                              onChange={(e, { value }) => setTsstoreLimit(value)}
                              min={1}
                              max={10000}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  ) : selectedDatasource.type === 'sql' && queryMode === 'visual' ? (
                    <SQLQueryBuilder
                      connectionId={selectedConnectionId}
                      onQueryChange={(query) => setQueryRaw(query)}
                      onExecute={(response) => {
                        if (response.success && response.result_set) {
                          setPreviewData(response.result_set);
                          if (response.result_set.columns) {
                            setAvailableColumns(response.result_set.columns);
                          }
                          setPreviewError(null);
                        } else {
                          setPreviewError(response.error);
                        }
                      }}
                      initialQuery={queryRaw}
                    />
                  ) : selectedDatasource.type === 'prometheus' && queryMode === 'visual' ? (
                    <PrometheusQueryBuilder
                      connectionId={selectedConnectionId}
                      onQueryChange={(query) => setQueryRaw(query)}
                      onParamsChange={(_params) => {
                        // Store params for use in query execution
                        // These will be passed via query_config.params
                      }}
                      onExecute={(response) => {
                        if (response.success && response.result_set) {
                          setPreviewData(response.result_set);
                          if (response.result_set.columns) {
                            setAvailableColumns(response.result_set.columns);
                          }
                          setPreviewError(null);
                        } else {
                          setPreviewError(response.error || 'Query failed');
                        }
                      }}
                      initialQuery={queryRaw}
                    />
                  ) : selectedDatasource.type === 'mqtt' && queryMode === 'visual' ? (
                    <div className="mqtt-topic-section">
                      <Select
                        id="mqtt-topic-select"
                        labelText="MQTT Topic"
                        value={mqttSelectedTopic}
                        onChange={(e) => handleMQTTTopicSelect(e.target.value)}
                        disabled={mqttTopicsLoading}
                      >
                        <SelectItem value="" text={mqttTopicsLoading ? 'Discovering topics...' : 'Select a topic'} />
                        {mqttTopics.map(topic => (
                          <SelectItem key={topic} value={topic} text={topic} />
                        ))}
                      </Select>
                      {mqttSampling && (
                        <InlineNotification
                          kind="info"
                          title="Sampling"
                          subtitle="Listening for a message on this topic to discover the data schema..."
                          hideCloseButton
                          lowContrast
                          style={{ marginTop: '0.5rem' }}
                        />
                      )}
                      {mqttSelectedTopic && !mqttSampling && availableColumns.length > 0 && (
                        <InlineNotification
                          kind="success"
                          title="Schema Discovered"
                          subtitle={`Found ${availableColumns.length} fields: ${availableColumns.join(', ')}`}
                          hideCloseButton
                          lowContrast
                          style={{ marginTop: '0.5rem' }}
                        />
                      )}
                      {previewError && (
                        <InlineNotification
                          kind="warning"
                          title="Sample Failed"
                          subtitle={previewError}
                          hideCloseButton
                          lowContrast
                          style={{ marginTop: '0.5rem' }}
                        />
                      )}
                    </div>
                  ) : selectedDatasource.type === 'edgelake' && queryMode === 'visual' ? (
                    <EdgeLakeQueryBuilder
                      connectionId={selectedConnectionId}
                      onQueryChange={(query) => setQueryRaw(query)}
                      onDatabaseChange={(db) => setEdgelakeDatabase(db)}
                      onExecute={(response) => {
                        if (response.success && response.result_set) {
                          setPreviewData(response.result_set);
                          if (response.result_set.columns) {
                            setAvailableColumns(response.result_set.columns);
                          }
                          setPreviewError(null);
                        } else {
                          setPreviewError(response.error || 'Query failed');
                        }
                      }}
                      initialQuery={queryRaw}
                      initialDatabase={edgelakeDatabase}
                    />
                  ) : (
                    <TextArea
                      id="query-raw"
                      labelText={getQueryLabelForType(selectedDatasource.type)}
                      value={queryRaw}
                      onChange={(e) => setQueryRaw(e.target.value)}
                      placeholder={getQueryPlaceholderForType(selectedDatasource.type)}
                      rows={selectedDatasource.type === 'api' || selectedDatasource.type === 'mqtt' ? 1 : 6}
                      className={`query-textarea ${selectedDatasource.type === 'api' || selectedDatasource.type === 'mqtt' ? 'query-textarea--compact' : ''}`}
                    />
                  )}
                </div>
                </div>

                {previewError && (
                  <InlineNotification
                    kind="error"
                    title="Query Error"
                    subtitle={previewError}
                    lowContrast
                    hideCloseButton
                  />
                )}

                {/* Full-width warning prompting the user to fetch
                    sample data before configuring the chart's data
                    sections. Subtitle lists only the sections that
                    actually appear for this connection type —
                    queryLanguageOwnsClientSideOps (SQL / EdgeLake)
                    hides Filters / Aggregation / Sliding Window,
                    so naming them in the warning would mislead. */}
                {!showCustomCode && !previewData && (() => {
                  const sections = ['Data Mapping'];
                  if (!queryLanguageOwnsClientSideOps) {
                    sections.push('Filters', 'Aggregation', 'Sliding Window');
                  }
                  const sentence = sections.length === 1
                    ? `${sections[0]} is enabled`
                    : `${sections.slice(0, -1).join(', ')}, and ${sections[sections.length - 1]} are enabled`;
                  return (
                    <InlineNotification
                      kind="warning"
                      lowContrast
                      hideCloseButton
                      title="Fetch data to configure mappings."
                      subtitle={`${sentence} once a sample is loaded from the connection above.`}
                      actions={
                        <NotificationActionButton
                          onClick={fetchPreviewData}
                          disabled={previewLoading}
                        >
                          {previewLoading ? 'Fetching…' : 'Fetch Data'}
                        </NotificationActionButton>
                      }
                      className="run-query-warning"
                    />
                  );
                })()}

                {!showCustomCode && (
                <div className="mapping-section">
                  <h4>Data Mapping</h4>
                  {/* Show column aliases UI for dataview type */}
                  {chartType === 'dataview' && (
                    <div className="dataview-config">
                      <p className="mapping-hint">Data tables display the columns below. Uncheck any column to hide it; set a display name to rename its header.</p>
                      {availableColumns.length > 0 && (() => {
                        // Visible-column semantics: visibleColumns=null means
                        // "show all" (the default + back-compat path). As soon
                        // as the admin touches a checkbox, we switch to an
                        // explicit whitelist. We derive the current state for
                        // display by falling back to availableColumns when the
                        // stored list is null.
                        const effectiveVisible = Array.isArray(visibleColumns) ? visibleColumns : availableColumns;
                        const isVisible = (col) => effectiveVisible.includes(col);
                        const toggleVisible = (col) => {
                          if (isVisible(col)) {
                            // Hiding: drop the column. If that empties the
                            // list, keep it as `[]` (explicit hide-all) rather
                            // than reverting to null/show-all.
                            setVisibleColumns(effectiveVisible.filter((c) => c !== col));
                          } else {
                            // Showing: add it back, preserving availableColumns
                            // order so the table columns render in a stable
                            // sequence regardless of click order.
                            const reordered = availableColumns.filter((c) => effectiveVisible.includes(c) || c === col);
                            setVisibleColumns(reordered);
                          }
                        };
                        const allVisible = availableColumns.every(isVisible);
                        return (
                          <div className="column-aliases-section">
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
                              <h5 style={{ margin: 0 }}>Columns</h5>
                              <Button
                                kind="ghost"
                                size="sm"
                                onClick={() => setVisibleColumns(allVisible ? [] : null)}
                              >
                                {allVisible ? 'Hide all' : 'Show all'}
                              </Button>
                            </div>
                            <p className="aliases-hint">Check to include the column. Use the ↕ arrows to reorder and set an optional display name. Column widths auto-size to fit the data; drag the header in the live table to override.</p>
                            {(() => {
                              // Visible columns render in their saved
                              // order (effectiveVisible), then hidden
                              // columns at the bottom. Reorder buttons
                              // only act inside the visible group.
                              const visibleList = effectiveVisible.filter(c => availableColumns.includes(c));
                              const hiddenList = availableColumns.filter(c => !visibleList.includes(c));
                              const moveColumn = (col, delta) => {
                                const idx = visibleList.indexOf(col);
                                const target = idx + delta;
                                if (idx < 0 || target < 0 || target >= visibleList.length) return;
                                const next = [...visibleList];
                                next.splice(idx, 1);
                                next.splice(target, 0, col);
                                setVisibleColumns(next);
                              };
                              const renderRow = (col, opts) => (
                                <div key={col} className="alias-row">
                                  <Checkbox
                                    id={`visible-${col}`}
                                    labelText=""
                                    checked={isVisible(col)}
                                    onChange={() => toggleVisible(col)}
                                  />
                                  <div style={{ display: 'inline-flex', flexDirection: 'column', visibility: opts.canReorder ? 'visible' : 'hidden' }}>
                                    <IconButton
                                      kind="ghost"
                                      size="sm"
                                      label="Move up"
                                      onClick={() => moveColumn(col, -1)}
                                      disabled={!opts.canMoveUp}
                                    >
                                      <CaretUp size={14} />
                                    </IconButton>
                                    <IconButton
                                      kind="ghost"
                                      size="sm"
                                      label="Move down"
                                      onClick={() => moveColumn(col, 1)}
                                      disabled={!opts.canMoveDown}
                                    >
                                      <CaretDown size={14} />
                                    </IconButton>
                                  </div>
                                  <span className="column-name" title={col}>{col}</span>
                                  <TextInput
                                    id={`alias-${col}`}
                                    labelText=""
                                    placeholder="rename"
                                    value={columnAliases[col] || ''}
                                    onChange={(e) => {
                                      const newValue = e.target.value;
                                      setColumnAliases(prev => {
                                        const updated = { ...prev };
                                        if (newValue) {
                                          updated[col] = newValue;
                                        } else {
                                          delete updated[col];
                                        }
                                        return updated;
                                      });
                                    }}
                                    size="sm"
                                    disabled={!isVisible(col)}
                                  />
                                </div>
                              );
                              return (
                                <div className="aliases-grid">
                                  {visibleList.map((col, i) => renderRow(col, {
                                    canReorder: true,
                                    canMoveUp: i > 0,
                                    canMoveDown: i < visibleList.length - 1,
                                  }))}
                                  {hiddenList.map(col => renderRow(col, { canReorder: false, canMoveUp: false, canMoveDown: false }))}
                                </div>
                              );
                            })()}
                          </div>
                        );
                      })()}
                    </div>
                  )}
                  {/* Show mapping fields for applicable chart types */}
                  {(chartTypeConfig.hasXAxis || chartTypeConfig.hasYAxis) && (
                    availableColumns.length > 0 ? (
                      <>
                        <Grid narrow>
                          {/* X-Axis Column - shown for most chart types except gauge and dataview */}
                          {chartTypeConfig.hasXAxis && (
                            <Column lg={4} md={4} sm={4}>
                              <Select
                                id="x-axis-column"
                                labelText={chartTypeConfig.xAxisLabel || 'X-Axis'}
                                value={xAxisColumn}
                                onChange={(e) => setXAxisColumn(e.target.value)}
                              >
                                <SelectItem value="" text="Select column..." />
                                {availableColumns.map(col => (
                                  <SelectItem key={col} value={col} text={col} />
                                ))}
                              </Select>
                            </Column>
                          )}
                          {/* Y-Axis Column(s) - shown for all chart types except dataview */}
                          {chartTypeConfig.hasYAxis && (
                            <Column lg={4} md={4} sm={4}>
                              {chartTypeConfig.multipleYAxis ? (
                                <MultiSelect
                                  id="y-axis-columns"
                                  titleText={chartTypeConfig.yAxisLabel || 'Y-Axis'}
                                  helperText="Up to 2 values. Two uses dual-axis (left/right, color-coded); for more, split into separate charts."
                                  label={yAxisColumns.length > 0 ? yAxisColumns.join(', ') : 'Select value(s)...'}
                                  items={availableColumns.filter(c => c !== xAxisColumn).map(col => ({
                                    id: col,
                                    label: col
                                  }))}
                                  selectedItems={yAxisColumns.map(col => ({ id: col, label: col }))}
                                  onChange={({ selectedItems }) => {
                                    const ids = selectedItems.map(item => item.id);
                                    // Hard-cap at 2: three or more y-columns has no
                                    // good rendering — no place for axis names, tick
                                    // values overlap, color coding runs out. Two
                                    // separate charts beat one cluttered one. If the
                                    // user picks a third, keep the two earliest
                                    // selections (Carbon MultiSelect emits the full
                                    // new set in document order).
                                    const capped = ids.length > 2 ? ids.slice(0, 2) : ids;
                                    setYAxisColumns(capped);
                                  }}
                                  itemToString={(item) => item ? item.label : ''}
                                />
                              ) : (
                                <Select
                                  id="y-axis-column"
                                  labelText={chartTypeConfig.yAxisLabel || 'Value Column'}
                                  value={yAxisColumns[0] || ''}
                                  onChange={(e) => setYAxisColumns(e.target.value ? [e.target.value] : [])}
                                >
                                  <SelectItem value="" text="Select column..." />
                                  {availableColumns.filter(c => c !== xAxisColumn).map(col => (
                                    <SelectItem key={col} value={col} text={col} />
                                  ))}
                                </Select>
                              )}
                            </Column>
                          )}
                          {/* Series Column - only for bar, line, area charts */}
                          {chartTypeConfig.hasSeriesColumn && (
                            <Column lg={4} md={4} sm={4}>
                              <Select
                                id="series-column"
                                labelText="Series Column"
                                value={seriesColumn}
                                onChange={(e) => setSeriesColumn(e.target.value)}
                                helperText={selectedDatasource?.type === 'socket' ? 'Partition by this value' : 'Group data into separate series'}
                              >
                                <SelectItem value="" text="None" />
                                {availableColumns.filter(c => c !== xAxisColumn && !yAxisColumns.includes(c)).map(col => (
                                  <SelectItem key={col} value={col} text={col} />
                                ))}
                              </Select>
                            </Column>
                          )}
                        </Grid>
                        {/* Axis Labels - only for charts with axes */}
                        {chartTypeConfig.hasAxisLabels && (
                          <Grid narrow className="axis-labels-row">
                            {chartTypeConfig.hasXAxis && (
                              <Column lg={4} md={4} sm={4}>
                                <TextInput
                                  id="x-axis-label"
                                  labelText="X-Axis Label (Optional)"
                                  value={xAxisLabel}
                                  onChange={(e) => setXAxisLabel(e.target.value)}
                                  placeholder="e.g., Time"
                                />
                              </Column>
                            )}
                            {/* Y-axis label overrides.
                                - Single y: the override becomes the axis name.
                                - Dual y: the overrides become the series names in the
                                  legend at the top of the chart (the axis itself has
                                  no name — ECharts leaves axis names visible even
                                  when their series is legend-hidden). Raw column
                                  names from databases or MQTT are often terse; this
                                  gives users a place to rename. */}
                            {yAxisColumns.length >= 1 && yAxisColumns.length <= 2 && yAxisColumns.map((col, idx) => (
                              <Column key={`yaxis-label-${idx}`} lg={4} md={4} sm={4}>
                                <TextInput
                                  id={`y-axis-label-${idx}`}
                                  labelText={yAxisColumns.length === 2
                                    ? `Y-Axis Label — ${idx === 0 ? 'Left' : 'Right'} (Optional)`
                                    : 'Y-Axis Label (Optional)'}
                                  helperText={yAxisColumns.length === 2 ? 'Shown in the legend; axis itself is unnamed.' : undefined}
                                  value={yAxisLabels[idx] || (idx === 0 ? yAxisLabel : '') || ''}
                                  onChange={(e) => {
                                    const next = [...yAxisLabels];
                                    next[idx] = e.target.value;
                                    while (next.length > 0 && !next[next.length - 1]) next.pop();
                                    setYAxisLabels(next);
                                    if (idx === 0) setYAxisLabel(e.target.value);
                                  }}
                                  placeholder={col ? `Defaults to "${col}"` : 'e.g., Temperature (°F)'}
                                />
                              </Column>
                            ))}
                            {chartTypeConfig.hasXAxisFormat && (
                              <Column lg={4} md={4} sm={4}>
                                <Select
                                  id="x-axis-format"
                                  labelText="Timestamp Format"
                                  value={xAxisFormat}
                                  onChange={(e) => setXAxisFormat(e.target.value)}
                                >
                                  <SelectItem value="chart" text="Date + Time (1/15 10:30)" />
                                  <SelectItem value="chart_time" text="Time Only (10:30 AM)" />
                                  <SelectItem value="chart_time_seconds" text="Time + Seconds (10:30:05 AM)" />
                                  <SelectItem value="chart_date" text="Date Only (Jan 15)" />
                                  <SelectItem value="chart_datetime" text="Full (Jan 15, 10:30 AM)" />
                                  <SelectItem value="chart_datetime_seconds" text="Full + Seconds (Jan 15, 10:30:05 AM)" />
                                </Select>
                              </Column>
                            )}
                          </Grid>
                        )}
                      </>
                    ) : (
                      <div className="saved-values-display">
                        {((chartTypeConfig.hasXAxis && xAxisColumn) || (chartTypeConfig.hasYAxis && yAxisColumns.length > 0) || (chartTypeConfig.hasSeriesColumn && seriesColumn)) ? (
                          <Grid narrow>
                            {chartTypeConfig.hasXAxis && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">{chartTypeConfig.xAxisLabel || 'X-Axis'}</label>
                                  {xAxisColumn ? (
                                    <Tag type="blue">{xAxisColumn}</Tag>
                                  ) : (
                                    <span className="no-value">Not set</span>
                                  )}
                                </div>
                              </Column>
                            )}
                            {chartTypeConfig.hasYAxis && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">{chartTypeConfig.yAxisLabel || 'Y-Axis'}</label>
                                  {yAxisColumns.length > 0 ? (
                                    <div className="column-tags">
                                      {yAxisColumns.map(col => (
                                        <Tag key={col} type="blue">{col}</Tag>
                                      ))}
                                    </div>
                                  ) : (
                                    <span className="no-value">Not set</span>
                                  )}
                                </div>
                              </Column>
                            )}
                            {chartTypeConfig.hasSeriesColumn && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">Series Column</label>
                                  {seriesColumn ? (
                                    <Tag type="purple">{seriesColumn}</Tag>
                                  ) : (
                                    <span className="no-value">None</span>
                                  )}
                                </div>
                              </Column>
                            )}
                          </Grid>
                        ) : (
                          <p className="editor-info-hint">No data mapping configured.</p>
                        )}
                        {((chartTypeConfig.hasXAxis && xAxisColumn) || (chartTypeConfig.hasYAxis && yAxisColumns.length > 0)) && (
                          <p className="run-query-hint">Fetch data to modify column mappings.</p>
                        )}
                      </div>
                    )
                  )}
                </div>
                )}

                {/* Chart Options Section - Gauge */}
                {!showCustomCode && chartType === 'number' && (
                  <div className="chart-options-section">
                    <h4>Number Options</h4>
                    <Grid narrow>
                      <Column lg={4} md={4} sm={4}>
                        <Select
                          id="number-size"
                          labelText="Value Size (px)"
                          value={String(chartOptions.numberSize ?? 120)}
                          onChange={(e) => updateChartOption('numberSize', Number(e.target.value))}
                          size="sm"
                        >
                          {[24, 32, 40, 48, 56, 64, 80, 96, 120, 160, 200, 240, 300, 400].map((s) => (
                            <SelectItem key={s} value={String(s)} text={`${s} px`} />
                          ))}
                        </Select>
                      </Column>
                      <Column lg={4} md={4} sm={4}>
                        <TextInput
                          id="number-unit"
                          labelText="Unit Suffix"
                          value={chartOptions.numberUnit || ''}
                          onChange={(e) => updateChartOption('numberUnit', e.target.value)}
                          placeholder="e.g., °F, %, psi"
                          helperText="Rendered inline after the value, same size"
                        />
                      </Column>
                    </Grid>
                  </div>
                )}

                {!showCustomCode && chartType === 'gauge' && (
                  <div className="chart-options-section">
                    <h4>Gauge Options</h4>
                    <Grid narrow>
                      <Column lg={3} md={4} sm={2}>
                        <NumberInput
                          id="gauge-min"
                          label="Min Value"
                          value={chartOptions.gaugeMin}
                          onChange={(e, { value }) => updateChartOption('gaugeMin', value)}
                          min={-1000000}
                          max={chartOptions.gaugeMax - 1}
                          step={1}
                          hideSteppers
                        />
                      </Column>
                      <Column lg={3} md={4} sm={2}>
                        <NumberInput
                          id="gauge-max"
                          label="Max Value"
                          value={chartOptions.gaugeMax}
                          onChange={(e, { value }) => updateChartOption('gaugeMax', value)}
                          min={chartOptions.gaugeMin + 1}
                          max={1000000}
                          step={1}
                          hideSteppers
                        />
                      </Column>
                      <Column lg={3} md={4} sm={2}>
                        <NumberInput
                          id="gauge-warning"
                          label="Warning Threshold (%)"
                          value={chartOptions.gaugeWarningThreshold}
                          onChange={(e, { value }) => updateChartOption('gaugeWarningThreshold', value)}
                          min={0}
                          max={chartOptions.gaugeDangerThreshold - 1}
                          step={1}
                          hideSteppers
                          helperText="Yellow zone starts"
                        />
                      </Column>
                      <Column lg={3} md={4} sm={2}>
                        <NumberInput
                          id="gauge-danger"
                          label="Danger Threshold (%)"
                          value={chartOptions.gaugeDangerThreshold}
                          onChange={(e, { value }) => updateChartOption('gaugeDangerThreshold', value)}
                          min={chartOptions.gaugeWarningThreshold + 1}
                          max={100}
                          step={1}
                          hideSteppers
                          helperText="Red zone starts"
                        />
                      </Column>
                    </Grid>
                    <Grid narrow style={{ marginTop: '1rem' }}>
                      <Column lg={4} md={4} sm={4}>
                        <TextInput
                          id="gauge-unit"
                          labelText="Unit Suffix"
                          value={chartOptions.gaugeUnit}
                          onChange={(e) => updateChartOption('gaugeUnit', e.target.value)}
                          placeholder="e.g., °F, %, psi"
                        />
                      </Column>
                      <Column lg={4} md={4} sm={4}>
                        <Slider
                          id="gauge-line-thickness"
                          labelText="Arc Thickness (%)"
                          value={chartOptions.gaugeLineThickness ?? 8}
                          onChange={({ value }) => updateChartOption('gaugeLineThickness', value)}
                          min={1}
                          max={16}
                          step={1}
                        />
                      </Column>
                    </Grid>
                  </div>
                )}

                {/* Chart Options Section - Pie. (Outer gate added via the
                    Number block's `!showCustomCode` doesn't reach here —
                    each section needs its own.) */}
                {!showCustomCode && chartType === 'pie' && (
                  <div className="chart-options-section">
                    <h4>Pie Chart Options</h4>
                    <Grid narrow>
                      <Column lg={4} md={4} sm={4}>
                        <NumberInput
                          id="pie-inner-radius"
                          label="Inner Radius (%)"
                          value={chartOptions.pieInnerRadius}
                          onChange={(e, { value }) => updateChartOption('pieInnerRadius', value)}
                          min={0}
                          max={90}
                          step={5}
                          hideSteppers
                          helperText="0 = pie, >0 = donut"
                        />
                      </Column>
                      <Column lg={4} md={4} sm={4}>
                        <Toggle
                          id="pie-show-labels"
                          labelText="Show Labels"
                          labelA="Off"
                          labelB="On"
                          toggled={chartOptions.pieShowLabels}
                          onToggle={(checked) => updateChartOption('pieShowLabels', checked)}
                        />
                      </Column>
                    </Grid>
                  </div>
                )}

                {/* Chart Options Section - Bar/Line/Area */}
                {!showCustomCode && ['bar', 'line', 'area'].includes(chartType) && (
                  <div className="chart-options-section">
                    <h4>Chart Options</h4>
                    <Grid narrow>
                      <Column lg={4} md={4} sm={4}>
                        <Toggle
                          id="chart-stacked"
                          labelText="Stacked"
                          labelA="Off"
                          labelB="On"
                          toggled={chartOptions.chartStacked}
                          onToggle={(checked) => updateChartOption('chartStacked', checked)}
                        />
                      </Column>
                      {['line', 'area'].includes(chartType) && (
                        <Column lg={4} md={4} sm={4}>
                          <Toggle
                            id="chart-smooth"
                            labelText="Smooth Curves"
                            labelA="Off"
                            labelB="On"
                            toggled={chartOptions.chartSmooth}
                            onToggle={(checked) => updateChartOption('chartSmooth', checked)}
                          />
                        </Column>
                      )}
                      <Column lg={4} md={4} sm={4}>
                        <Toggle
                          id="chart-data-labels"
                          labelText="Show Data Labels"
                          labelA="Off"
                          labelB="On"
                          toggled={chartOptions.chartShowDataLabels}
                          onToggle={(checked) => updateChartOption('chartShowDataLabels', checked)}
                        />
                      </Column>
                      <Column lg={4} md={4} sm={4}>
                        <Toggle
                          id="chart-zoom-slider"
                          labelText="Zoom Slider"
                          labelA="Off"
                          labelB="On"
                          toggled={!!chartOptions.chartShowZoomSlider}
                          onToggle={(checked) => updateChartOption('chartShowZoomSlider', checked)}
                        />
                      </Column>
                    </Grid>
                  </div>
                )}

                {/* Filters Section. Hidden when the connection's
                    query language already owns this responsibility
                    (SQL WHERE / EdgeLake WHERE) — see
                    queryLanguageOwnsClientSideOps memo. */}
                {!showCustomCode && !queryLanguageOwnsClientSideOps && (
                <div className="filters-section">
                  <div className="section-header">
                    <h4>Filters (Client-Side)</h4>
                    <Button
                      kind="ghost"
                      size="sm"
                      renderIcon={Add}
                      onClick={addFilter}
                      disabled={availableColumns.length === 0}
                    >
                      Add Filter
                    </Button>
                  </div>
                  {filters.length > 0 ? (
                    availableColumns.length > 0 ? (
                      <div className="filters-list">
                        {filters.map((filter, index) => (
                          <div key={index} className="filter-row">
                            <Select
                              id={`filter-field-${index}`}
                              labelText="Field"
                              value={filter.field}
                              onChange={(e) => updateFilter(index, 'field', e.target.value)}
                              size="sm"
                            >
                              {availableColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                            <Select
                              id={`filter-op-${index}`}
                              labelText="Operator"
                              value={filter.op}
                              onChange={(e) => updateFilter(index, 'op', e.target.value)}
                              size="sm"
                            >
                              {FILTER_OPERATORS.map(op => (
                                <SelectItem key={op.id} value={op.id} text={op.label} />
                              ))}
                            </Select>
                            {!['isNull', 'isNotNull'].includes(filter.op) && (
                              <TextInput
                                id={`filter-value-${index}`}
                                labelText="Value"
                                value={filter.value}
                                onChange={(e) => updateFilter(index, 'value', e.target.value)}
                                placeholder={filter.op === 'in' || filter.op === 'notIn' ? 'val1, val2, val3' : 'Enter value'}
                                size="sm"
                              />
                            )}
                            <IconButton
                              label="Remove filter"
                              kind="ghost"
                              size="sm"
                              onClick={() => removeFilter(index)}
                            >
                              <TrashCan />
                            </IconButton>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="saved-filters-display">
                        <div className="filters-list">
                          {filters.map((filter, index) => (
                            <div key={index} className="filter-tag-row">
                              <Tag type="purple">{filter.field}</Tag>
                              <Tag type="gray">{FILTER_OPERATORS.find(op => op.id === filter.op)?.label || filter.op}</Tag>
                              {!['isNull', 'isNotNull'].includes(filter.op) && (
                                <Tag type="cyan">{String(filter.value)}</Tag>
                              )}
                              <IconButton
                                label="Remove filter"
                                kind="ghost"
                                size="sm"
                                onClick={() => removeFilter(index)}
                              >
                                <TrashCan />
                              </IconButton>
                            </div>
                          ))}
                        </div>
                        <p className="run-query-hint">Fetch data to modify filters.</p>
                      </div>
                    )
                  ) : (
                    <p className="editor-info-hint">No filters configured.</p>
                  )}
                </div>
                )}

                {/* Aggregation & Sorting Section — chart-type-gated.
                    Banded-bar (and any future per-row-aggregated type) opts
                    out via hasAggregation:false in CHART_TYPE_CONFIG.
                    Also hidden when the connection's query language
                    already owns aggregation (SQL GROUP BY / EdgeLake
                    GROUP BY). */}
                {!showCustomCode && chartTypeConfig.hasAggregation !== false && !queryLanguageOwnsClientSideOps && (
                <div className="aggregation-section">
                  <h4>Aggregation & Sorting</h4>
                  {availableColumns.length > 0 ? (
                    <>
                      <Grid narrow>
                        <Column lg={4} md={4} sm={4}>
                          <Select
                            id="aggregation-type"
                            labelText="Aggregation"
                            value={aggregation.type}
                            onChange={(e) => updateAggregation('type', e.target.value)}
                          >
                            {AGGREGATION_TYPES.map(agg => (
                              <SelectItem key={agg.id} value={agg.id} text={agg.label} />
                            ))}
                          </Select>
                        </Column>
                        {AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.needsSort && (
                          <Column lg={4} md={4} sm={4}>
                            <Select
                              id="aggregation-sort"
                              labelText="Sort By"
                              value={aggregation.sortBy}
                              onChange={(e) => updateAggregation('sortBy', e.target.value)}
                            >
                              <SelectItem value="" text="Select column..." />
                              {availableColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                          </Column>
                        )}
                        {AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.needsField && (
                          <Column lg={4} md={4} sm={4}>
                            <Select
                              id="aggregation-field"
                              labelText="Field"
                              value={aggregation.field}
                              onChange={(e) => updateAggregation('field', e.target.value)}
                            >
                              <SelectItem value="" text="Select column..." />
                              {availableColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                          </Column>
                        )}
                        {AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.needsCount && (
                          <Column lg={4} md={4} sm={4}>
                            <NumberInput
                              id="aggregation-count"
                              label="Row Count"
                              value={aggregation.count}
                              onChange={(e, { value }) => updateAggregation('count', value)}
                              min={1}
                              max={1000}
                            />
                          </Column>
                        )}
                      </Grid>
                      <Grid narrow className="sort-row">
                        <Column lg={4} md={4} sm={4}>
                          <Select
                            id="sort-by"
                            labelText="Sort By"
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                          >
                            <SelectItem value="" text="None" />
                            {availableColumns.map(col => (
                              <SelectItem key={col} value={col} text={col} />
                            ))}
                          </Select>
                        </Column>
                        <Column lg={4} md={4} sm={4}>
                          <Select
                            id="sort-order"
                            labelText="Sort Order"
                            value={sortOrder}
                            onChange={(e) => setSortOrder(e.target.value)}
                            disabled={!sortBy}
                          >
                            <SelectItem value="asc" text="Ascending" />
                            <SelectItem value="desc" text="Descending" />
                          </Select>
                        </Column>
                        <Column lg={4} md={4} sm={4}>
                          <NumberInput
                            id="limit-rows"
                            label="Limit"
                            value={limitRows}
                            onChange={(e, { value }) => setLimitRows(value)}
                            min={0}
                            max={10000}
                            helperText="0 = no limit"
                          />
                        </Column>
                      </Grid>
                    </>
                  ) : (
                    <div className="saved-values-display">
                      {(aggregation?.type || sortBy || limitRows > 0) ? (
                        <>
                          <Grid narrow>
                            <Column lg={4} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Aggregation</label>
                                {aggregation?.type ? (
                                  <Tag type="purple">
                                    {AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.label || aggregation.type}
                                  </Tag>
                                ) : (
                                  <span className="no-value">None</span>
                                )}
                              </div>
                            </Column>
                            {aggregation?.sortBy && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">Agg Sort By</label>
                                  <Tag type="blue">{aggregation.sortBy}</Tag>
                                </div>
                              </Column>
                            )}
                            {aggregation?.field && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">Agg Field</label>
                                  <Tag type="blue">{aggregation.field}</Tag>
                                </div>
                              </Column>
                            )}
                            {aggregation?.type === 'limit' && (
                              <Column lg={4} md={4} sm={4}>
                                <div className="saved-value-field">
                                  <label className="cds--label">Agg Count</label>
                                  <Tag type="teal">{aggregation.count}</Tag>
                                </div>
                              </Column>
                            )}
                          </Grid>
                          <Grid narrow className="sort-row">
                            <Column lg={4} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Sort By</label>
                                {sortBy ? (
                                  <Tag type="blue">{sortBy}</Tag>
                                ) : (
                                  <span className="no-value">None</span>
                                )}
                              </div>
                            </Column>
                            <Column lg={4} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Sort Order</label>
                                <Tag type="gray">{sortOrder === 'asc' ? 'Ascending' : 'Descending'}</Tag>
                              </div>
                            </Column>
                            <Column lg={4} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Limit Rows</label>
                                <Tag type={limitRows > 0 ? 'teal' : 'gray'}>{limitRows > 0 ? limitRows : 'No limit'}</Tag>
                              </div>
                            </Column>
                          </Grid>
                          <p className="run-query-hint">Fetch data to modify aggregation and sorting.</p>
                        </>
                      ) : (
                        <p className="editor-info-hint">No aggregation configured.</p>
                      )}
                    </div>
                  )}
                </div>
                )}

                {/* Sliding Window Section - for time-series data.
                    Hidden when the connection's query already
                    expresses time bounds (SQL WHERE ts > … /
                    EdgeLake equivalent) — re-querying with a new
                    time literal is the natural pattern for those
                    types. */}
                {!showCustomCode && !queryLanguageOwnsClientSideOps && (
                <div className="sliding-window-section">
                  <div className="section-header">
                    <h4>Sliding Window (Time-Series)</h4>
                    <Toggle
                      id="sliding-window-toggle"
                      labelText=""
                      labelA="Off"
                      labelB="On"
                      toggled={slidingWindowEnabled}
                      onToggle={() => setSlidingWindowEnabled(!slidingWindowEnabled)}
                      size="sm"
                    />
                  </div>
                  {slidingWindowEnabled && (
                    <Grid narrow>
                      <Column lg={6} md={4} sm={4}>
                        <Select
                          id="sliding-window-timestamp"
                          labelText="Timestamp Column"
                          value={slidingWindowTimestampCol}
                          onChange={(e) => setSlidingWindowTimestampCol(e.target.value)}
                          disabled={availableColumns.length === 0}
                          helperText={
                            availableColumns.length === 0
                              ? (slidingWindowTimestampCol
                                  ? `Saved: ${slidingWindowTimestampCol}. Run a query to change it.`
                                  : 'Run a query to populate column choices.')
                              : undefined
                          }
                        >
                          <SelectItem value="" text="Select timestamp column..." />
                          {/* Include the saved column even when availableColumns
                              is empty, so the Select shows the value the user
                              previously chose. */}
                          {availableColumns.length === 0 && slidingWindowTimestampCol && (
                            <SelectItem
                              value={slidingWindowTimestampCol}
                              text={slidingWindowTimestampCol}
                            />
                          )}
                          {availableColumns.map(col => (
                            <SelectItem key={col} value={col} text={col} />
                          ))}
                        </Select>
                      </Column>
                      <Column lg={6} md={4} sm={4}>
                        <NumberInput
                          id="sliding-window-duration"
                          label="Window Duration (seconds)"
                          value={slidingWindowDuration}
                          onChange={(e, { value }) => setSlidingWindowDuration(value)}
                          min={10}
                          max={86400}
                          step={10}
                          helperText="e.g., 300 = 5 min, 3600 = 1 hour"
                        />
                      </Column>
                    </Grid>
                  )}
                  {!slidingWindowEnabled && (
                    <p className="editor-info-hint">
                      Enable to show only recent data (e.g., last 5 minutes). Useful for streaming/real-time charts.
                    </p>
                  )}
                </div>
                )}

                {/* Band Columns - banded_bar (Levey-Jennings) only */}
                {!showCustomCode && chartType === 'banded_bar' && (
                  <div className="reference-levels-section">
                    <div className="section-header">
                      <h4>Band Columns</h4>
                    </div>
                    <Grid narrow style={{ marginBottom: '1rem' }}>
                      <Column lg={16} md={8} sm={4}>
                        <Select
                          id="banded-bar-style"
                          labelText="Visual Style"
                          value={bandedBarStyle}
                          onChange={(e) => setBandedBarStyle(e.target.value)}
                        >
                          <SelectItem value="time_series" text="Time Series — line + dots, full-width bands (default)" />
                          <SelectItem value="column_filled" text="Column (filled) — vertical column per timestamp, no borders" />
                          <SelectItem value="column_outlined" text="Column (outlined) — vertical column with band borders" />
                          <SelectItem value="column_box" text="Column (box) — inner band only, line with tick at value" />
                        </Select>
                      </Column>
                    </Grid>
                    <p className="editor-info-hint" style={{ marginBottom: '0.75rem' }}>
                      Each row in the data must carry these columns. The renderer reads each row's own values to draw a per-row envelope — bands move with the data.
                    </p>
                    {[
                      { key: 'mean', label: 'Mean column', help: 'Primary value (required).' },
                      { key: 'plus_1sd', label: '+1 SD column', help: '' },
                      { key: 'minus_1sd', label: '-1 SD column', help: '' },
                      { key: 'plus_2sd', label: '+2 SD column', help: '' },
                      { key: 'minus_2sd', label: '-2 SD column', help: '' },
                    ].map(({ key, label, help }) => (
                      <Grid narrow key={key} style={{ marginBottom: '0.5rem' }}>
                        <Column lg={16} md={8} sm={4}>
                          <Select
                            id={`band-col-${key}`}
                            labelText={label}
                            helperText={help}
                            value={bandColumns[key] || ''}
                            onChange={(e) => setBandColumns({ ...bandColumns, [key]: e.target.value })}
                          >
                            <SelectItem value="" text={availableColumns.length > 0 ? 'Select a column…' : 'Run the query to discover columns'} />
                            {availableColumns.map((col) => (
                              <SelectItem key={col} value={col} text={col} />
                            ))}
                          </Select>
                        </Column>
                      </Grid>
                    ))}
                  </div>
                )}

                {/* Time Bucket Section - for socket streaming datasources only */}
                {selectedDatasource?.type === 'socket' && (
                  <div className="time-bucket-section">
                    <div className="section-header">
                      <h4>Time Bucket Aggregation (Streaming)</h4>
                      <Toggle
                        id="time-bucket-toggle"
                        labelText=""
                        labelA="Off"
                        labelB="On"
                        toggled={timeBucketEnabled}
                        onToggle={() => setTimeBucketEnabled(!timeBucketEnabled)}
                        size="sm"
                      />
                    </div>
                    {/* Warning when time bucket is enabled but incomplete */}
                    {timeBucketEnabled && (!timeBucketTimestampCol || timeBucketValueCols.length === 0) && (
                      <InlineNotification
                        kind="warning"
                        title="Incomplete configuration"
                        subtitle={
                          !timeBucketTimestampCol
                            ? 'Select a timestamp column to enable time bucket aggregation.'
                            : 'Select at least one value column to aggregate.'
                        }
                        lowContrast
                        hideCloseButton
                        style={{ marginBottom: '1rem' }}
                      />
                    )}
                    {timeBucketEnabled && (
                      availableColumns.length > 0 ? (
                        <Grid narrow>
                          <Column lg={3} md={4} sm={4}>
                            <NumberInput
                              id="time-bucket-interval"
                              label="Bucket Interval (seconds)"
                              value={timeBucketInterval}
                              onChange={(e, { value }) => setTimeBucketInterval(value)}
                              min={1}
                              max={86400}
                              step={1}
                              helperText="e.g., 60 = 1 min buckets"
                            />
                          </Column>
                          <Column lg={3} md={4} sm={4}>
                            <Select
                              id="time-bucket-function"
                              labelText="Aggregation Function"
                              value={timeBucketFunction}
                              onChange={(e) => setTimeBucketFunction(e.target.value)}
                            >
                              <SelectItem value="avg" text="Average" />
                              <SelectItem value="min" text="Minimum" />
                              <SelectItem value="max" text="Maximum" />
                              <SelectItem value="sum" text="Sum" />
                              <SelectItem value="count" text="Count" />
                            </Select>
                          </Column>
                          <Column lg={3} md={4} sm={4}>
                            <Select
                              id="time-bucket-timestamp"
                              labelText="Timestamp Column"
                              value={timeBucketTimestampCol}
                              onChange={(e) => setTimeBucketTimestampCol(e.target.value)}
                            >
                              <SelectItem value="" text="Select timestamp..." />
                              {availableColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                          </Column>
                          <Column lg={3} md={4} sm={4}>
                            <div className="value-cols-selector">
                              <label className="cds--label">Value Columns to Aggregate</label>
                              <div className="column-tags">
                                {availableColumns.filter(c => c !== timeBucketTimestampCol).map(col => (
                                  <Tag
                                    key={col}
                                    type={timeBucketValueCols.includes(col) ? 'blue' : 'gray'}
                                    onClick={() => {
                                      setTimeBucketValueCols(prev =>
                                        prev.includes(col)
                                          ? prev.filter(c => c !== col)
                                          : [...prev, col]
                                      );
                                    }}
                                    className="column-tag"
                                  >
                                    {col}
                                  </Tag>
                                ))}
                              </div>
                            </div>
                          </Column>
                        </Grid>
                      ) : timeBucketTimestampCol ? (
                        <div className="saved-values-display">
                          <Grid narrow>
                            <Column lg={3} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Interval</label>
                                <Tag type="teal">{timeBucketInterval}s</Tag>
                              </div>
                            </Column>
                            <Column lg={3} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Function</label>
                                <Tag type="purple">{timeBucketFunction}</Tag>
                              </div>
                            </Column>
                            <Column lg={3} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Timestamp</label>
                                <Tag type="blue">{timeBucketTimestampCol}</Tag>
                              </div>
                            </Column>
                            <Column lg={3} md={4} sm={4}>
                              <div className="saved-value-field">
                                <label className="cds--label">Value Columns</label>
                                <div className="column-tags">
                                  {timeBucketValueCols.map(col => (
                                    <Tag key={col} type="blue">{col}</Tag>
                                  ))}
                                </div>
                              </div>
                            </Column>
                          </Grid>
                          <p className="run-query-hint">Fetch data to modify time bucket settings.</p>
                        </div>
                      ) : (
                        <p className="run-query-hint">Fetch data to configure time bucket aggregation.</p>
                      )
                    )}
                    {!timeBucketEnabled && (
                      <p className="editor-info-hint">
                        Enable to aggregate streaming data into time buckets (e.g., 1-minute averages). Server-side aggregation reduces data volume for high-frequency streams.
                      </p>
                    )}
                  </div>
                )}

                {filteredPreviewData && (
                  <div className="data-preview">
                    <h4>
                      {filteredPreviewData.metadata?.filtered ? (
                        <>Filtered Results ({filteredPreviewData.rows?.length || 0} of {filteredPreviewData.metadata?.original_row_count || 0} rows)</>
                      ) : (
                        <>Query Results ({filteredPreviewData.metadata?.row_count || filteredPreviewData.rows?.length || 0} rows)</>
                      )}
                    </h4>
                    <div className="preview-table-container">
                      <table className="preview-table">
                        <thead>
                          <tr>
                            {filteredPreviewData.columns?.map(col => (
                              <th key={col}>{col}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filteredPreviewData.rows?.slice(0, 10).map((row, i) => (
                            <tr key={i}>
                              {row.map((cell, j) => (
                                <td key={j}>{formatCellValue(cell, filteredPreviewData.columns?.[j], { timestampFormat: xAxisFormat || 'short' })}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {filteredPreviewData.rows?.length > 10 && (
                        <p className="truncated-notice">Showing first 10 of {filteredPreviewData.rows?.length} rows...</p>
                      )}
                      {filteredPreviewData.rows?.length === 0 && (
                        <p className="no-results-notice">No rows match the current filters</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {!selectedDatasource && (
              <div className="no-datasource-message">
                <p>Select a connection to configure data-driven charts, or switch to the Code tab for a static chart.</p>
              </div>
            )}
          </div>
        )}

        {/* Preview Tab */}
        {isOnTab('preview') && (
          <div className="tab-content preview-tab">
            <div className="chart-preview-container">
              {generatedCode ? (
                <>
                  <div className="preview-chart-header">
                    <span className="preview-chart-name">{name || 'Untitled Chart'}</span>
                  </div>
                  <div className="preview-chart-body">
                    {/* Pass connectionId + queryConfig + dataMapping so the loader
                        fetches and transforms data the same way a live dashboard
                        panel does. Custom code that calls `useData(...)` itself
                        still works because the loader only injects `data` when
                        the component doesn't already provide it. */}
                    <DynamicComponentLoader
                      code={generatedCode}
                      componentMeta={{ title, name, description }}
                      connectionId={selectedConnectionId || null}
                      queryConfig={selectedConnectionId ? {
                        raw: selectedDatasource?.type === 'tsstore'
                          ? (tsstoreQueryType === 'since' ? `since:${tsstoreSinceDuration}` : tsstoreQueryType)
                          : queryRaw,
                        type: queryType,
                        params: selectedDatasource?.type === 'tsstore'
                          ? (tsstoreQueryType === 'since' ? {} : { limit: tsstoreLimit })
                          : selectedDatasource?.type === 'edgelake' && edgelakeDatabase
                            ? { database: edgelakeDatabase }
                            : {}
                      } : null}
                      dataMapping={selectedConnectionId ? {
                        connection_id: selectedConnectionId,
                        x_axis: xAxisColumn,
                        x_axis_label: xAxisLabel || '',
                        x_axis_format: xAxisFormat || 'chart',
                        y_axis: yAxisColumns,
                        y_axis_label: (yAxisLabels && yAxisLabels[0]) || yAxisLabel || '',
                        y_axis_labels: yAxisLabels && yAxisLabels.length > 0 ? yAxisLabels : undefined,
                        group_by: groupByColumn || '',
                        series: seriesColumn || '',
                        filters: filters.length > 0 ? filters : [],
                        aggregation: aggregation.type ? aggregation : null,
                        sort_by: sortBy || '',
                        sort_order: sortOrder || 'desc',
                        limit: limitRows || 0,
                        column_aliases: Object.keys(columnAliases).length > 0 ? columnAliases : null,
                        visible_columns: Array.isArray(visibleColumns) && visibleColumns.length > 0 ? visibleColumns : undefined,
                        parser: parserPreset !== 'none' && (parserDataPath || parserTimestampField) ? {
                          data_path: parserDataPath || undefined,
                          timestamp_field: parserTimestampField || undefined,
                          timestamp_scale: parserTimestampScale || undefined
                        } : null
                      } : null}
                      props={{}}
                    />
                  </div>
                </>
              ) : (
                <div className="preview-placeholder">
                  <ChartBar size={48} />
                  <p>Configure connection and mapping to see chart preview</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Code Tab */}
        {isOnTab('code') && (
          <div className="tab-content code-tab">
            <div className="code-header">
              <div className="code-switcher">
                <span className="code-switcher-label">Code</span>
                <ContentSwitcher
                  selectedIndex={showCustomCode ? 1 : 0}
                  onChange={(e) => setShowCustomCode(e.index === 1)}
                  size="sm"
                >
                  <Switch name="generated" text="Generated" />
                  <Switch name="custom" text="Custom" />
                </ContentSwitcher>
              </div>
              <p className="code-help">
                Available: useState, useEffect, useMemo, useCallback, useRef, useData, transformData, toObjects, getValue, formatTimestamp, formatCellValue, echarts, ReactECharts
              </p>
            </div>

            {/* Runtime-context summary. The connection, query, parser
                config, and sliding window are NOT inlined into the
                React code — the runtime resolves them via
                `query_config` and `data_mapping.{parser, sliding_window}`
                before invoking the component with `data`. So in
                custom-code mode the user can't see those settings by
                reading the code; this strip surfaces them and links
                back to the Connection tab where they're edited. */}
            {showCustomCode && (selectedDatasource || queryRaw || parserDataPath || slidingWindowEnabled) && (
              <div className="custom-code-runtime-summary">
                <div className="summary-row">
                  <span className="summary-label">Connection</span>
                  <span className="summary-value">
                    {selectedDatasource
                      ? `${selectedDatasource.name} (${selectedDatasource.type})`
                      : <em className="summary-empty">Not set</em>}
                  </span>
                </div>
                {queryRaw && (
                  <div className="summary-row">
                    <span className="summary-label">Query</span>
                    <code className="summary-value summary-value--code">
                      {queryRaw.length > 120 ? `${queryRaw.slice(0, 120)}…` : queryRaw}
                    </code>
                  </div>
                )}
                {(parserDataPath || parserTimestampField) && (
                  <div className="summary-row">
                    <span className="summary-label">Parser</span>
                    <span className="summary-value">
                      {parserDataPath ? `data_path: ${parserDataPath}` : ''}
                      {parserDataPath && parserTimestampField ? ' · ' : ''}
                      {parserTimestampField ? `timestamp: ${parserTimestampField}` : ''}
                      {parserTimestampScale ? ` (${parserTimestampScale})` : ''}
                    </span>
                  </div>
                )}
                {slidingWindowEnabled && slidingWindowDuration && (
                  <div className="summary-row">
                    <span className="summary-label">Sliding window</span>
                    <span className="summary-value">
                      {slidingWindowDuration}{slidingWindowTimestampCol ? ` on ${slidingWindowTimestampCol}` : ''}
                    </span>
                  </div>
                )}
                <div className="summary-actions">
                  <Button
                    kind="ghost"
                    size="sm"
                    onClick={() => setActiveTab(0)}
                  >
                    Edit in Connection tab
                  </Button>
                </div>
              </div>
            )}

            <TextArea
              id="component-code"
              labelText=""
              value={showCustomCode ? componentCode : generatedCode}
              onChange={(e) => {
                if (showCustomCode) {
                  setComponentCode(e.target.value);
                }
              }}
              readOnly={!showCustomCode}
              rows={25}
              className="code-textarea"
            />
          </div>
        )}
      </div>
        </>
        );
      })()}

      {/* Action buttons (optional, for standalone page use) */}
      {showActions && (
        <div className="component-editor-actions">
          <Button
            kind="secondary"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            kind="primary"
            onClick={handleSave}
            disabled={saving || !name.trim() || !hasChanges}
          >
            {saving ? 'Saving...' : (chart?.id ? 'Save Changes' : 'Create Chart')}
          </Button>
        </div>
      )}
    </div>
  );
});

// Helper functions to generate chart code.
// Exported so AIComponentPreview (and any future render path that
// needs to materialize a component from its structured config) can
// reuse the exact same generator the manual editor runs at save time,
// keeping the rendered output consistent across surfaces.
export function getStaticChartCode(chartType) {
  const templates = {
    bar: `const Component = () => {
  const [data] = useState([
    { name: 'Jan', value: 400 },
    { name: 'Feb', value: 300 },
    { name: 'Mar', value: 500 },
    { name: 'Apr', value: 280 },
    { name: 'May', value: 590 },
  ]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map(d => d.name) },
    yAxis: { type: 'value' },
    series: [{ data: data.map(d => d.value), type: 'bar', itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    line: `const Component = () => {
  const [data] = useState([
    { name: 'Jan', value: 400 },
    { name: 'Feb', value: 300 },
    { name: 'Mar', value: 500 },
    { name: 'Apr', value: 280 },
    { name: 'May', value: 590 },
  ]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map(d => d.name) },
    yAxis: { type: 'value' },
    series: [{ data: data.map(d => d.value), type: 'line', smooth: true, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    area: `const Component = () => {
  const [data] = useState([
    { name: 'Jan', value: 400 },
    { name: 'Feb', value: 300 },
    { name: 'Mar', value: 500 },
    { name: 'Apr', value: 280 },
    { name: 'May', value: 590 },
  ]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: data.map(d => d.name), boundaryGap: false },
    yAxis: { type: 'value' },
    series: [{ data: data.map(d => d.value), type: 'line', areaStyle: {}, smooth: true, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    pie: `const Component = () => {
  const [data] = useState([
    { name: 'Category A', value: 400 },
    { name: 'Category B', value: 300 },
    { name: 'Category C', value: 200 },
    { name: 'Category D', value: 100 },
  ]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    series: [{
      type: 'pie',
      radius: '70%',
      data: data,
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    scatter: `const Component = () => {
  const [data] = useState([
    [10, 20], [20, 30], [30, 25], [40, 45], [50, 35], [60, 55], [70, 40]
  ]);

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'item' },
    xAxis: { type: 'value' },
    yAxis: { type: 'value' },
    series: [{ data: data, type: 'scatter', symbolSize: 15, itemStyle: { color: '#0f62fe' } }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`,
    gauge: `const Component = () => {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 200, height: 200 });
  const [value] = useState(72);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      // Only update if size changed by more than 1px to prevent resize loops
      setContainerSize(prev => {
        if (Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
          return { width, height };
        }
        return prev;
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // Calculate responsive sizes - all proportional, no minimums
  const minDim = Math.min(containerSize.width, containerSize.height);
  const baseFontSize = Math.floor(minDim * 0.12);
  const labelFontSize = Math.floor(minDim * 0.06);
  const axisLineWidth = Math.floor(minDim * 0.08);
  const splitLineLength = Math.floor(minDim * 0.05);
  const anchorSize = Math.floor(minDim * 0.08);

  const option = {
    backgroundColor: 'transparent',
    series: [{
      type: 'gauge',
      progress: { show: false },
      axisLine: { lineStyle: { width: axisLineWidth } },
      axisTick: { show: false },
      splitLine: { length: splitLineLength, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { distance: Math.floor(minDim * 0.08), color: '#999', fontSize: labelFontSize },
      anchor: { show: true, showAbove: true, size: anchorSize, itemStyle: { borderWidth: Math.floor(anchorSize * 0.4) } },
      title: { show: false },
      detail: { valueAnimation: true, fontSize: baseFontSize, offsetCenter: [0, '70%'] },
      data: [{ value: value, name: 'Score' }]
    }]
  };

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
    </div>
  );
};`,
    custom: `const Component = () => {
  // Custom chart component
  // Use useData hook for data fetching:
  // const { data, loading, error } = useData({ connectionId: 'your-id', query: {...} });

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <p>Custom chart component</p>
    </div>
  );
};`
  };

  return templates[chartType] || templates.bar;
}

export function getDataDrivenChartCode(chartType, connectionId, queryRaw, queryType, xAxisCol, yAxisCols, transforms = {}, chartOptions = {}, queryParams = {}, seriesCol = '', columnAliases = {}, isStreaming = false, slidingWindow = null, parserConfig = null, chartId = '', isTSStoreStreaming = false) {
  const yAxisStr = yAxisCols.length > 0 ? yAxisCols.map(c => `'${c}'`).join(', ') : "'value'";
  const { filters = [], aggregation = null, sortBy = '', sortOrder = 'desc', limit = 0, xAxisFormat = 'chart', xAxisLabel = '', yAxisLabel = '', yAxisLabels = [], visibleColumns = null, chartName = '' } = transforms;

  // Y-axis name policy:
  //   - Single y column: emit the axis name (y_axis_labels[0] | y_axis_label | column name).
  //   - Two y columns:   NO axis names. The left/right axes keep their
  //     color-coded tick labels and axis lines, but the series identity
  //     lives in the legend where toggling hides the name together with
  //     the line. An axis `name` on ECharts stays visible when the series
  //     is legend-hidden, which looks broken.
  //   - Three+ y columns: no axis names; legend carries identity.
  //
  // X-axis name is opt-in: most charts are time-based and don't benefit
  // from a name.
  const singleYName = (() => {
    if (yAxisCols.length !== 1) return '';
    const labels = Array.isArray(yAxisLabels) ? yAxisLabels : [];
    return (labels[0] && labels[0].trim()) || yAxisLabel || yAxisCols[0] || '';
  })();
  const showXAxisName = !!(xAxisLabel && xAxisLabel.trim());
  const showSingleYName = !!singleYName;
  // Build extra useData options (backfill, parser) — each prefixed with `,\n    `.
  // refreshInterval is intentionally not emitted here. Polling cadence is
  // driven by the dashboard's settings.refresh_interval, applied via
  // DynamicComponentLoader's dataRefreshInterval prop. A hardcoded
  // refreshInterval here would override the dashboard setting silently,
  // which is confusing and was the previous behavior. Leave it off and
  // let the loader-level value take effect.
  const extraOptions = [];
  if (isStreaming && slidingWindow?.duration > 0) {
    // Sliding-window backfill: pull every record from the last N
    // seconds so the chart isn't blank while waiting for the next
    // streaming push. ts-store accepts "since:30m"/"5m"/"45s"-style
    // shorthand on its REST query path.
    const dur = slidingWindow.duration;
    const sinceStr = dur >= 3600 && dur % 3600 === 0 ? `${dur / 3600}h`
      : dur >= 60 && dur % 60 === 0 ? `${dur / 60}m`
      : `${dur}s`;
    extraOptions.push(`backfill: { raw: 'since:${sinceStr}', type: '${queryType}', params: {} }`);
  } else if (isTSStoreStreaming) {
    // No sliding window set, but ts-store can still serve a quick
    // "latest N" backfill so the chart paints immediately instead of
    // sitting empty until the next push arrives. Single-value charts
    // (gauge, number) only need the latest record; everything else
    // gets 100 for context. The hook (useData) supplies a 100-record
    // default if no backfill is emitted at all, so this generator path
    // is mostly about the gauge/number override.
    const limit = (chartType === 'gauge' || chartType === 'number') ? 1 : 100;
    extraOptions.push(`backfill: { raw: 'newest', type: '${queryType}', params: { limit: ${limit} } }`);
  }
  if (parserConfig && (parserConfig.dataPath || parserConfig.timestampField)) {
    const parts = [];
    if (parserConfig.dataPath) parts.push(`dataPath: '${parserConfig.dataPath}'`);
    if (parserConfig.timestampField) parts.push(`timestampField: '${parserConfig.timestampField}'`);
    if (parserConfig.timestampScale) parts.push(`timestampScale: '${parserConfig.timestampScale}'`);
    extraOptions.push(`parser: { ${parts.join(', ')} }`);
  }
  const extraOptionsLine = extraOptions.length > 0
    ? ',\n    ' + extraOptions.join(',\n    ')
    : '';

  // Streaming charts destructure extra fields and show "Waiting for data..." instead of "No data"
  const useDataFields = isStreaming
    ? '{ data, loading, error, isStreaming, connected }'
    : '{ data, loading, error }';
  const noDataLine = isStreaming
    ? "if (!data?.rows?.length) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6f6f6f' }}>{connected ? 'Waiting for data...' : 'Connecting...'}</div>;"
    : "if (!data?.rows?.length) return <div style={{ color: '#6f6f6f', padding: '1rem' }}>No data</div>;";

  const hasTransforms = filters.length > 0 || aggregation?.type || sortBy || limit > 0;
  const transformsConfig = hasTransforms ? `
  // Apply client-side transforms
  const transforms = {
    filters: ${JSON.stringify(filters.map(f => ({
      field: f.field,
      op: f.op,
      value: f.op === 'in' || f.op === 'notIn' ? f.value.split(',').map(v => v.trim()) : f.value
    })))},
    aggregation: ${aggregation?.type ? JSON.stringify(aggregation) : 'null'},
    sortBy: ${sortBy ? `'${sortBy}'` : 'null'},
    sortOrder: '${sortOrder}',
    limit: ${limit}
  };
  const transformed = transformData(data, transforms);
  const rows = transformed.rows;` : `
  const rows = data.rows;`;

  // Helper to format x-axis values - uses the configured format
  // Available formats: chart (date+time), chart_time, chart_date, chart_datetime, short, long, etc.
  const xAxisFormatCode = `
  // Format x-axis values (auto-detect timestamps, format: ${xAxisFormat})
  const formatXValue = (val, colName) => formatCellValue(val, colName, { timestampFormat: '${xAxisFormat}' });`;

  // Generate series code - if seriesCol is provided, split data by that column
  let seriesCode;
  if (seriesCol) {
    // Series column provided - split data into multiple series by unique values
    seriesCode = `// Group data by series column: ${seriesCol}
    const cols = ${hasTransforms ? 'transformed' : 'data'}.columns;
    const seriesColIdx = cols.indexOf('${seriesCol}');
    const xColIdx = cols.indexOf('${xAxisCol}');
    const yColIdx = cols.indexOf(${yAxisStr.split(',')[0]});

    // Get unique series values
    const seriesValues = [...new Set(rows.map(r => r[seriesColIdx]))].filter(v => v != null);

    // Build series for each unique value
    const series = seriesValues.map((seriesValue, idx) => {
      const seriesRows = rows.filter(r => r[seriesColIdx] === seriesValue);
      return {
        name: String(seriesValue),
        data: seriesRows.map(r => r[yColIdx]),
        type: '${chartType === 'area' ? 'line' : chartType}',
        ${chartType === 'area' ? 'areaStyle: {},' : ''}
        ${chartType === 'line' || chartType === 'area' ? 'smooth: true,' : ''}
      };
    });

    // Use x values from first series (assumes all series have same x values sorted by time)
    const firstSeriesRows = rows.filter(r => r[seriesColIdx] === seriesValues[0]);
    const categories = firstSeriesRows.map(r => formatXValue(r[xColIdx], '${xAxisCol}'));`;
  } else if (yAxisCols.length > 1) {
    // Per-column display names (legend). Falls back to the column name when
    // the user hasn't overridden it. This is how y-axis "labels" reach the
    // user when there are two y columns — the axis itself has no name (see
    // y-axis naming policy above), but each series in the legend does.
    const seriesNamesArr = yAxisCols.map((col, i) => {
      const override = Array.isArray(yAxisLabels) ? yAxisLabels[i] : '';
      return override && override.trim() ? override.trim() : col;
    });
    const seriesNamesLiteral = JSON.stringify(seriesNamesArr);
    seriesCode = `const yColumns = [${yAxisStr}];
    const seriesNames = ${seriesNamesLiteral};
    const series = yColumns.map((col, idx) => ({
      name: seriesNames[idx] || col,
      data: rows.map(r => r[${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(col)]),
      type: '${chartType === 'area' ? 'line' : chartType}',
      ${chartType === 'area' ? 'areaStyle: {},' : ''}
      ${chartType === 'line' || chartType === 'area' ? 'smooth: true,' : ''}
      ${yAxisCols.length === 2 ? 'yAxisIndex: idx,' : ''}
    }));`;
  } else {
    seriesCode = `const yColumns = [${yAxisStr}];
    const series = [{
      data: rows.map(r => r[${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(yColumns[0])]),
      type: '${chartType === 'area' ? 'line' : chartType}',
      ${chartType === 'area' ? 'areaStyle: {},' : ''}
      ${chartType === 'line' || chartType === 'area' ? 'smooth: true,' : ''}
      itemStyle: { color: '#0f62fe' }
    }];`;
  }

  if (chartType === 'pie') {
    return `const Component = () => {
  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  ${noDataLine}
${transformsConfig}
${xAxisFormatCode}

  const xCol = '${xAxisCol}';
  const yCol = ${yAxisStr.split(',')[0]};
  const xIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(xCol);
  const yIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(yCol);

  const pieData = rows.map(r => ({ name: formatXValue(r[xIdx], xCol), value: Number(r[yIdx]) }));

  const option = {
    backgroundColor: 'transparent',
    ${chartName ? `title: { text: '${chartName.replace(/'/g, "\\'")}', left: 'center', top: 16, textStyle: { color: '#f4f4f4', fontSize: 16 } },` : ''}
    tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
    series: [{
      type: 'pie',
      radius: '70%',
      center: ['50%', ${chartName ? "'58%'" : "'50%'"}],
      data: pieData,
      emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
    }]
  };

  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
  }

  if (chartType === 'dataview') {
    // AG Grid Community emit. Virtualized, Quartz theme skinned with
    // Carbon tokens. Per-column sort, filter, resize, reorder, pin all
    // built-in. Handles streaming journal data that broke the IBM
    // Products Datagrid. visible_columns + column_aliases honored as
    // chart defaults; columns auto-size to their content via AG Grid's
    // fitCellContents strategy. useDataviewLayout (injected by
    // DynamicComponentLoader) layers per-user resize/reorder overrides
    // on top.
    const aliasesJson = JSON.stringify(columnAliases || {});
    const visibleJson = visibleColumns === null || visibleColumns === undefined ? 'null' : JSON.stringify(visibleColumns);
    const chartIdLiteral = JSON.stringify(chartId || '');
    const dataSrc = hasTransforms ? 'transformed' : 'data';
    return `const Component = () => {
  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  const columnAliases = ${aliasesJson};
  const visibleColumnsConfig = ${visibleJson};
  const chartId = ${chartIdLiteral};

  // Per-user layout override — order + widths layered on top of the
  // chart defaults. useDataviewLayout is injected into the eval scope
  // by DynamicComponentLoader; it returns the user's stored layout
  // for this chart_id and a saver to push changes back.
  const { layout: userLayout, saveLayout } = (typeof useDataviewLayout === 'function')
    ? useDataviewLayout(chartId)
    : { layout: null, saveLayout: () => {} };

  const allColumns = (!loading && !error && ${dataSrc}?.columns) || [];
  // Effective order: user's saved order if it covers the same columns,
  // else chart's visible_columns config, else all columns.
  const orderedColumns = (() => {
    const baseOrder = visibleColumnsConfig
      ? visibleColumnsConfig.filter(c => allColumns.includes(c))
      : allColumns;
    if (userLayout?.order && Array.isArray(userLayout.order) && userLayout.order.length > 0) {
      const known = new Set(baseOrder);
      const fromUser = userLayout.order.filter(c => known.has(c));
      const missing = baseOrder.filter(c => !userLayout.order.includes(c));
      return [...fromUser, ...missing];
    }
    return baseOrder;
  })();

  const columnsKey = orderedColumns.join('|');
  // Row objects derived from the latest snapshot. Stable __id (content
  // hash + index) so AG Grid's filter, sort, menu state, and scroll
  // position survive streaming buffer slices.
  const latestRowObjs = useMemo(() => {
    if (!${dataSrc}?.rows) return [];
    return ${dataSrc}.rows.map((row, idx) => {
      const o = {};
      allColumns.forEach((c, i) => { o[c] = row[i]; });
      let h = 0;
      for (let i = 0; i < row.length; i++) {
        const s = row[i] == null ? '' : String(row[i]);
        for (let j = 0; j < s.length; j++) { h = ((h << 5) - h + s.charCodeAt(j)) | 0; }
      }
      o.__id = String(h) + '-' + idx;
      return o;
    });
  }, [${dataSrc}?.rows, columnsKey]);

  // Grid mount strategy: feed only the first snapshot as rowData, then
  // switch to imperative applyTransaction() so the grid stays mounted
  // and open filter menus don't close on every streaming batch.
  const gridRef = useRef(null);
  const initialRowDataRef = useRef(null);
  if (initialRowDataRef.current === null && latestRowObjs.length > 0) {
    initialRowDataRef.current = latestRowObjs;
  }

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || latestRowObjs.length === 0) return;
    const existingIds = new Set();
    api.forEachNode(node => { if (node.data?.__id) existingIds.add(node.data.__id); });
    const incomingIds = new Set(latestRowObjs.map(r => r.__id));
    const toAdd = latestRowObjs.filter(r => !existingIds.has(r.__id));
    const toRemove = [];
    api.forEachNode(node => {
      if (node.data?.__id && !incomingIds.has(node.data.__id)) {
        toRemove.push(node.data);
      }
    });
    if (toAdd.length || toRemove.length) {
      api.applyTransaction({ add: toAdd, remove: toRemove });
    }
  }, [latestRowObjs]);

  const columnDefs = useMemo(() => {
    return orderedColumns.map(col => {
      const isTimeCol = /time/i.test(col) || col === 'ts';
      const sampleVal = latestRowObjs[0]?.[col];
      const isNumCol = !isTimeCol && typeof sampleVal === 'number';
      // User-override widths (set by live drag-resize, persisted via
      // useDataviewLayout) take precedence over the grid's autosize.
      // Without a user override, the grid's autoSizeStrategy sizes
      // the column to its content on mount.
      const userWidth = userLayout?.widths?.[col];
      // AG Grid's field prop treats dots as nested-path navigation
      // (data['cpu']['pct']), which silently empties columns whose
      // names literally contain dots (e.g. ts-store flat keys like
      // 'cpu.pct'). Use a closure-captured valueGetter keyed on the
      // literal name + an explicit colId so reorder / resize state
      // still persists by column name.
      const colKey = col;
      const def = {
        colId: colKey,
        headerName: columnAliases[col] || col,
        valueGetter: (params) => params.data?.[colKey],
        sortable: true,
        resizable: true,
        filter: isNumCol ? 'agNumberColumnFilter' : (isTimeCol ? 'agDateColumnFilter' : 'agTextColumnFilter'),
        floatingFilter: false,
        valueFormatter: (params) => {
          const v = params.value;
          if (v == null) return '';
          const f = formatCellValue(v, col, { timestampFormat: '${transforms.xAxisFormat || 'short'}' });
          return f == null ? '' : String(f);
        },
        minWidth: isNumCol ? 100 : (isTimeCol ? 170 : 120),
      };
      if (userWidth && userWidth > 0) {
        def.width = userWidth;
        def.flex = 0;
      }
      return def;
    });
  }, [columnsKey, userLayout]);

  // No default flex — columns size to their content via the grid's
  // autoSizeStrategy=fitCellContents. A default flex=1 would cause
  // AG Grid to redistribute leftover row space evenly across columns,
  // overriding the autosize.
  const defaultColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
  }), []);

  // Persist user layout changes (resize + reorder) to app_config.
  // Debounced via the saver itself in useDataviewLayout.
  const handleColumnResized = (event) => {
    if (!event.finished || !event.column || !chartId) return;
    saveLayout((prev) => {
      const widths = { ...(prev?.widths || {}) };
      widths[event.column.getColId()] = event.column.getActualWidth();
      return { ...prev, widths };
    });
  };
  const handleColumnMoved = (event) => {
    if (!chartId) return;
    const api = gridRef.current?.api;
    if (!api) return;
    // colId is the canonical column identifier (we now set it explicitly
    // because field is used as a path lookup, not a literal name).
    const ids = api.getColumnDefs().map((c) => c.colId || c.field);
    saveLayout((prev) => ({ ...prev, order: ids }));
  };

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  if (!${dataSrc}?.rows?.length) {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6f6f6f' }}>{typeof connected !== 'undefined' && connected === false ? 'Connecting...' : (typeof connected !== 'undefined' ? 'Waiting for data...' : 'No data')}</div>;
  }

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column', backgroundColor: 'transparent', overflow: 'hidden' }}>
      ${transforms.chartName ? `<div style={{ display: 'block', height: '2.5rem', lineHeight: '2.5rem', flexShrink: 0, padding: '0 0.75rem', fontSize: '1rem', fontWeight: '600', color: 'var(--cds-text-primary)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        ${transforms.chartName.replace(/'/g, "\\'")}
      </div>` : ''}
      <div className="ag-theme-quartz-dark" style={{ flex: 1, minHeight: 0 }}>
        <AgGridReact
          ref={gridRef}
          theme="legacy"
          rowData={initialRowDataRef.current || []}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          autoSizeStrategy={{ type: 'fitCellContents' }}
          animateRows={false}
          suppressCellFocus={true}
          getRowId={(params) => String(params.data.__id)}
          maintainColumnOrder={true}
          onColumnResized={handleColumnResized}
          onColumnMoved={handleColumnMoved}
        />
      </div>
    </div>
  );
};`;
  }


  if (chartType === 'number') {
    // "Number" chart: display title + a single large numeric value + optional
    // inline unit at the same size. Reads the first y-axis column from the
    // first post-aggregation row — same data contract as the gauge.
    //
    // Title is rendered inline (like gauge's ECharts `title:` option) rather
    // than via the panel chrome, so it sits in the chart's own coord space
    // and can be styled consistently.
    const size = Number(chartOptions?.numberSize) > 0 ? Number(chartOptions.numberSize) : 120;
    const unit = (chartOptions?.numberUnit || '').replace(/'/g, "\\'");
    const titleText = (chartName || '').replace(/'/g, "\\'");

    return `const Component = () => {
  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#c6c6c6' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  ${noDataLine}
${transformsConfig}

  const yCol = ${yAxisStr.split(',')[0]};
  const yIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(yCol);
  const raw = rows.length > 0 ? rows[0][yIdx] : null;
  const formatted = raw == null ? '' : formatCellValue(raw, yCol);

  // Title sits absolutely at the top (matches gauge's ECharts top=16 placement
  // so titles align across chart types in a dashboard row). Value absolute-
  // centers in the full panel — its vertical position is independent of
  // whether a title is shown, so swapping between titled/untitled doesn't
  // reflow the number.
  return (
    <div style={{
      width: '100%',
      height: '100%',
      position: 'relative',
      overflow: 'hidden',
    }}>
      ${titleText ? `<div style={{ position: 'absolute', top: 0, left: 0, right: 0, fontSize: '1rem', lineHeight: 1.5, fontWeight: 600, color: '#f4f4f4', textAlign: 'center', padding: '0 0.75rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${titleText}</div>` : ''}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{
          fontSize: '${size}px',
          fontWeight: 600,
          lineHeight: 1,
          color: '#f4f4f4',
          fontVariantNumeric: 'tabular-nums',
          whiteSpace: 'nowrap',
        }}>
          {formatted}${unit ? `<span style={{ marginLeft: '0.25em' }}>${unit}</span>` : ''}
        </span>
      </div>
    </div>
  );
};`;
  }


  if (chartType === 'gauge') {
    // Extract gauge options with defaults
    const gaugeMin = chartOptions?.gaugeMin ?? 0;
    const gaugeMax = chartOptions?.gaugeMax ?? 100;
    const warningThreshold = (chartOptions?.gaugeWarningThreshold ?? 70) / 100;
    const dangerThreshold = (chartOptions?.gaugeDangerThreshold ?? 90) / 100;
    const unit = chartOptions?.gaugeUnit || '';
    const lineThickness = (chartOptions?.gaugeLineThickness ?? 8) / 100; // Convert to decimal
    const detailFormatter = unit ? `'{value}${unit}'` : "'{value}'";

    return `const Component = () => {
  const containerRef = useRef(null);
  const [containerSize, setContainerSize] = useState({ width: 200, height: 200 });

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      // Only update if size changed by more than 1px to prevent resize loops
      setContainerSize(prev => {
        if (Math.abs(prev.width - width) > 1 || Math.abs(prev.height - height) > 1) {
          return { width, height };
        }
        return prev;
      });
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  ${noDataLine}
${transformsConfig}

  const yCol = ${yAxisStr.split(',')[0]};
  const yIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(yCol);
  const value = rows.length > 0 ? Number(rows[0][yIdx]) : 0;

  // Calculate responsive sizes based on container - all proportional, no minimums
  const minDim = Math.min(containerSize.width, containerSize.height);
  const baseFontSize = Math.floor(minDim * 0.12);
  const titleFontSize = Math.floor(minDim * 0.08);
  const labelFontSize = Math.floor(minDim * 0.06);
  const axisLineWidth = Math.floor(minDim * ${lineThickness});
  const splitLineLength = Math.floor(minDim * 0.05);
  const anchorSize = Math.floor(minDim * 0.08);

  // Calculate all spacing as percentage of minDim for consistent scaling
  const topMarginPercent = 0; // Top margin as percentage
  const titleHeightPercent = ${chartName ? 'Math.max(8, (titleFontSize / containerSize.height) * 100)' : '0'};
  const gapPercent = 1; // Gap between title and gauge
  const totalTitleSpace = ${chartName ? 'topMarginPercent + titleHeightPercent + gapPercent' : '0'};
  const gaugeCenter = ['50%', String(55 + totalTitleSpace / 2) + '%'];
  const gaugeRadius = String(95 - totalTitleSpace) + '%';
  const titleTop = String(topMarginPercent) + '%';

  const option = {
    backgroundColor: 'transparent',
    ${chartName ? `title: { text: '${chartName.replace(/'/g, "\\'")}', left: 'center', top: titleTop, textStyle: { color: '#f4f4f4', fontSize: titleFontSize } },` : ''}
    series: [{
      type: 'gauge',
      min: ${gaugeMin},
      max: ${gaugeMax},
      center: gaugeCenter,
      radius: gaugeRadius,
      progress: { show: false },
      axisLine: {
        lineStyle: {
          width: axisLineWidth,
          color: [
            [${warningThreshold}, '#24a148'],
            [${dangerThreshold}, '#f1c21b'],
            [1, '#da1e28']
          ]
        }
      },
      axisTick: { show: false },
      splitLine: { length: splitLineLength, lineStyle: { width: 2, color: '#999' } },
      axisLabel: { distance: Math.floor(minDim * 0.08), color: '#999', fontSize: labelFontSize },
      anchor: { show: true, showAbove: true, size: anchorSize, itemStyle: { borderWidth: Math.floor(anchorSize * 0.4) } },
      title: { show: false },
      detail: { valueAnimation: true, fontSize: baseFontSize, offsetCenter: [0, '75%'], formatter: ${detailFormatter} },
      data: [{ value: value, name: yCol }]
    }]
  };

  return (
    <div ref={containerRef} style={{ height: '100%', width: '100%' }}>
      <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
    </div>
  );
};`;
  }

  if (chartType === 'banded_bar') {
    // Banded bar (Levey-Jennings / control chart) — per-row only.
    // Each row carries its own mean + ±1 SD + ±2 SD columns; the
    // renderer reads each row's own values to draw a per-row envelope.
    // The user picks which row column maps to each band role via
    // bandColumns; xAxisCol is the timestamp.
    const bc = transforms.bandColumns || {};
    const style = transforms.bandedBarStyle || 'time_series';

    // Refuse to emit a working chart shell when required columns aren't
    // chosen yet — better to render a clear placeholder than a blank
    // canvas with no error visible to the user.
    if (!xAxisCol || !bc.mean) {
      const missing = [];
      if (!xAxisCol) missing.push('x-axis (time) column');
      if (!bc.mean) missing.push('Mean column in Band Columns');
      return `const Component = () => (
  <div style={{ color: '#c6c6c6', padding: 16 }}>
    Banded Bar Chart needs ${missing.join(' and ')} configured. Run the query, then pick the column(s) in the data-mapping section above.
  </div>
);`;
    }

    // JSON-encode column names so the generated code reads them as strings.
    const xColJSON   = JSON.stringify(xAxisCol);
    const meanJSON   = JSON.stringify(bc.mean);
    const m1JSON     = JSON.stringify(bc.minus_1sd || '');
    const p1JSON     = JSON.stringify(bc.plus_1sd || '');
    const m2JSON     = JSON.stringify(bc.minus_2sd || '');
    const p2JSON     = JSON.stringify(bc.plus_2sd || '');
    const xFmtJSON   = JSON.stringify(transforms.xAxisFormat || 'chart');

    if (style === 'time_series') {
      // Stacked-band areaStyle envelope behind the mean line.
      return `const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{ color: '#c6c6c6', padding: 16 }}>Waiting for data…</div>;

  const xCol = ${xColJSON};
  const meanCol = ${meanJSON};
  const m2Col = ${m2JSON}, m1Col = ${m1JSON}, p1Col = ${p1JSON}, p2Col = ${p2JSON};

  const rows = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], ${xFmtJSON}));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m1sd = m1Col ? rows.map(r => +parseFloat(r[m1Col])) : null;
  const p1sd = p1Col ? rows.map(r => +parseFloat(r[p1Col])) : null;
  const m2sd = m2Col ? rows.map(r => +parseFloat(r[m2Col])) : null;
  const p2sd = p2Col ? rows.map(r => +parseFloat(r[p2Col])) : null;

  const has1SD = m1sd && p1sd;
  const has2SD = m2sd && p2sd;
  const baseLow = has2SD ? m2sd : (has1SD ? m1sd : null);
  const wOuterLo = (has2SD && has1SD) ? rows.map((_, i) => +(m1sd[i] - m2sd[i]).toFixed(4)) : null;
  const wInner   = has1SD ? rows.map((_, i) => +(p1sd[i] - m1sd[i]).toFixed(4)) : null;

  // Y-axis bounds. Auto-scale puts the floor at 0 because the bar-width
  // helper series carry small delta values, which makes the bands look
  // tiny against an empty panel. Compute explicit bounds: the wider of
  // ±3 SD (extrapolated from the available SD columns) or 10% of the
  // mean. Falls back to data extent + 10% when no SD info is present.
  const yLowData  = has2SD ? Math.min(...m2sd) : has1SD ? Math.min(...m1sd) : Math.min(...meanVals);
  const yHighData = has2SD ? Math.max(...p2sd) : has1SD ? Math.max(...p1sd) : Math.max(...meanVals);
  const meanAvg = meanVals.reduce((a, b) => a + b, 0) / meanVals.length;
  // SD estimate: prefer the ±2 SD half-width / 2, fall back to ±1 SD half-width.
  const sdEstimate = has2SD ? (p2sd[0] - m2sd[0]) / 4
                  : has1SD ? (p1sd[0] - m1sd[0]) / 2
                  : 0;
  const padSD  = sdEstimate > 0 ? sdEstimate * 3 : 0;
  const padPct = Math.abs(meanAvg) * 0.10;
  const pad    = Math.max(padSD, padPct);
  const yMin = yLowData  - pad;
  const yMax = yHighData + pad;
  const wOuterHi = (has2SD && has1SD) ? rows.map((_, i) => +(p2sd[i] - p1sd[i]).toFixed(4)) : null;

  const series = [];
  if (baseLow) {
    series.push({ name: '_base', type: 'line', stack: 'band', data: baseLow, symbol: 'none',
      lineStyle: { opacity: 0 }, areaStyle: { opacity: 0 }, silent: true, tooltip: { show: false }, showInLegend: false });
  }
  if (wOuterLo) series.push({ name: '±2 SD', type: 'line', stack: 'band', data: wOuterLo, symbol: 'none',
    lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(190, 149, 255, 0.18)' } });
  if (wInner) series.push({ name: '±1 SD', type: 'line', stack: 'band', data: wInner, symbol: 'none',
    lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(8, 189, 186, 0.22)' } });
  if (wOuterHi) series.push({ name: '±2 SD', type: 'line', stack: 'band', data: wOuterHi, symbol: 'none',
    lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(190, 149, 255, 0.18)' }, showInLegend: false });
  series.push({ name: 'Mean', type: 'line', data: meanVals, symbol: 'circle', symbolSize: 6,
    lineStyle: { color: '#0f62fe', width: 2 }, itemStyle: { color: '#0f62fe' } });

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: { trigger: 'axis', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' } },
    legend: { bottom: 6, textStyle: { color: '#c6c6c6' } },
    grid: { left: 50, right: 20, top: 50, bottom: 40, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', min: yMin, max: yMax, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series,
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
    }

    // column_filled / column_outlined / column_box — per-row vertical
    // column glyphs. Each column draws that row's bands as stacked
    // bars sized to that row's own SD columns. The bar series is
    // category-axis-aware so width / category-gap behave naturally.
    const showBorders = style === 'column_outlined';
    const onlyInnerBand = style === 'column_box';
    return `const Component = ({ data, config }) => {
  if (!data?.rows?.length) return <div style={{ color: '#c6c6c6', padding: 16 }}>Waiting for data…</div>;

  const xCol = ${xColJSON};
  const meanCol = ${meanJSON};
  const m2Col = ${m2JSON}, m1Col = ${m1JSON}, p1Col = ${p1JSON}, p2Col = ${p2JSON};

  const rows = toObjects(data);
  const xLabels  = rows.map(r => formatTimestamp(r[xCol], ${xFmtJSON}));
  const meanVals = rows.map(r => +parseFloat(r[meanCol]));
  const m1sd = m1Col ? rows.map(r => +parseFloat(r[m1Col])) : null;
  const p1sd = p1Col ? rows.map(r => +parseFloat(r[p1Col])) : null;
  const m2sd = m2Col ? rows.map(r => +parseFloat(r[m2Col])) : null;
  const p2sd = p2Col ? rows.map(r => +parseFloat(r[p2Col])) : null;
  const has1SD = m1sd && p1sd;
  const has2SD = m2sd && p2sd;

  // Y-axis bounds — see time_series template comment for rationale.
  const yLowData  = has2SD ? Math.min(...m2sd) : has1SD ? Math.min(...m1sd) : Math.min(...meanVals);
  const yHighData = has2SD ? Math.max(...p2sd) : has1SD ? Math.max(...p1sd) : Math.max(...meanVals);
  const meanAvg = meanVals.reduce((a, b) => a + b, 0) / meanVals.length;
  const sdEstimate = has2SD ? (p2sd[0] - m2sd[0]) / 4
                  : has1SD ? (p1sd[0] - m1sd[0]) / 2
                  : 0;
  const padSD  = sdEstimate > 0 ? sdEstimate * 3 : 0;
  const padPct = Math.abs(meanAvg) * 0.10;
  const pad    = Math.max(padSD, padPct);
  const yMin = yLowData  - pad;
  const yMax = yHighData + pad;

  const series = [];

  ${onlyInnerBand
    ? `// column_box: only the inner ±1 SD band as a stacked bar with stroke,
  // plus a thin vertical reference line spanning each column's height
  // and a tick mark at the mean. The vertical line uses the column gap
  // rather than the panel height.
  if (has1SD) {
    // Transparent base at -1 SD
    series.push({ name: '_base', type: 'bar', stack: 'box', data: m1sd, itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false } });
    // ±1 SD band rectangle
    series.push({ name: '±1 SD', type: 'bar', stack: 'box', data: rows.map((_, i) => +(p1sd[i] - m1sd[i]).toFixed(4)),
      itemStyle: { color: 'rgba(8, 189, 186, 0.22)', borderColor: '#08bdba', borderWidth: 1 } });
  }
  // Mean tick — short horizontal scatter dash on top
  series.push({ name: 'Mean', type: 'scatter', data: meanVals, symbolSize: 14,
    symbol: 'rect', itemStyle: { color: '#f4f4f4' } });`
    : `// column_filled / column_outlined: stacked-bar rectangles per row.
  // Transparent base lifts the stack to the lower bound; widths fill
  // the band regions on top.
  if (has2SD) {
    series.push({ name: '_base', type: 'bar', stack: 'col', data: m2sd, itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false } });
  } else if (has1SD) {
    series.push({ name: '_base', type: 'bar', stack: 'col', data: m1sd, itemStyle: { color: 'transparent' }, silent: true, tooltip: { show: false } });
  }
  if (has2SD && has1SD) {
    series.push({ name: '±2 SD lo', type: 'bar', stack: 'col', data: rows.map((_, i) => +(m1sd[i] - m2sd[i]).toFixed(4)),
      itemStyle: { color: 'rgba(190, 149, 255, 0.18)'${showBorders ? `, borderColor: '#be95ff', borderWidth: 1` : ''} } });
  }
  if (has1SD) {
    series.push({ name: '±1 SD', type: 'bar', stack: 'col', data: rows.map((_, i) => +(p1sd[i] - m1sd[i]).toFixed(4)),
      itemStyle: { color: 'rgba(8, 189, 186, 0.30)'${showBorders ? `, borderColor: '#08bdba', borderWidth: 1` : ''} } });
  }
  if (has2SD && has1SD) {
    series.push({ name: '±2 SD hi', type: 'bar', stack: 'col', data: rows.map((_, i) => +(p2sd[i] - p1sd[i]).toFixed(4)),
      itemStyle: { color: 'rgba(190, 149, 255, 0.18)'${showBorders ? `, borderColor: '#be95ff', borderWidth: 1` : ''} } });
  }
  // Mean dot per row
  series.push({ name: 'Mean', type: 'scatter', data: meanVals, symbolSize: 6, itemStyle: { color: '#0f62fe' } });`}

  const option = {
    backgroundColor: 'transparent',
    title: { text: config?.title || '', left: 'center', top: 5, textStyle: { color: '#f4f4f4' } },
    tooltip: { trigger: 'axis', appendToBody: true, backgroundColor: '#262626', borderColor: '#393939', textStyle: { color: '#f4f4f4' },
      formatter: params => {
        const i = params[0]?.dataIndex;
        if (i == null) return '';
        const lines = ['<b>' + xLabels[i] + '</b>', 'Mean: ' + meanVals[i].toFixed(3)];
        if (has1SD) lines.push('±1 SD: ' + m1sd[i].toFixed(3) + ' / ' + p1sd[i].toFixed(3));
        if (has2SD) lines.push('±2 SD: ' + m2sd[i].toFixed(3) + ' / ' + p2sd[i].toFixed(3));
        return lines.join('<br/>');
      } },
    grid: { left: 50, right: 20, top: 50, bottom: 30, containLabel: true },
    xAxis: { type: 'category', data: xLabels, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } } },
    yAxis: { type: 'value', min: yMin, max: yMax, axisLabel: { color: '#c6c6c6' }, axisLine: { lineStyle: { color: '#525252' } }, splitLine: { lineStyle: { color: '#262626' } } },
    series,
  };
  return <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />;
};`;
  }

  // When using seriesCol, categories are generated inside seriesCode; otherwise generate them here
  const categoriesCode = seriesCol ? '' : `
  const xAxisCol = '${xAxisCol}';
  const xIdx = ${hasTransforms ? 'transformed' : 'data'}.columns.indexOf(xAxisCol);
  const categories = rows.map(r => formatXValue(r[xIdx], xAxisCol));`;

  // Show legend when using series column (multiple series by value) or multiple y columns
  const showLegend = seriesCol || yAxisCols.length > 1;
  // Title is rendered in React (outside ECharts) so it's centered on the
  // full panel width regardless of y-axis label width or legend presence.
  // This keeps line/area/bar titles visually consistent with the dataview
  // and number chart types (which also render their title in React).
  // Legend goes at top of the ECharts canvas; no extra gap needed since
  // the title no longer competes with it.
  const legendTop = 8;
  // Legend entries must match series.name exactly — for the dual-y path we
  // emit a `seriesNames` array (column name, or the user's override if set),
  // so the legend has to read from that same array. Otherwise the legend
  // looks for the raw column names and finds no match, rendering empty.
  const legendCode = showLegend
    ? (seriesCol
        ? `legend: { data: seriesValues.map(String), top: ${legendTop} },`
        : `legend: { data: typeof seriesNames !== 'undefined' ? seriesNames : yColumns, top: ${legendTop} },`)
    : '';
  const titleHeader = chartName
    ? `<div style={{ display: 'block', height: '2.5rem', lineHeight: '2.5rem', flexShrink: 0, padding: '0 0.75rem', fontSize: '1rem', fontWeight: '600', color: 'var(--cds-text-primary)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>${chartName.replace(/'/g, "\\'")}</div>`
    : '';

  // Zoom slider: a draggable range bar under the x-axis + an `inside`
  // zoom so the user can wheel/pinch on the plot too. Slider takes
  // vertical space and the chart uses containLabel:false (grid.bottom
  // is the distance from canvas-bottom to plot-bottom — not including
  // labels), so we need to budget enough space below the plot for
  // BOTH the x-axis labels and the slider stack: ~28px labels +
  // ~10px gap + ~30px slider + ~8px from canvas floor. Pinning the
  // slider with an explicit `bottom: 8` keeps it off the canvas edge
  // and prevents ECharts' auto-position from pushing it under the
  // x-axis labels.
  const showZoomSlider = !!chartOptions.chartShowZoomSlider && ['line', 'area', 'bar'].includes(chartType);
  const gridBottom = showZoomSlider
    ? (showXAxisName ? 95 : 75)
    : (showXAxisName ? 50 : 30);
  const dataZoomCode = showZoomSlider
    ? `
    dataZoom: [
      {
        type: 'slider', show: true, xAxisIndex: [0], start: 70, end: 100,
        bottom: 8, height: 24,
        backgroundColor: '#262626',
        dataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.3 } },
        selectedDataBackground: { lineStyle: { color: '#0f62fe' }, areaStyle: { color: '#0f62fe', opacity: 0.6 } },
        handleStyle: { color: '#0f62fe' },
        textStyle: { color: '#c6c6c6' }
      },
      { type: 'inside', xAxisIndex: [0], start: 70, end: 100 }
    ],`
    : '';

  return `const Component = () => {
  const ${useDataFields} = useData({
    connectionId: '${connectionId}',
    query: {
      raw: \`${queryRaw.replace(/`/g, '\\`')}\`,
      type: '${queryType}',
      params: ${JSON.stringify(queryParams)}
    }${extraOptionsLine}
  });

  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>Loading...</div>;
  if (error) return <div style={{ color: '#da1e28', padding: '1rem' }}>Error: {error.message}</div>;
  ${noDataLine}
${transformsConfig}
${xAxisFormatCode}
${categoriesCode}

  ${seriesCode}

  const option = {
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    ${legendCode}
    grid: { top: ${showLegend ? 35 : 10}, left: ${showSingleYName ? 70 : 50}, right: 20, bottom: ${gridBottom}, containLabel: false },${dataZoomCode}
    xAxis: { type: 'category', data: categories${chartType === 'area' ? ', boundaryGap: false' : ''}${showXAxisName ? `, name: '${xAxisLabel.replace(/'/g, "\\'")}', nameLocation: 'middle', nameGap: 30` : ''} },
    ${yAxisCols.length === 2 ? `yAxis: [
      { type: 'value', axisLabel: { color: '#0f62fe' }, axisLine: { show: true, lineStyle: { color: '#0f62fe' } } },
      { type: 'value', axisLabel: { color: '#8a3ffc' }, axisLine: { show: true, lineStyle: { color: '#8a3ffc' } } }
    ],` : `yAxis: { type: 'value'${showSingleYName ? `, name: '${singleYName.replace(/'/g, "\\'")}', nameLocation: 'middle', nameGap: 40` : ''} },`}
    series: series
  };

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
      ${titleHeader}
      <div style={{ flex: 1, minHeight: 0 }}>
        <ReactECharts option={option} style={{ height: '100%', width: '100%' }} theme="carbon-dark" />
      </div>
    </div>
  );
};`;
}

function getQueryLabelForType(type) {
  switch (type) {
    case 'sql': return 'SQL Query';
    case 'api': return 'Query Parameters (optional)';
    case 'csv': return 'Filter Expression';
    case 'socket': return 'Stream Filter';
    case 'mqtt': return 'MQTT Topic Filter';
    case 'tsstore': return 'TSStore Query';
    case 'prometheus': return 'PromQL Query';
    case 'edgelake': return 'EdgeLake SQL Query';
    default: return 'Query';
  }
}

function getQueryPlaceholderForType(type) {
  switch (type) {
    case 'sql': return 'SELECT timestamp, sensor_id, value FROM sensor_readings ORDER BY timestamp DESC LIMIT 100';
    case 'api': return '?limit=100&format=json';
    case 'csv': return 'sensor_type = temperature';
    case 'socket': return '';
    case 'mqtt': return 'sensors/temperature/# or home/+/status';
    case 'tsstore': return 'newest';
    case 'prometheus': return 'up{job="prometheus"}';
    case 'edgelake': return 'SELECT * FROM sensor_data WHERE timestamp > NOW() - 1 hour LIMIT 100';
    default: return '';
  }
}

export default ComponentEditor;
