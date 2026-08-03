// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useCallback, useImperativeHandle, forwardRef, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  TextInput,
  TextArea,
  Toggle,
  RadioButtonGroup,
  RadioButton,
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
import { Play, Add, TrashCan, Close, Renew, ChartBar, ChartLine, ChartArea, ChartPie, ChartScatter, ChartLineData, Meter, Code, TableSplit, StringInteger, CaretUp, CaretDown, Information } from '@carbon/icons-react';
import DynamicComponentLoader from './DynamicComponentLoader';
import SQLQueryBuilder, { parseSimpleQuery } from './SQLQueryBuilder';
import PrometheusQueryBuilder from './PrometheusQueryBuilder';
import EdgeLakeQueryBuilder from './EdgeLakeQueryBuilder';
import MQTTTopicSelector from './MQTTTopicSelector';
import ControlEditor from './ControlEditor';
import DisplayEditor from './DisplayEditor';
import { transformData, formatCellValue, DASHBOARD_VARIABLE_TOKEN, RANGE_VARIABLE_TOKEN, isTimestampColumn, extractRangeColumn, stripRangePredicate } from '../utils/dataTransforms';
import { deriveVariableColumn } from '../utils/deriveVariableColumn';
import { durationTokenToSeconds, secondsToDurationToken } from '../utils/rangePresets';

// Sliding-window ceiling. The stored value is whole seconds; 30 days is a
// sane upper bound (memory is really governed by the stream buffer size).
const SLIDING_WINDOW_MAX_SECONDS = 30 * 86400; // 2,592,000
import apiClient from '../api/client';
import TagInput from './shared/TagInput';
import { useEnabledTypes } from '../context/EnabledTypesContext';
import { useNamespaces } from '../context/NamespaceContext';
import NamespaceSelect from './shared/NamespaceSelect';
import ConnectionGuidanceHint from './shared/ConnectionGuidanceHint';
import SpecDrivenSections from '../chart-spec/SpecDrivenSections';
import VariableValuePickerModal from './VariableValuePickerModal';
import ConnectionPickerModal from './ConnectionPickerModal';
import CollapsibleTile from './shared/CollapsibleTile';
import { getChartTypeSpec } from '../chart-spec';
import { hasBuildOption as chartHasBuildOption } from '../chart-spec/build-options';
import { getScheme as getBandScheme } from '../chart-spec/specs/band-schemes';
import {
  CLASSIC_GAUGE_STYLE,
  MODERN_GAUGE_STYLE,
  resolveGaugeStyle,
  applyGaugeStyle,
  newGaugeStyleOptions,
} from '../chart-spec/gauge-styles';

// A banded_bar is "configured enough to save" once its scheme's center
// column is mapped (mean / target). Schemes have different center keys,
// so resolve it rather than hardcoding `mean`.
const hasBandCenter = (bandColumns) => {
  if (!bandColumns) return false;
  const centerKey = getBandScheme(bandColumns.scheme).center.key;
  return Boolean(bandColumns[centerKey]);
};

// dataview column_widths: author-set per-column pixel widths. Keep only
// positive numeric entries (a blank/0 input means "auto" — don't persist it),
// and return null when nothing is set so the saved record stays clean.
const pruneColumnWidths = (widths) => {
  if (!widths || typeof widths !== 'object') return null;
  const out = {};
  for (const [col, px] of Object.entries(widths)) {
    const n = Number(px);
    if (Number.isFinite(n) && n > 0) out[col] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
};

// dataview column_rules: per-column conditional-format rules. Drops columns
// whose rule list is empty, and rules that can never fire — no color, or a
// blank operand on an operator that needs one (a half-typed rule the author
// abandoned). resolveColumnRule skips those at render time too; pruning here
// keeps them out of the saved record rather than persisting dead config.
const pruneColumnRules = (rules) => {
  if (!rules || typeof rules !== 'object') return undefined;
  const out = {};
  for (const [col, list] of Object.entries(rules)) {
    if (!Array.isArray(list)) continue;
    const kept = list.filter((r) => {
      if (!r?.color) return false;
      if (r.op === 'empty') return true;
      return r.value != null && String(r.value).trim() !== '';
    });
    if (kept.length > 0) out[col] = kept;
  }
  return Object.keys(out).length > 0 ? out : undefined;
};

// ── ts-store absolute-range (range: DSL) datetime <-> epoch-seconds helpers ──
// The <input type="datetime-local"> value is a local "YYYY-MM-DDTHH:MM" string;
// the ts-store range: DSL takes epoch SECONDS. These convert each way.
const dtLocalToEpochSeconds = (dtLocal) => {
  if (!dtLocal) return null;
  const ms = new Date(dtLocal).getTime();
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
};
const epochSecondsToDtLocal = (epochSec) => {
  const sec = Number(epochSec);
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
// Single-value chart types: they render only row 0. `number` is the
// retired name of `value` — kept in the set so an un-migrated record
// behaves identically while it still carries the old type string.
const SINGLE_VALUE_CHART_TYPES = new Set(['gauge', 'value', 'number']);
// Default ts-store record limit when a saved component has none.
// Single-value charts render only row 0, so 1 record is the right
// default (#169); everything else gets 1000 — matching the
// stream_buffer_size default, and conservative next to the 5000-point
// clamp (TSSTORE_MAX_POINTS) already allowed on time-ranged queries.
const defaultTsstoreLimit = (type) => (SINGLE_VALUE_CHART_TYPES.has(type) ? 1 : 1000);
// Build the range: DSL string from the two datetime-local inputs, or '' if
// either bound is missing/invalid (callers fall back to a safe default).
const buildTsstoreRangeRaw = (fromDtLocal, toDtLocal) => {
  const start = dtLocalToEpochSeconds(fromDtLocal);
  const end = dtLocalToEpochSeconds(toDtLocal);
  if (start == null || end == null) return '';
  return `range:${start}:${end}`;
};
// Assemble the tsstore `raw` DSL string for any query type. Centralizes the
// since / range / newest|oldest shapes so the save + preview sites agree.
// 'range' falls back to 'newest' when either bound is missing (never emit a
// malformed range: — the adapter rejects it). 'latest' (current state per
// series, ts-store v0.19.0 latest_by) is carried in params.latest_by, not the
// raw DSL — its raw is plain 'newest' (latest_by lives on /data/newest).
const buildTsstoreRaw = (queryType, sinceDuration, rangeFrom, rangeTo) => {
  if (queryType === 'since') return `since:${sinceDuration}`;
  if (queryType === 'range') return buildTsstoreRangeRaw(rangeFrom, rangeTo) || 'newest';
  if (queryType === 'latest') return 'newest';
  return queryType; // 'newest' | 'oldest'
};

import './ComponentEditor.scss';

// Chart types available. Array order is the render order in the
// picker modal — all types flow into one grid. Sequence:
// line → area → bar → banded_bar → scatter → pie → gauge → value →
// dataview → custom.
const CHART_TYPES = [
  { id: 'line', label: 'Line Chart', description: 'Show trends over time', icon: ChartLine },
  { id: 'area', label: 'Area Chart', description: 'Line chart with filled area beneath', icon: ChartArea },
  { id: 'bar', label: 'Bar Chart', description: 'Compare values across categories', icon: ChartBar },
  { id: 'banded_bar', label: 'Banded Bar Chart', description: 'Levey-Jennings / control-chart style — time-series with horizontal reference bands', icon: ChartLineData },
  { id: 'scatter', label: 'Scatter Plot', description: 'Plot data points on two axes', icon: ChartScatter },
  { id: 'pie', label: 'Pie Chart', description: 'Show proportions of a whole', icon: ChartPie },
  { id: 'gauge', label: 'Gauge', description: 'Display a single value on a dial', icon: Meter },
  { id: 'value', label: 'Value', description: 'Display a single value — number or text — at a large size with optional unit', icon: StringInteger },
  { id: 'dataview', label: 'Data Table', description: 'Tabular view of raw data', icon: TableSplit },
  { id: 'custom', label: 'Custom Component', description: 'Write custom React/ECharts code', icon: Code },
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

// Dashboard-variable substitution tokens offered as insertable pills when the
// component's "Accepts dashboard-variable substitution" flag is on. Each entry
// is { label, token }. v1 has a single string/filter variable; this is a LIST
// so the future range type (which contributes two tokens — {{range_from}} /
// {{range_to}}) drops in as additional entries with no structural change.
const DASHBOARD_VARIABLE_TOKENS = [
  { label: 'Variable', token: DASHBOARD_VARIABLE_TOKEN },
];

// VariablePills — a row of clickable pills, one per available substitution
// token. Clicking a pill calls onInsert(token); the caller decides where the
// token lands (cursor position in the SQL field, or the whole value of a filter
// row). Rendered only when the substitution flag is on.
function VariablePills({ tokens, onInsert, hint }) {
  if (!tokens || tokens.length === 0) return null;
  return (
    <div className="variable-pills">
      {hint && <span className="variable-pills__hint">{hint}</span>}
      {tokens.map((t) => (
        <Tag
          key={t.token}
          type="purple"
          size="sm"
          onClick={() => onInsert(t.token)}
          title={`Insert ${t.token}`}
          style={{ cursor: 'pointer' }}
        >
          {t.label}
        </Tag>
      ))}
    </div>
  );
}

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
    hasLatestBy: true,
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
    hasLatestBy: true,
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
    hasLatestBy: true,
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
    hasLatestBy: false,
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
    hasLatestBy: true,
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
    // Single-value display. Keep the transforms that meaningfully
    // collapse multiple rows into one (aggregation: "avg of last
    // N rows"; sliding window: "last 5 min of streaming data";
    // filters: "only rows where status=active"). Skip the ones
    // that produce many outputs (time bucket: M buckets → can't
    // render) or that pick rows without affecting the chosen one
    // (sort+limit: row 0 is row 0).
    hasTimeBucket: false,
    hasSortLimit: false,
    hasLatestBy: false,
    xAxisLabel: '',
    yAxisLabel: 'Value Column',
  },
  // "Value" is gauge's visual twin: same data contract (single value from
  // one Y column on the first row), no axes, no X column. Differs only in
  // presentation — a big typographic value instead of a dial — so everything
  // downstream (aggregation, time-bucket, filters) mirrors gauge exactly.
  // Unlike gauge the value may be text rather than a number.
  value: {
    hasXAxis: false,
    hasYAxis: true,
    multipleYAxis: false,
    hasSeriesColumn: false,
    hasAxisLabels: false,
    hasXAxisFormat: false,
    // Same single-value rationale as gauge above.
    hasTimeBucket: false,
    hasSortLimit: false,
    hasLatestBy: false,
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
    hasLatestBy: true,
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
    hasLatestBy: false,
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
    hasLatestBy: false,
    xAxisLabel: 'X-Axis',
    yAxisLabel: 'Y-Axis',
  },
};
// `number` is the retired name of the value type. Records normally
// migrate on server boot, but this lookup is keyed by the raw stored
// chart_type — alias it so one that escaped still opens with the right
// capabilities instead of falling through to CHART_TYPE_CONFIG.custom.
CHART_TYPE_CONFIG.number = CHART_TYPE_CONFIG.value;

// Canonical default chart-options. Single source of truth for the
// chartOptions initial state, the new-chart reset (resetForm), and the
// chart-load merge baseline. IMPORTANT: resets/loads must base on a
// fresh copy of THIS (not the previous chartOptions state) so that
// spec-driven keys absent here (xAxisRange, yAxisRange, sizeColumn,
// tooltip, legend, yThresholds, symbolShape, …) don't bleed from a
// previously-edited chart into the next one on a reused editor instance.
const DEFAULT_CHART_OPTIONS = {
  // Gauge options
  gaugeMin: 0,
  gaugeMax: 100,
  gaugeWarningThreshold: 70,  // Where yellow zone starts (%)
  gaugeDangerThreshold: 90,   // Where red zone starts (%)
  gaugeUnit: '',              // Unit suffix (e.g., '°F', '%')
  gaugeDecimals: 'auto',      // Center-value decimal places ('auto' = up to 2)
  // Value (single-value display) options. valueSize stays unset on
  // create so the editor can lazy-populate it from the admin default;
  // once the user saves/edits it's always a concrete number.
  valueSize: null,
  valueUnit: '',
  valueDecimals: 'auto',     // 'auto' (≤2 places) | '0'..'4' (forced)
  valueFormat: 'auto',       // auto | plain | compact | duration | duration_clock | datetime
  valueDateFormat: 'datetime', // sub-option when valueFormat=datetime
  valueType: 'auto',         // auto (detect from data) | number | text
  valueTextCase: 'none',     // none | upper | lower | capitalize | title (text only)
  valueThresholds: [],       // numeric: [{ value, color, label? }] — highest reached wins
  valueTextThresholds: [],   // text: [{ operator, match, color }] — first match wins
  valueBackground: '',       // tile fill hex; '' = transparent. Text color is
                             // PAIRED from it automatically (contrastPartnerFor),
                             // so there is no companion foreground option.
  // Pie options
  pieInnerRadius: 0,          // 0 = pie, >0 = donut
  pieShowLabels: true,
  // Bar/Line/Area options
  chartStacked: false,
  chartSmooth: true,
  chartShowDataLabels: false,
  chartSiPrefixes: true,      // SI-prefix abbreviation of large values (#159)
  chartShowZoomSlider: false,
  xAxisLabelRotate: 0, // x-axis category label angle (deg): 0 | 30 | 45 | 90
};

/**
 * Connection tag chips that fit-to-width: render every tag, but measure
 * the row and collapse whatever doesn't fit on one line into a "+N…"
 * toggletip. Replaces the old hard cap of 4, which hid tags even when
 * there was plenty of horizontal room.
 *
 * A hidden probe lays out ALL chips with the same flex/gap/wrap rules as
 * the visible row; we read each chip's offsetTop and keep the ones on the
 * first line (same offsetTop as the first chip). Re-measures on resize.
 *
 * @param {string[]} tags  ordered, deduped chips (type tag first).
 */
function ConnectionTagsRow({ tags }) {
  const containerRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;

    const measure = () => {
      const probe = el.querySelector('.connection-tags-probe');
      if (!probe) return;
      const chipEls = Array.from(probe.querySelectorAll('[data-tag-chip]'));
      if (chipEls.length === 0) { setVisibleCount(0); return; }
      const firstTop = chipEls[0].offsetTop;
      let fit = 0;
      for (let i = 0; i < chipEls.length; i++) {
        if (chipEls[i].offsetTop > firstTop) break;
        fit++;
      }
      setVisibleCount(Math.max(1, fit));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tags]);

  const visible = tags.slice(0, visibleCount);
  const overflow = tags.slice(visibleCount);

  return (
    <div className="connection-tags-row" ref={containerRef}>
      {/* Hidden probe: all chips, used purely for measurement. */}
      <div className="connection-tags-probe" aria-hidden="true">
        {tags.map((tag, i) => (
          <Tag key={`probe-${tag}-${i}`} type={i === 0 ? 'blue' : 'gray'} size="sm" data-tag-chip="">
            {tag}
          </Tag>
        ))}
      </div>
      {visible.map((tag, i) => (
        <Tag key={`${tag}-${i}`} type={i === 0 ? 'blue' : 'gray'} size="sm">
          {tag}
        </Tag>
      ))}
      {overflow.length > 0 && (
        <Toggletip align="bottom">
          <ToggletipButton label={`Show ${overflow.length} more tag${overflow.length === 1 ? '' : 's'}`}>
            <span className="connection-tags-overflow">+{overflow.length}…</span>
          </ToggletipButton>
          <ToggletipContent>
            <p>{tags.join(', ')}</p>
          </ToggletipContent>
        </Toggletip>
      )}
    </div>
  );
}

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
  onDirtyChange,
  // Reports whether ANY nested modal (connection picker, chart-type, value
  // pickers) is open, so a parent modal can release its focus trap — otherwise
  // the parent's trap fights the nested modal (Search rejects keystrokes, the
  // tag dropdown opens-then-closes).
  onNestedModalChange,
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
  // Default chart type for new charts. Line is the most-used type
  // for time-series dashboards (most data on this platform is
  // time-stamped, and bar/area are special-case picks rather than
  // the default).
  const [chartType, setChartType] = useState('line');
  const [chartTypeModalOpen, setChartTypeModalOpen] = useState(false);
  const [connectionPickerOpen, setConnectionPickerOpen] = useState(false);

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
  // query_config.params as loaded from the stored component, for connection
  // types the editor has no dedicated params UI for (synology, and any future
  // adapter whose params carry required dispatch fields).
  //
  // The save path builds params per known type (tsstore / prometheus /
  // edgelake) and previously fell through to `{}` for everything else — which
  // silently DESTROYED the stored params on any save. That is invisible for
  // sql (params is already {}) and harmless for tsstore (limit is re-derived
  // from the UI), but fatal for Synology, where params carries method /
  // version / result_path / additional: the next query goes out bare and DSM
  // rejects it with error 120. Round-tripping the loaded value preserves it
  // until a type gets a real editor surface.
  const [passthroughQueryParams, setPassthroughQueryParams] = useState(null);

  // Query surfaces declared by connection adapters, keyed by the legacy short
  // connection type ('synology'), from GET /api/registry/connections.
  //
  // An adapter is the only place that knows what a valid query for it looks
  // like, so it declares that surface next to its own registration and the
  // editor renders whatever it gets. That's how a type whose params carry
  // required dispatch fields becomes authorable from scratch without this file
  // growing another hardcoded per-type branch. Types that declare nothing are
  // absent from this map and keep the plain raw box.
  const [querySurfaces, setQuerySurfaces] = useState({});
  // The catalog preset the user picked, for kind === 'catalog' surfaces. Holds
  // the whole preset (not just an id) so its params travel with it into the
  // preview / save / live-preview paths.
  const [selectedQueryPreset, setSelectedQueryPreset] = useState(null);
  // A loaded component's stored {raw, params}, waiting to be matched against a
  // catalog preset. Held rather than resolved inline because the surfaces load
  // async — a component can finish loading before its type's surface arrives.
  const [pendingPresetMatch, setPendingPresetMatch] = useState(null);
  // Ref to the raw-query TextArea so a variable pill can insert its token at the
  // cursor position rather than only appending.
  const queryRawRef = useRef(null);

  // Preview value for the dashboard-variable token. The editor has no dashboard
  // context to supply the runtime value, so when the query/filter uses the
  // {{dashboard-variable}} token the author types a sample value here; it is
  // sent as query.params.dashboard_variable for the preview fetch (and the live
  // preview render) so the query resolves instead of failing "variable not set".
  const [previewVariableValue, setPreviewVariableValue] = useState('');
  const [valuePickerOpen, setValuePickerOpen] = useState(false);
  // Client-side-filter value discovery: when a client-side filter is bound to
  // the dashboard variable, there's no engine-side DISTINCT — we capture
  // records (the normal Fetch), unique the bound column in the browser, and
  // open the picker in CLIENT mode with that list. Separate state from the
  // server picker above (which handles SQL/EdgeLake).
  const [clientValuePickerOpen, setClientValuePickerOpen] = useState(false);
  const [clientDiscoveredValues, setClientDiscoveredValues] = useState([]);
  const [clientDiscoveredColumn, setClientDiscoveredColumn] = useState('');
  const [clientDiscoveredPartial, setClientDiscoveredPartial] = useState(false);
  // True while a RAW socket/mqtt value-discovery capture is streaming live into
  // the picker (the modal shows values accumulating + a Stop button). tsstore/
  // API harvest from a one-shot fetch and never set this.
  const [clientCapturing, setClientCapturing] = useState(false);
  // Total stream records seen during a live capture (every message, not just new
  // distinct values) — shown in the picker so the stream's liveness is visible.
  const [clientRecordCount, setClientRecordCount] = useState(0);
  const clientCaptureRef = useRef(null); // EventSource for the live discovery capture

  // Insert a substitution token into the raw query at the current cursor
  // position (falls back to appending). Keeps focus + caret after the inserted
  // token so the author can keep typing.
  const insertTokenIntoQuery = useCallback((token) => {
    const el = queryRawRef.current?.input || queryRawRef.current?.textarea || queryRawRef.current;
    setQueryRaw((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      const next = prev.slice(0, start) + token + prev.slice(end);
      // Restore caret just after the inserted token on the next tick.
      requestAnimationFrame(() => {
        if (el && typeof el.setSelectionRange === 'function') {
          const pos = start + token.length;
          el.focus();
          el.setSelectionRange(pos, pos);
        }
      });
      return next;
    });
  }, []);

  // Best-effort derivation of the column/table the dashboard variable filters
  // on, for the value-picker. Shared with the dashboard runtime discovery so
  // both behave identically. Ambiguity → empty (picker asks the user to choose).
  const derivedVariableColumn = useMemo(() => deriveVariableColumn(queryRaw), [queryRaw]);

  // Data mapping
  const [xAxisColumn, setXAxisColumn] = useState('');
  const [xAxisLabel, setXAxisLabel] = useState(''); // Custom label for X axis
  const [xAxisFormat, setXAxisFormat] = useState('auto'); // Default timestamp format; 'auto' fits granularity to the data
  const [yAxisColumns, setYAxisColumns] = useState([]);
  const [yAxisLabel, setYAxisLabel] = useState(''); // AXIS label rendered along the Y axis (single-axis mode; scatter + line/bar/area). Dual-axis charts render no axis labels — the legend + axis colors identify sides.
  const [yAxisLabels, setYAxisLabels] = useState([]); // Per-SERIES labels (legend names). Index matches yAxisColumns. Empty entries fall back to column name.
  // Per-column series color overrides (resolved hex; '' = auto palette). Index
  // matches yAxisColumns, same parallel-array pattern as yAxisLabels. Saved into
  // the object-form y_axis entries' `color` field.
  const [yAxisColors, setYAxisColors] = useState([]);
  const [groupByColumn, setGroupByColumn] = useState('');
  const [seriesColumn, setSeriesColumn] = useState(''); // Column that identifies each series (e.g., location) - used for time bucket partitioning

  // Accumulator/delta transform (#8). PER-COLUMN: a parallel boolean array
  // index-aligned to yAxisColumns (like yAxisColors). A true entry plots that
  // line/area column's delta from the previous point (for monotonic counters).
  // reset_policy (chart-wide) governs counter resets (delta < 0).
  const [yAxisAccumulate, setYAxisAccumulate] = useState([]);
  const [accumulatorResetPolicy, setAccumulatorResetPolicy] = useState('drop_negative');

  // Filters and aggregation
  const [filters, setFilters] = useState([]);

  // The client-side filter (if any) bound to the dashboard variable — its value
  // is exactly the token. Its `field` is the column whose distinct values feed
  // the picker. Null when no filter is variable-bound. (Declared after `filters`
  // to avoid a TDZ on it.)
  const variableBoundFilter = useMemo(
    () => filters.find((f) => typeof f?.value === 'string' && f.value.trim() === DASHBOARD_VARIABLE_TOKEN) || null,
    [filters],
  );

  // Harvest the distinct values of `column` from a captured preview result set
  // ({columns, rows}), in row order, de-duplicated, dropping null/empty. Used
  // for client-side-filter value discovery (no engine-side DISTINCT). `cap`
  // bounds the scan; the caller marks the list partial when the source was
  // itself capped/stopped.
  const harvestColumnValues = useCallback((resultSet, column, cap = 1000) => {
    if (!resultSet || !column) return [];
    const cols = resultSet.columns || [];
    const idx = cols.indexOf(column);
    if (idx < 0) return [];
    const seen = new Set();
    const out = [];
    const rows = resultSet.rows || [];
    for (let i = 0; i < rows.length && out.length < cap; i++) {
      const v = rows[i]?.[idx];
      if (v == null) continue;
      const s = String(v);
      if (s === '' || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  }, []);

  // After a capture, if a client-side filter is bound to the variable and no
  // preview value is chosen yet, harvest the bound column's distinct values and
  // open the client-mode picker. No-op otherwise.
  const maybeOpenClientValuePicker = useCallback((resultSet, { partial = false } = {}) => {
    if (!variableBoundFilter || previewVariableValue) return false;
    const column = variableBoundFilter.field;
    const values = harvestColumnValues(resultSet, column);
    setClientDiscoveredColumn(column);
    setClientDiscoveredValues(values);
    setClientDiscoveredPartial(partial);
    setClientValuePickerOpen(true);
    return true;
  }, [variableBoundFilter, previewVariableValue, harvestColumnValues]);


  const [aggregation, setAggregation] = useState({ type: '', sortBy: '', field: '', count: 10 });
  const [sortBy, setSortBy] = useState('');
  const [sortOrder, setSortOrder] = useState('desc');
  const [limitRows, setLimitRows] = useState(0);
  const [columnAliases, setColumnAliases] = useState({}); // For dataview: column name -> display name
  // For dataview: author-set per-column pixel widths (column name -> px).
  // Absent/0 = auto-size to content. These are the chart DEFAULT; a user's
  // live drag-resize (per-user, useDataviewLayout) still overrides them.
  const [columnWidths, setColumnWidths] = useState({});
  // For dataview: author-set per-column value formats (column name ->
  // 'compact' | 'duration' | 'duration_clock' | 'plain'). Absent = auto.
  const [columnFormats, setColumnFormats] = useState({});
  // For dataview: per-column conditional-formatting rules (column name ->
  // [{ op, value, color, target, wholeRow }]). First match wins. Absent =
  // no conditional styling for that column.
  const [columnRules, setColumnRules] = useState({});
  // For dataview: which columns to render as table columns. Stored as an
  // explicit whitelist — null/empty means "show all" (default, back-compat).
  // When non-null, the table filters data.columns through this list.
  const [visibleColumns, setVisibleColumns] = useState(null);

  // Sliding window for time-series data
  const [slidingWindowEnabled, setSlidingWindowEnabled] = useState(false);
  const [slidingWindowDuration, setSlidingWindowDuration] = useState(300); // Default 5 minutes (stored as whole seconds)
  // Editable text for the window field — accepts duration tokens (7d, 90m,
  // 45s, 1w) OR bare seconds. Kept separate from slidingWindowDuration so
  // the user can type freely; on a valid parse we update the seconds state.
  const [slidingWindowText, setSlidingWindowText] = useState('5m');
  const [slidingWindowError, setSlidingWindowError] = useState('');
  const [slidingWindowTimestampCol, setSlidingWindowTimestampCol] = useState('');

  // Latest-by ("current state per series"): keep only the newest row per
  // distinct value of a key column. Client-side twin of ts-store's server-side
  // latest_by param — the only option for a streaming component, which can't
  // push the reduction down to the source. Multi-series views only (see the
  // has_latest_by capability); single-value views use a filter instead.
  // The timestamp column is optional — blank means last-arrived wins.
  const [latestByEnabled, setLatestByEnabled] = useState(false);
  const [latestByKeyCol, setLatestByKeyCol] = useState('');
  const [latestByTimestampCol, setLatestByTimestampCol] = useState('');

  // Banded-bar column mapping — only used when chart_type === 'banded_bar'.
  // The chart is per-row only: each row carries its own mean + SD columns
  // and the renderer draws a per-row envelope. This object maps each
  // band role to a row-column name.
  // band_columns: { scheme, ...per-scheme column mappings }. Default to
  // the ±SD scheme. The BandScheme field type owns the per-scheme fields.
  const [bandColumns, setBandColumns] = useState({ scheme: 'sd' });
  const [bandedBarStyle, setBandedBarStyle] = useState('time_series');

  // Time bucket aggregation for streaming data (socket datasources only)
  const [timeBucketEnabled, setTimeBucketEnabled] = useState(false);
  const [timeBucketInterval, setTimeBucketInterval] = useState(60); // Default 1 minute
  const [timeBucketFunction, setTimeBucketFunction] = useState('avg');
  const [timeBucketValueCols, setTimeBucketValueCols] = useState([]);
  const [timeBucketTimestampCol, setTimeBucketTimestampCol] = useState('');

  // TSStore query configuration
  const [tsstoreQueryType, setTsstoreQueryType] = useState('since'); // since, newest, oldest, range, latest
  const [tsstoreLimit, setTsstoreLimit] = useState(defaultTsstoreLimit('line'));
  // 'latest' query type (ts-store v0.19.0 latest_by): the field whose distinct
  // values define the series — one row per value, each its newest record.
  const [tsstoreLatestBy, setTsstoreLatestBy] = useState('');
  const [tsstoreSinceDuration, setTsstoreSinceDuration] = useState('1h'); // e.g., "30m", "2h", "7d"
  // Absolute from→to window for tsstoreQueryType==='range'. Stored as
  // datetime-local strings ("YYYY-MM-DDTHH:MM", local time); converted to epoch
  // SECONDS on save (the ts-store adapter's range: DSL convention — fetchRange
  // scales seconds→ns server-side) and parsed back from the saved epochs on load.
  const [tsstoreRangeFrom, setTsstoreRangeFrom] = useState('');
  const [tsstoreRangeTo, setTsstoreRangeTo] = useState('');

  // Prometheus query configuration. The source of truth for query_config.params
  // on a Prometheus component. 'instant' = a single snapshot (current value per
  // series — gauges, number tiles, "current value per label" bars). 'range' = a
  // time series; only then do start/step matter. Previously the editor dropped
  // these (raw mode had no control; visual mode's onParamsChange was a stub), so
  // params saved {} and the adapter defaulted to range — wrong for instant charts.
  const [promQueryType, setPromQueryType] = useState('range'); // 'instant' | 'range'
  const [promTimeRange, setPromTimeRange] = useState('1h');     // range window (start = now-<this>)
  const [promStep, setPromStep] = useState('1m');               // range resolution step
  // TSStore source-side filter. ts-store's `filter` is a plain SUBSTRING match
  // over the whole record (NOT field-scoped) — but the data sets this targets
  // have very few label fields, so a general substring is fine in practice.
  // Filtering at the source (ts-store counts MATCHES, not candidates) is what
  // lets a variable-filtered streaming/limit query return full per-value
  // history instead of the sparse client-thinned result (#18).
  const [tsstoreFilter, setTsstoreFilter] = useState('');               // literal substring
  const [tsstoreFilterSource, setTsstoreFilterSource] = useState('literal'); // 'literal' | 'variable'
  const [tsstoreFilterIgnoreCase, setTsstoreFilterIgnoreCase] = useState(false);

  // Build the ts-store source-side filter params for a query_config. Returns
  // {} when no filter is set. In 'variable' mode the literal
  // {{dashboard-variable}} token is stored; the server resolves it to the
  // active value at query time (see resolveFilterParam in the Go adapter).
  // Single source of truth for the four sites that assemble tsstore params
  // (preview, codegen, save, custom-code preview) + the backfill.
  const buildTsstoreFilterParams = useCallback(() => {
    const value = tsstoreFilterSource === 'variable'
      ? DASHBOARD_VARIABLE_TOKEN
      : (tsstoreFilter || '').trim();
    if (!value) return {};
    const params = { filter: value };
    if (tsstoreFilterIgnoreCase) params.filter_ignore_case = true;
    return params;
  }, [tsstoreFilter, tsstoreFilterSource, tsstoreFilterIgnoreCase]);

  // True when the tsstore filter is bound to the dashboard variable — used to
  // mark uses_dashboard_variable and to gate the #18 backfill substitution.
  const tsstoreFilterUsesVariable = tsstoreFilterSource === 'variable';

  // Params for the 'latest' query type (ts-store v0.19.0 latest_by): the
  // newest record per distinct value of a field — "current state per series".
  // {} when the type isn't 'latest' or the field is blank (the query then
  // degrades to a plain newest, mirroring the half-filled-range fallback).
  // Single source of truth for the sites that assemble tsstore params.
  const buildTsstoreLatestByParams = useCallback(() => {
    const field = (tsstoreLatestBy || '').trim();
    return tsstoreQueryType === 'latest' && field ? { latest_by: field } : {};
  }, [tsstoreQueryType, tsstoreLatestBy]);

  // Assemble query_config.params for a Prometheus component. 'instant' carries
  // only query_type (start/end/step are meaningless for a snapshot); 'range'
  // adds the window + step. Single source of truth for the save + preview paths.
  const buildPrometheusParams = useCallback(() => {
    if (promQueryType === 'instant') {
      return { query_type: 'instant' };
    }
    return { query_type: 'range', start: `now-${promTimeRange}`, end: 'now', step: promStep };
  }, [promQueryType, promTimeRange, promStep]);

  // Assemble query_config.params for a connection type that declared a query
  // surface, falling back to the stored params when nothing is selected.
  //
  // Single source of truth for the preview, save, and live-preview paths. Those
  // three had already drifted once — the live preview kept sending `{}` where
  // the other two had learned to preserve stored params — which is exactly the
  // bug class this consolidates away.
  const buildSurfaceParams = useCallback(() => {
    if (selectedQueryPreset?.params) {
      return { ...selectedQueryPreset.params };
    }
    // No preset selected: either the type declares no surface, or this is a
    // component authored before the catalog. Either way the stored params are
    // the only correct thing to send — dropping to {} sends the query bare,
    // which for Synology means DSM error 120.
    return passthroughQueryParams ? { ...passthroughQueryParams } : {};
  }, [selectedQueryPreset, passthroughQueryParams]);

  // EdgeLake query configuration (for raw mode database param)
  const [edgelakeDatabase, setEdgelakeDatabase] = useState('');
  // Database list for the Raw-mode picker. Populated lazily when
  // the user lands on an EdgeLake connection so we don't query
  // every connection at editor mount.
  const [edgelakeDatabasesList, setEdgelakeDatabasesList] = useState([]);
  const [edgelakeDatabasesLoading, setEdgelakeDatabasesLoading] = useState(false);

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
  // Alphabetically-sorted OPTION LIST for the data-mapping dropdowns
  // (x/y/series/group-by/filter/time-bucket/sliding-window). The raw
  // availableColumns keeps its query/fetch order (used only as a default
  // seed, e.g. filters default to [0]); the dropdowns render this sorted
  // copy so the option lists aren't in an arbitrary column order.
  //
  // Saved selections are UNIONED IN so a dropdown still shows the value the
  // author previously chose before any Fetch Data has run. This is the local
  // replacement for the old global availableColumns seed (removed — see the
  // note in the chart-load effect): the option list may include a saved
  // column that isn't in the current schema, but availableColumns itself
  // stays strictly "the real schema", so surfaces that enumerate the schema
  // — notably the dataview column list — are never shown a subset that
  // looks complete.
  //
  // A saved column that no longer exists in the fetched schema is still
  // listed, deliberately: silently dropping it would make the author's
  // selection vanish with no explanation. pruneStaleColumnSelections (in the
  // fetch handler) is what actually clears genuinely-stale selections.
  const sortedColumns = useMemo(() => {
    const opts = new Set(availableColumns);
    const addSaved = (c) => { if (typeof c === 'string' && c) opts.add(c); };
    addSaved(xAxisColumn);
    yAxisColumns.forEach((y) => addSaved(typeof y === 'object' && y ? y.column : y));
    addSaved(groupByColumn);
    addSaved(seriesColumn);
    addSaved(slidingWindowTimestampCol);
    addSaved(timeBucketTimestampCol);
    addSaved(latestByKeyCol);
    addSaved(latestByTimestampCol);
    filters.forEach((f) => addSaved(f?.field ?? f?.column));
    return [...opts].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [
    availableColumns, xAxisColumn, yAxisColumns, groupByColumn, seriesColumn,
    slidingWindowTimestampCol, timeBucketTimestampCol, latestByKeyCol,
    latestByTimestampCol, filters,
  ]);
  // The single query-results table lives at the bottom of the Data Mapping tab
  // (it's filter-aware). It's easy to miss after running a query, so we scroll
  // to it when a NEW run lands. Keyed on previewData (a fresh fetch), NOT on the
  // filtered memo — otherwise editing filters would yank the page each keystroke.
  const previewRef = useRef(null);
  useEffect(() => {
    if (previewData && previewRef.current) {
      previewRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [previewData]);

  // Code editor
  const [componentCode, setComponentCode] = useState('');
  const [showCustomCode, setShowCustomCode] = useState(false);

  // Dashboard-variable opt-in. When true, a dashboard's variable can override
  // this component's connection (connection-swap) at view time. Gated in the
  // UI by the global dashboard_variable.enabled admin setting.
  const [usesDashboardVariable, setUsesDashboardVariable] = useState(false);
  const [dashboardVariableEnabled, setDashboardVariableEnabled] = useState(false);
  useEffect(() => {
    apiClient.getSetting('dashboard_variable.enabled')
      .then((s) => setDashboardVariableEnabled((s?.value ?? s) !== false))
      .catch(() => setDashboardVariableEnabled(false));
  }, []);

  // Chart-specific options (gauge thresholds, pie radius, etc.).
  // Initialized from the module-scope DEFAULT_CHART_OPTIONS via a fresh
  // copy so per-instance edits never mutate the shared default, and so
  // reset/load can rebase on the same source of truth.
  const [chartOptions, setChartOptions] = useState(() => ({ ...DEFAULT_CHART_OPTIONS }));

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
      setXAxisFormat('auto'); // auto adapts the timestamp granularity to the data span
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
        setYAxisColors([]);
    }

    // Clear time bucket if not applicable
    if (!newConfig.hasTimeBucket) {
      setTimeBucketEnabled(false);
    }

    // Clear latest-by if not applicable. Single-value views (value/gauge) and
    // per-row views (banded_bar) express "current state" with a filter instead,
    // so switching to one must not leave a stale reduction configured.
    if (!newConfig.hasLatestBy) {
      setLatestByEnabled(false);
      setLatestByKeyCol('');
      setLatestByTimestampCol('');
    }

    // Clear sort/limit if not applicable
    if (!newConfig.hasSortLimit) {
      setSortBy('');
      setSortOrder('desc');
      setLimitRows(0);
    }

    // Single-value charts (gauge, value) render only row 0, so a
    // newest/oldest ts-store query needs just 1 record (#169). Swap the
    // record-limit default when the type crosses the single-value
    // boundary — but only when it still sits at the old type's default,
    // so an explicitly-entered limit survives the switch.
    const isSingleValue = SINGLE_VALUE_CHART_TYPES.has(newType);
    const wasSingleValue = SINGLE_VALUE_CHART_TYPES.has(chartType);
    // 100 was the pre-#169 default — components saved back then carry it
    // explicitly, so treat it as "still at a default" too.
    const atDefault = tsstoreLimit === defaultTsstoreLimit(chartType) || (!wasSingleValue && tsstoreLimit === 100);
    if (isSingleValue !== wasSingleValue && atDefault) {
      setTsstoreLimit(defaultTsstoreLimit(newType));
    }

    // Seed the Modern gauge style when a NEW chart becomes a gauge.
    //
    // This is the "new charts get the new look" half of the two-defaults
    // rule (see chart-spec/gauge-styles.js). It deliberately lives here
    // and NOT in DEFAULT_CHART_OPTIONS, because that object is merged
    // over every chart on load — putting the Modern values there would
    // restyle every already-saved gauge the moment it was opened.
    //
    // Guarded on `!chart?.id` so switching types while editing an
    // EXISTING component never rewrites its appearance, and on the keys
    // being absent so toggling gauge→bar→gauge in one session doesn't
    // discard tuning the author just did.
    if (newType === 'gauge' && !chart?.id) {
      setChartOptions((prev) => (
        prev.gaugeStyle === undefined ? { ...prev, ...newGaugeStyleOptions() } : prev
      ));
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
    fetchQuerySurfaces();
  }, []);

  // Resolve a loaded component's stored query back to the catalog preset it
  // came from, once BOTH the surfaces and the connection are known. Runs on
  // either arriving, since their order isn't guaranteed.
  //
  // No match (a pre-catalog component, or an API outside the catalog) leaves
  // the preset unset on purpose: buildSurfaceParams then falls through to the
  // stored params, so the component keeps running exactly as saved.
  // Looks the surface up from state rather than closing over the derived
  // activeQuerySurface — that const is declared far below this effect, and
  // referencing it here is a temporal-dead-zone crash that blanks the editor.
  useEffect(() => {
    if (!pendingPresetMatch) return;
    const connType = connections.find((c) => c.id === selectedConnectionId)?.type;
    const surface = connType ? querySurfaces[connType] : null;
    if (!surface) return;
    const match = findMatchingPreset(surface, pendingPresetMatch.raw, pendingPresetMatch.params);
    if (match) setSelectedQueryPreset(match);
    setPendingPresetMatch(null);
  }, [pendingPresetMatch, querySurfaces, connections, selectedConnectionId]);

  // Pull the admin default for value-chart value size so new charts
  // render at the deployment's preferred size instead of a hard-coded
  // constant. Only applies when valueSize is still null (i.e. unsaved).
  useEffect(() => {
    if (chartOptions.valueSize != null) return;
    let cancelled = false;
    apiClient.getSetting('default_value_chart_size')
      .then((s) => {
        if (cancelled) return;
        const n = Number(s?.value);
        if (Number.isFinite(n) && n > 0) {
          setChartOptions((prev) => prev.valueSize == null ? { ...prev, valueSize: n } : prev);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [chartOptions.valueSize]);

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
      setPassthroughQueryParams(chart.query_config?.params || null);
      // Re-select the catalog preset this component was authored from, so the
      // picker shows the right entry instead of reading as unset. Resolved in
      // an effect rather than here because the surfaces are fetched async and
      // may not have arrived yet when a component loads.
      setPendingPresetMatch({
        raw: chart.query_config?.raw || '',
        params: chart.query_config?.params || null,
      });
      setXAxisColumn(chart.data_mapping?.x_axis || '');
      setXAxisLabel(chart.data_mapping?.x_axis_label || '');
      setXAxisFormat(chart.data_mapping?.x_axis_format || 'auto'); // pre-'auto' charts w/o a stored format now adapt to span
      // y_axis may be the new object form ({column,label,stack,axis,color}[]) or
      // the legacy string array. Extract the column strings for the (string-typed)
      // yAxisColumns state, and harvest per-column color + label from objects.
      const loadedYAxis = chart.data_mapping?.y_axis || [];
      const loadedYCols = loadedYAxis.map((e) => (typeof e === 'string' ? e : (e?.column || '')));
      // Per-column colors: prefer the parallel y_axis_colors array; fall back to
      // inline entry.color if a record was ever saved in object form.
      const rawYColors = chart.data_mapping?.y_axis_colors;
      const loadedYColors = loadedYCols.map((_c, i) => {
        if (Array.isArray(rawYColors) && typeof rawYColors[i] === 'string') return rawYColors[i];
        const e = loadedYAxis[i];
        return (typeof e === 'object' && typeof e?.color === 'string') ? e.color : '';
      });
      setYAxisColumns(loadedYCols);
      setYAxisColors(loadedYColors);
      setYAxisLabel(chart.data_mapping?.y_axis_label || '');
      // Series labels live in y_axis_labels (the per-series source of
      // truth). The legacy fallback that seeded them from the singular
      // y_axis_label is gone — that field is now the AXIS label
      // (rendered along the axis, matching scatter's semantics); the
      // strip_y_axis_label_mirror migration removed the old save-path
      // mirrors. (Same computation as loadedYAxisLabels used for the
      // dirty-tracking snapshot, so load doesn't read dirty.)
      const loadedLabels = chart.data_mapping?.y_axis_labels;
      setYAxisLabels(Array.isArray(loadedLabels) && loadedLabels.length > 0 ? loadedLabels : []);
      setGroupByColumn(chart.data_mapping?.group_by || '');
      setSeriesColumn(chart.data_mapping?.series || '');
      // Per-column accumulator (#8). Prefer the parallel accumulator_columns
      // array; fall back to the legacy chart-wide accumulator_mode:true (= all
      // columns). Index-aligned to the loaded y columns.
      const rawAccum = chart.data_mapping?.accumulator_columns;
      const legacyAccumAll = chart.data_mapping?.accumulator_mode === true;
      setYAxisAccumulate(loadedYCols.map((_c, i) => (
        Array.isArray(rawAccum) ? rawAccum[i] === true : legacyAccumAll
      )));
      setAccumulatorResetPolicy(chart.data_mapping?.accumulator_reset_policy || 'drop_negative');
      setFilters(chart.data_mapping?.filters || []);
      setAggregation(chart.data_mapping?.aggregation || { type: '', sortBy: '', field: '', count: 10 });
      setSortBy(chart.data_mapping?.sort_by || '');
      setSortOrder(chart.data_mapping?.sort_order || 'desc');
      setLimitRows(chart.data_mapping?.limit || 0);
      setColumnAliases(chart.data_mapping?.column_aliases || {});
      setColumnWidths(chart.data_mapping?.column_widths || {});
      setColumnFormats(chart.data_mapping?.column_formats || {});
      setColumnRules(chart.data_mapping?.column_rules || {});
      // Visible columns: null means "show all" (default). Only populated when
      // the admin has actively hidden some.
      const loadedVisible = chart.data_mapping?.visible_columns;
      setVisibleColumns(Array.isArray(loadedVisible) && loadedVisible.length > 0 ? loadedVisible : null);

      // NOTE: availableColumns is deliberately NOT seeded from the saved
      // column references here. It means exactly one thing — THE REAL SCHEMA
      // FROM THE LAST FETCH — and nothing else.
      //
      // It used to be seeded so the x/y/series dropdowns would render their
      // saved values without a Fetch Data first. But a seed built from saved
      // references is a subset masquerading as the schema, and the dataview
      // column list reads it as the full set: on open the author saw ONLY the
      // already-ticked columns, with no row for the unticked ones, so a column
      // that wasn't already added could not be discovered or added at all
      // (10-column result set → 3 rows, 0 unticked). The seed also bought less
      // than it looked: it rendered the current selection but left every
      // dropdown functionally inert, since the other columns still weren't
      // options until a fetch.
      //
      // The narrow case the seed did solve — "render a saved value that isn't
      // in the option list" — is handled locally instead, by unioning saved
      // selections into the OPTION lists (columnsWithSaved / sortedColumns
      // below). Same pattern the sliding-window timestamp select already used.
      // Sliding window initialization
      const sw = chart.data_mapping?.sliding_window;
      setSlidingWindowEnabled(sw?.duration > 0 && !!sw?.timestamp_col);
      setSlidingWindowDuration(sw?.duration || 300);
      setSlidingWindowText(secondsToDurationToken(sw?.duration || 300) || '5m');
      setSlidingWindowError('');
      setSlidingWindowTimestampCol(sw?.timestamp_col || '');
      // Latest-by initialization. The key column alone marks it enabled — the
      // timestamp column is optional (blank = last-arrived wins).
      const lb = chart.data_mapping?.latest_by;
      setLatestByEnabled(!!lb?.key_col);
      setLatestByKeyCol(lb?.key_col || '');
      setLatestByTimestampCol(lb?.timestamp_col || '');
      // Banded-bar column mapping. Empty defaults — the user picks
      // columns from the schema dropdown. Migrating an old chart that
      // still has reference_levels: keep it loaded so the chart keeps
      // rendering; the new editor section just shows empty pickers,
      // which is a clean prompt to re-pick.
      // band_columns now carries a `scheme` id plus that scheme's column
      // mappings. Old ±SD records have no `scheme` key — default to 'sd'
      // so they keep rendering as before.
      const savedBandCols = chart.data_mapping?.band_columns;
      if (savedBandCols && typeof savedBandCols === 'object') {
        setBandColumns({ scheme: 'sd', ...savedBandCols });
      } else {
        setBandColumns({ scheme: 'sd' });
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
      // Restore the record limit for every raw shape (not just the
      // branches that show the input) so live state always matches the
      // dirty-tracking baseline's loadedTsstoreLimit — the fallback is
      // chart-type-aware (1 for single-value gauge/number, #169), so an
      // untouched useState default would read as a phantom change.
      setTsstoreLimit(chart.query_config?.params?.limit || defaultTsstoreLimit(chart.chart_type));
      // A latest_by param marks the 'latest' query type (current state per
      // series) regardless of raw shape — its raw is a documentary 'newest'.
      const savedLatestBy = chart.query_config?.params?.latest_by;
      if (typeof savedLatestBy === 'string' && savedLatestBy.trim() !== '') {
        setTsstoreQueryType('latest');
        setTsstoreLatestBy(savedLatestBy);
      } else if (rawQuery.startsWith('since:')) {
        setTsstoreQueryType('since');
        setTsstoreSinceDuration(rawQuery.substring(6));
      } else if (rawQuery.startsWith('range:')) {
        // range:<startEpochSec>:<endEpochSec> → restore the two datetime pickers.
        setTsstoreQueryType('range');
        const m = rawQuery.match(/^range:(\d+):(\d+)$/);
        if (m) {
          setTsstoreRangeFrom(epochSecondsToDtLocal(m[1]));
          setTsstoreRangeTo(epochSecondsToDtLocal(m[2]));
        }
      } else if (rawQuery === 'newest' || rawQuery === 'oldest') {
        setTsstoreQueryType(rawQuery);
        setTsstoreSinceDuration('1h');
      }
      // Restore the source-side filter. A filter equal to the variable token
      // restores in 'variable' mode (shows the chip); any other non-empty value
      // restores as a literal substring. Applies to all tsstore subtypes
      // (newest/oldest/since + streaming transport).
      const savedFilter = chart.query_config?.params?.filter;
      if (typeof savedFilter === 'string' && savedFilter !== '') {
        if (savedFilter === DASHBOARD_VARIABLE_TOKEN) {
          setTsstoreFilterSource('variable');
          setTsstoreFilter('');
        } else {
          setTsstoreFilterSource('literal');
          setTsstoreFilter(savedFilter);
        }
        setTsstoreFilterIgnoreCase(!!chart.query_config?.params?.filter_ignore_case);
      }
      // Prometheus query config: restore instant/range + window/step from the
      // saved params. Restore whenever a Prometheus query_type param is present
      // (documentary type may say "prometheus" or "sql"/"api" on agent-built
      // charts). A range start of "now-1h" maps back to time_range "1h".
      const promQt = chart.query_config?.params?.query_type;
      if (promQt === 'instant' || promQt === 'range') {
        setPromQueryType(promQt);
        const start = chart.query_config?.params?.start;
        if (typeof start === 'string' && start.startsWith('now-')) {
          setPromTimeRange(start.slice(4));
        }
        if (chart.query_config?.params?.step) {
          setPromStep(chart.query_config.params.step);
        }
      }
      // EdgeLake query config initialization. Like tsstore above, the
      // type field is documentary, not authoritative: agent-built
      // EdgeLake charts commonly save query_config.type:"sql" while
      // still carrying the EdgeLake `database` param (EdgeLake speaks
      // SQL against an edgelake connection). Keying restoration on
      // type==='edgelake' missed those, so edgelakeDatabase stayed empty
      // and handleSave's params builder then wrote params:{} — silently
      // dropping the database on every save and breaking the query.
      // Restore from the saved param whenever it's present, regardless
      // of the documentary type.
      if (chart.query_config?.params?.database) {
        setEdgelakeDatabase(chart.query_config.params.database);
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
      setUsesDashboardVariable(!!chart.uses_dashboard_variable);
      const usingCustomCode = chart.use_custom_code ?? (chart.chart_type === 'custom');
      setShowCustomCode(usingCustomCode);
      // Land on the Code tab for custom-code charts — that's the primary
      // editing surface in this mode. Tabs are [Details, Preview, Code],
      // so Code is index 2. (The Details tab stays available so the
      // connection/query/parser feeding `data` remain editable.)
      if (usingCustomCode) {
        setActiveTab(2);
      }
      // Initialize chart options from saved data. Base on a fresh copy
      // of DEFAULT_CHART_OPTIONS — NOT the prior chartOptions state — so
      // a previously-edited chart's keys (xAxisRange, sizeColumn,
      // tooltip, …) don't bleed into this one on a reused editor
      // instance. Starting from defaults still backfills option keys for
      // charts saved before those keys existed.
      setChartOptions({ ...DEFAULT_CHART_OPTIONS, ...(chart.options || {}) });
      // Snapshot mirrors the post-load values for every field in the diff —
      // including the default aggregation shape — so the form doesn't read
      // as dirty on entry. Must list every field handleSave reads into the
      // payload; anything missing here silently won't trip the Save button.
      const loadedYAxisLabels = (() => {
        // Mirrors the load above: y_axis_labels only — y_axis_label is
        // the axis label now, not a series-label seed.
        const arr = chart.data_mapping?.y_axis_labels;
        return Array.isArray(arr) && arr.length > 0 ? arr : [];
      })();
      const loadedVisibleSnap = chart.data_mapping?.visible_columns;
      const loadedTb = chart.data_mapping?.time_bucket;
      const loadedTbValid = loadedTb?.interval > 0 && !!loadedTb?.timestamp_col && (loadedTb?.value_cols?.length || 0) > 0;
      const loadedSw = chart.data_mapping?.sliding_window;
      const loadedLb = chart.data_mapping?.latest_by;
      const loadedParser = chart.data_mapping?.parser;
      const loadedParserPreset = (() => {
        if (!loadedParser?.data_path && !loadedParser?.timestamp_field) return 'none';
        if (loadedParser.data_path === 'data' && loadedParser.timestamp_field === 'timestamp' && loadedParser.timestamp_scale === 'ns') return 'tsstore';
        return 'custom';
      })();
      const loadedQueryType = chart.query_config?.type || 'sql';
      const loadedTsRaw = loadedQueryType === 'tsstore' ? (chart.query_config?.raw || 'newest') : '';
      const loadedTsRangeMatch = loadedTsRaw.match(/^range:(\d+):(\d+)$/);
      // Mirror the setTsstore* restore above EXACTLY (no query-type gate —
      // the type field is documentary): latest_by param wins over the raw
      // shape (raw is a documentary 'newest' for the 'latest' type).
      const loadedTsLatestByParam = chart.query_config?.params?.latest_by;
      const loadedTsstoreLatestBy = (typeof loadedTsLatestByParam === 'string' && loadedTsLatestByParam.trim() !== '') ? loadedTsLatestByParam : '';
      const loadedTsstoreQueryType = loadedTsstoreLatestBy
        ? 'latest'
        : (loadedTsRaw.startsWith('since:')
          ? 'since'
          : (loadedTsRangeMatch ? 'range' : (loadedTsRaw || 'since')));
      const loadedTsstoreSinceDuration = loadedTsRaw.startsWith('since:') ? loadedTsRaw.substring(6) : '1h';
      const loadedTsstoreRangeFrom = loadedTsRangeMatch ? epochSecondsToDtLocal(loadedTsRangeMatch[1]) : '';
      const loadedTsstoreRangeTo = loadedTsRangeMatch ? epochSecondsToDtLocal(loadedTsRangeMatch[2]) : '';
      const loadedTsstoreLimit = chart.query_config?.params?.limit || defaultTsstoreLimit(chart.chart_type);
      const loadedTsFilter = chart.query_config?.params?.filter;
      const loadedTsstoreFilterSource = loadedTsFilter === DASHBOARD_VARIABLE_TOKEN ? 'variable' : 'literal';
      const loadedTsstoreFilter = (typeof loadedTsFilter === 'string' && loadedTsFilter !== DASHBOARD_VARIABLE_TOKEN) ? loadedTsFilter : '';
      const loadedTsstoreFilterIgnoreCase = !!chart.query_config?.params?.filter_ignore_case;
      // Prometheus params — mirror the setProm* restore above so the snapshot
      // matches state and the form doesn't read dirty on load.
      const loadedPromQt = chart.query_config?.params?.query_type;
      const loadedPromQueryType = (loadedPromQt === 'instant' || loadedPromQt === 'range') ? loadedPromQt : 'range';
      const loadedPromStart = chart.query_config?.params?.start;
      const loadedPromTimeRange = (typeof loadedPromStart === 'string' && loadedPromStart.startsWith('now-')) ? loadedPromStart.slice(4) : '1h';
      const loadedPromStep = chart.query_config?.params?.step || '1m';
      // Mirror the setEdgelakeDatabase restore above: the database param
      // is the source of truth, not the documentary query_config.type
      // (agent-built EdgeLake charts save type:"sql"). Snapshot must match
      // the state set above or the form reads dirty on load.
      const loadedEdgelakeDatabase = chart.query_config?.params?.database || '';
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
        tsstoreRangeFrom: loadedTsstoreRangeFrom,
        tsstoreRangeTo: loadedTsstoreRangeTo,
        promQueryType: loadedPromQueryType,
        promTimeRange: loadedPromTimeRange,
        promStep: loadedPromStep,
        tsstoreLimit: loadedTsstoreLimit,
        tsstoreLatestBy: loadedTsstoreLatestBy,
        tsstoreFilter: loadedTsstoreFilter,
        tsstoreFilterSource: loadedTsstoreFilterSource,
        tsstoreFilterIgnoreCase: loadedTsstoreFilterIgnoreCase,
        edgelakeDatabase: loadedEdgelakeDatabase,
        xAxisColumn: chart.data_mapping?.x_axis || '',
        xAxisLabel: chart.data_mapping?.x_axis_label || '',
        xAxisFormat: chart.data_mapping?.x_axis_format || 'auto',
        // Match the extracted state set above (strings + per-column colors) so
        // the dirty-tracking baseline equals the live state on load.
        yAxisColumns: loadedYCols,
        yAxisColors: loadedYColors,
        yAxisLabel: chart.data_mapping?.y_axis_label || '',
        yAxisLabels: loadedYAxisLabels,
        groupByColumn: chart.data_mapping?.group_by || '',
        seriesColumn: chart.data_mapping?.series || '',
        filters: chart.data_mapping?.filters || [],
        aggregation: chart.data_mapping?.aggregation || { type: '', sortBy: '', field: '', count: 10 },
        slidingWindowEnabled: loadedSw?.duration > 0 && !!loadedSw?.timestamp_col,
        slidingWindowDuration: loadedSw?.duration || 300,
        slidingWindowTimestampCol: loadedSw?.timestamp_col || '',
        latestByEnabled: !!loadedLb?.key_col,
        latestByKeyCol: loadedLb?.key_col || '',
        latestByTimestampCol: loadedLb?.timestamp_col || '',
        timeBucketEnabled: loadedTbValid,
        timeBucketInterval: loadedTb?.interval || 60,
        timeBucketFunction: loadedTb?.function || 'avg',
        timeBucketValueCols: loadedTb?.value_cols || [],
        timeBucketTimestampCol: loadedTb?.timestamp_col || '',
        sortBy: chart.data_mapping?.sort_by || '',
        sortOrder: chart.data_mapping?.sort_order || 'desc',
        limitRows: chart.data_mapping?.limit || 0,
        columnAliases: chart.data_mapping?.column_aliases || {},
        columnWidths: chart.data_mapping?.column_widths || {},
        columnFormats: chart.data_mapping?.column_formats || {},
        columnRules: chart.data_mapping?.column_rules || {},
        visibleColumns: Array.isArray(loadedVisibleSnap) && loadedVisibleSnap.length > 0 ? loadedVisibleSnap : null,
        parserPreset: loadedParserPreset,
        parserDataPath: loadedParser?.data_path || '',
        parserTimestampField: loadedParser?.timestamp_field || '',
        parserTimestampScale: loadedParser?.timestamp_scale || '',
        bandColumns: chart.data_mapping?.band_columns ? { scheme: 'sd', ...chart.data_mapping.band_columns } : { scheme: 'sd' },
        bandedBarStyle: chart.options?.bandedBarStyle || 'time_series',
        // Capture chartOptions snapshot AS MERGED with defaults so it
        // matches whatever the state ends up holding after the
        // setChartOptions spread above (DEFAULT_CHART_OPTIONS base, NOT
        // the prior chartOptions state). Otherwise the snapshot and the
        // actual state diverge and the form reads dirty on load.
        chartOptions: { ...DEFAULT_CHART_OPTIONS, ...(chart.options || {}) },
        componentCode: chart.component_code || '',
        showCustomCode: chart.use_custom_code ?? (chart.chart_type === 'custom' || !!chart.component_code),
        usesDashboardVariable: !!chart.uses_dashboard_variable,
      }));
    } else {
      // New chart - reset to defaults; snapshot mirrors them. chartOptions
      // is intentionally NOT in the snapshot: valueSize lazy-loads from an
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
        chartType: 'line',
        controlConfig: null,
        displayConfig: null,
        connectionId: '',
        queryRaw: '',
        queryType: 'sql',
        tsstoreQueryType: 'newest',
        tsstoreSinceDuration: '1h',
        tsstoreRangeFrom: '',
        tsstoreRangeTo: '',
        promQueryType: 'range',
        promTimeRange: '1h',
        promStep: '1m',
        tsstoreLimit: defaultTsstoreLimit('line'),
        tsstoreLatestBy: '',
        tsstoreFilter: '',
        tsstoreFilterSource: 'literal',
        tsstoreFilterIgnoreCase: false,
        edgelakeDatabase: '',
        xAxisColumn: '',
        xAxisLabel: '',
        xAxisFormat: 'auto',
        yAxisColumns: [],
        yAxisColors: [],
        yAxisLabel: '',
        yAxisLabels: [],
        groupByColumn: '',
        seriesColumn: '',
        filters: [],
        aggregation: { type: '', sortBy: '', field: '', count: 10 },
        slidingWindowEnabled: false,
        slidingWindowDuration: 300,
        slidingWindowTimestampCol: '',
        latestByEnabled: false,
        latestByKeyCol: '',
        latestByTimestampCol: '',
        timeBucketEnabled: false,
        timeBucketInterval: 60,
        timeBucketFunction: 'avg',
        timeBucketValueCols: [],
        timeBucketTimestampCol: '',
        sortBy: '',
        sortOrder: 'desc',
        limitRows: 0,
        columnAliases: {},
        columnWidths: {},
        columnFormats: {},
        columnRules: {},
        visibleColumns: null,
        parserPreset: 'none',
        parserDataPath: '',
        parserTimestampField: '',
        parserTimestampScale: '',
        bandColumns: { scheme: 'sd' },
        bandedBarStyle: 'time_series',
        // Snapshot current chartOptions state so the diff doesn't read
        // as dirty before the user touches anything. The lazy load of
        // valueSize from admin settings may mutate this after mount,
        // causing a one-time false-dirty on new charts — acceptable
        // tradeoff for getting toggles to actually enable Save.
        chartOptions,
        componentCode: '',
        showCustomCode: false,
        usesDashboardVariable: false,
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
      tsstoreRangeFrom,
      tsstoreRangeTo,
      tsstoreLimit,
      tsstoreLatestBy,
      promQueryType,
      promTimeRange,
      promStep,
      tsstoreFilter,
      tsstoreFilterSource,
      tsstoreFilterIgnoreCase,
      edgelakeDatabase,
      xAxisColumn,
      xAxisLabel,
      xAxisFormat,
      yAxisColumns,
      yAxisLabel,
      yAxisLabels,
      yAxisColors,
      groupByColumn,
      seriesColumn,
      filters,
      aggregation,
      slidingWindowEnabled,
      slidingWindowDuration,
      slidingWindowTimestampCol,
      latestByEnabled,
      latestByKeyCol,
      latestByTimestampCol,
      timeBucketEnabled,
      timeBucketInterval,
      timeBucketFunction,
      timeBucketValueCols,
      timeBucketTimestampCol,
      sortBy,
      sortOrder,
      limitRows,
      columnAliases,
      columnWidths,
      columnFormats,
      columnRules,
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
      usesDashboardVariable,
    });
    const dirty = currentState !== initialState;
    setHasChanges(dirty);
    if (onDirtyChange) onDirtyChange(dirty);
  }, [
    name, title, description, namespace, tags, componentType, chartType,
    controlConfig, displayConfig, selectedConnectionId, queryRaw, queryType,
    tsstoreQueryType, tsstoreSinceDuration, tsstoreRangeFrom, tsstoreRangeTo, tsstoreLimit, tsstoreLatestBy, promQueryType, promTimeRange, promStep, tsstoreFilter, tsstoreFilterSource, tsstoreFilterIgnoreCase, edgelakeDatabase,
    xAxisColumn, xAxisLabel, xAxisFormat, yAxisColumns, yAxisLabel, yAxisLabels, yAxisColors,
    groupByColumn, seriesColumn, filters, aggregation,
    slidingWindowEnabled, slidingWindowDuration, slidingWindowTimestampCol,
    latestByEnabled, latestByKeyCol, latestByTimestampCol,
    timeBucketEnabled, timeBucketInterval, timeBucketFunction, timeBucketValueCols, timeBucketTimestampCol,
    sortBy, sortOrder, limitRows, columnAliases, columnWidths, columnFormats, columnRules, visibleColumns,
    parserPreset, parserDataPath, parserTimestampField, parserTimestampScale,
    bandColumns, bandedBarStyle, chartOptions,
    componentCode, showCustomCode, usesDashboardVariable, initialState, onDirtyChange,
  ]);

  // Notify parent of validity changes
  useEffect(() => {
    if (onValidityChange) {
      onValidityChange(!!name.trim());
    }
  }, [name, onValidityChange]);

  // Notify the parent modal when a nested modal opens/closes so it can drop its
  // focus trap (which otherwise steals focus from the nested modal's inputs).
  const anyNestedModalOpen = chartTypeModalOpen || connectionPickerOpen || valuePickerOpen || clientValuePickerOpen;
  useEffect(() => {
    if (onNestedModalChange) onNestedModalChange(anyNestedModalOpen);
  }, [anyNestedModalOpen, onNestedModalChange]);

  // Resolve selectedDatasource from the loaded connection list when the id
  // changes.
  //
  // The list is NOT authoritative for "which connection is selected" — the
  // saved component's connection_id is. The list is a cache that can legitimately
  // not contain the selected connection:
  //   - it is capped at page_size 100, so connection #101 is never in it;
  //   - it is fetched once on mount, racing the component load, and its
  //     failure path only console.errors.
  // When that happened the editor showed NO connection even though
  // selectedConnectionId was correct — reopening the editor refetched the list
  // and it appeared, which is the intermittent "connection not displayed" bug.
  //
  // So a miss triggers a single targeted fetch of that ONE connection rather
  // than clearing the display. Only a genuinely empty id clears it.
  useEffect(() => {
    if (!selectedConnectionId) {
      setSelectedDatasource(null);
      return;
    }
    const ds = connections.find(d => d.id === selectedConnectionId);
    if (ds) {
      setSelectedDatasource(ds);
      return;
    }
    // Not in the list. Don't blank the selection — fetch the one we need.
    // `cancelled` guards the async continuation: a mountedRef can't gate this
    // (see the v0.41.0 zombie-stream fix) and the id can change mid-flight.
    let cancelled = false;
    (async () => {
      try {
        const conn = await apiClient.getConnection(selectedConnectionId);
        if (cancelled || !conn?.id) return;
        setSelectedDatasource(conn);
        // Merge into the list so the tag row / guidance that read from
        // `connections` see it too — same merge the picker does on select.
        setConnections((prev) => (prev.some((c) => c.id === conn.id) ? prev : [...prev, conn]));
      } catch {
        // The connection may genuinely be gone (deleted out from under the
        // component). Leave whatever is displayed rather than thrashing.
      }
    })();
    return () => { cancelled = true; };
  }, [selectedConnectionId, connections]);

  // Lazy-load EdgeLake database list when the active connection is
  // EdgeLake. Visual mode (EdgeLakeQueryBuilder) loads its own
  // copy; this populates the Raw-mode database Select so users
  // don't have to hand-type the name. One fetch per connection
  // change; resets when the connection switches.
  useEffect(() => {
    if (!selectedConnectionId || selectedDatasource?.type !== 'edgelake') {
      setEdgelakeDatabasesList([]);
      return;
    }
    let cancelled = false;
    setEdgelakeDatabasesLoading(true);
    apiClient.getEdgeLakeDatabases(selectedConnectionId)
      .then((res) => {
        if (cancelled) return;
        setEdgelakeDatabasesList(Array.isArray(res?.databases) ? res.databases : []);
      })
      .catch(() => {
        if (cancelled) return;
        setEdgelakeDatabasesList([]);
      })
      .finally(() => {
        if (!cancelled) setEdgelakeDatabasesLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedConnectionId, selectedDatasource?.type]);

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
  // The adapter-declared query surface for the selected connection, if it
  // declared one. Undefined for every type that didn't — those keep the raw box.
  const activeQuerySurface = selectedDatasource?.type
    ? querySurfaces[selectedDatasource.type]
    : undefined;

  // RAW socket/mqtt have no query API (only a live stream), so a discovered
  // value list is captured live + persisted on the connection (design authority)
  // for the dashboard dropdown to read without a costly view-time capture.
  // tsstore/API/SQL/EdgeLake re-discover on demand via a query, so no persist.
  const shouldPersistDiscovered = isSocket || isMQTT;

  // Stop an in-flight live discovery capture (raw socket/mqtt). Leaves the
  // picker open with what was accumulated so the user can pick.
  const stopClientCapture = useCallback(() => {
    if (clientCaptureRef.current) { clientCaptureRef.current.close(); clientCaptureRef.current = null; }
    setClientCapturing(false);
  }, []);

  // Live value discovery for RAW socket/mqtt: open the picker immediately and
  // stream distinct values into it as SSE records arrive, with a Stop button.
  // Mirrors the dashboard's Regenerate. column = the bound filter field.
  const startClientCapture = useCallback((column) => {
    if (!selectedConnectionId || !column) return false;
    if (clientCaptureRef.current) { clientCaptureRef.current.close(); clientCaptureRef.current = null; }
    setClientDiscoveredColumn(column);
    setClientDiscoveredValues([]);
    setClientRecordCount(0);
    setClientDiscoveredPartial(true); // a live capture is always potentially incomplete
    setClientCapturing(true);
    setClientValuePickerOpen(true);
    const authParam = apiClient.streamAuthQuery();
    const topicParam = (isMQTT && queryRaw) ? `&topics=${encodeURIComponent(queryRaw)}` : '';
    const sseUrl = `${apiClient.httpOriginForApi()}/api/connections/${selectedConnectionId}/stream?${authParam}${topicParam}`;
    const es = new EventSource(sseUrl);
    clientCaptureRef.current = es;
    const seen = new Set();
    const values = [];
    const CAP = 1000;
    const finish = () => {
      if (clientCaptureRef.current !== es) return;
      es.close();
      clientCaptureRef.current = null;
      setClientCapturing(false);
    };
    let records = 0;
    es.addEventListener('record', (event) => {
      try {
        records += 1;
        setClientRecordCount(records);
        const rec = JSON.parse(event.data);
        const v = rec?.[column];
        if (v != null) {
          const s = String(v);
          if (s !== '' && !seen.has(s)) { seen.add(s); values.push(s); setClientDiscoveredValues([...values]); }
        }
        if (values.length >= CAP) finish();
      } catch { /* ignore parse errors */ }
    });
    es.onerror = () => { if (clientCaptureRef.current === es) finish(); };
    setTimeout(() => { if (clientCaptureRef.current === es) finish(); }, 300000); // 5 min safety cap
    return true;
  }, [selectedConnectionId, isMQTT, queryRaw]);

  // Tear down any live discovery capture on unmount.
  useEffect(() => () => {
    if (clientCaptureRef.current) { clientCaptureRef.current.close(); clientCaptureRef.current = null; }
  }, []);

  const handleDatasourceChange = (newDatasourceId, connObj = null) => {
    setSelectedConnectionId(newDatasourceId);
    // Params are connection-type specific (a Synology method/result_path means
    // nothing to a SQL connection), so a connection switch must NOT carry the
    // previous connection's passthrough params over.
    setPassthroughQueryParams(null);
    // Same reasoning for the catalog preset — a DSM API is meaningless to a
    // SQL connection, and a stale preset would keep injecting its params.
    setSelectedQueryPreset(null);
    setPendingPresetMatch(null);

    // Resolve the connection: an explicitly-passed object (from the picker
    // modal, which may know connections beyond the editor's capped list) wins;
    // otherwise look it up in the editor's loaded connections.
    if (newDatasourceId) {
      const ds = connObj || (connections.length > 0 ? connections.find(d => d.id === newDatasourceId) : null);
      if (ds) {
        // Clear a stale query when switching to a DIFFERENT connection type.
        // A raw query is dialect-specific — a tsstore "since:1h", an EdgeLake
        // SQL string, an API path fragment — and carrying it across a type
        // change silently corrupts the new connection's request. (Concretely:
        // a leftover tsstore "since:1h" on an API connection gets glued onto
        // the URL as "?…=true/since:1h", dropping fields from the response.)
        // Only reset on a real TYPE change so re-selecting the same connection
        // (or another of the same type) keeps a query the user may want. The
        // type-specific branches below still set their own sensible defaults
        // (e.g. tsstore REST → "newest", mqtt → topic flow) after this.
        const prevType = selectedDatasource?.type;
        if (prevType && prevType !== ds.type) {
          setQueryRaw('');
        }
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
              setTsstoreLimit(defaultTsstoreLimit(chartType));
              setTsstoreLatestBy('');
              setTsstoreSinceDuration('1h');
              setPromQueryType('range');
              setPromTimeRange('1h');
              setPromStep('1m');
              setTsstoreFilter('');
              setTsstoreFilterSource('literal');
              setTsstoreFilterIgnoreCase(false);
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
          case 'synology':
            // 'api' rather than a synology-specific value: query_config.type is
            // documentary here (the adapter dispatches on params, and the type
            // field is dropped before it ever reaches one), and models.QueryType
            // has no synology constant. The catalog picker below renders from
            // the adapter's declared surface, not from this.
            setQueryType('api');
            setQueryMode('raw');
            break;
        }
      }
    }
  };

  // Drop column selections that aren't in `cols`. Called after a fetch
  // (re)populates availableColumns — switching connection or editing the
  // query can change the schema, and a selection pointing at a column
  // that no longer exists silently breaks the chart and leaves a ghost
  // value in the picker. Empties/resets every column-bearing field so the
  // user re-picks from the new schema. Applies to all chart types.
  const pruneStaleColumnSelections = (cols) => {
    const has = (c) => typeof c === 'string' && c.length > 0 && cols.includes(c);

    if (xAxisColumn && !has(xAxisColumn)) setXAxisColumn('');
    setYAxisColumns((prev) => {
      const kept = (prev || []).filter(has);
      return kept.length === (prev || []).length ? prev : kept;
    });
    if (seriesColumn && !has(seriesColumn)) setSeriesColumn('');
    if (groupByColumn && !has(groupByColumn)) setGroupByColumn('');
    if (sortBy && !has(sortBy)) setSortBy('');
    // Sliding window: clearing its timestamp column must also disable the
    // feature. Leaving it enabled with no timestamp creates an
    // unsaveable "enabled but no timestamp column" state (save validation
    // rejects it). The two stay in lockstep: no timestamp ⇒ off.
    if (slidingWindowTimestampCol && !has(slidingWindowTimestampCol)) {
      setSlidingWindowTimestampCol('');
      setSlidingWindowEnabled(false);
    }
    // Latest-by: the KEY column is required, so losing it disables the feature
    // (same lockstep as the sliding window above). The timestamp column is
    // optional — a stale one just clears, falling back to arrival order.
    if (latestByKeyCol && !has(latestByKeyCol)) {
      setLatestByKeyCol('');
      setLatestByEnabled(false);
    }
    if (latestByTimestampCol && !has(latestByTimestampCol)) {
      setLatestByTimestampCol('');
    }

    // chartOptions-held column (scatter bubble size).
    if (chartOptions.sizeColumn && !has(chartOptions.sizeColumn)) {
      updateChartOption('sizeColumn', '');
    }

    // visible_columns subset (dataview) — keep only present ones.
    setVisibleColumns((prev) => {
      if (!Array.isArray(prev)) return prev;
      const kept = prev.filter(has);
      return kept.length === prev.length ? prev : kept;
    });

    // column_widths (dataview) — drop widths for columns no longer present.
    setColumnWidths((prev) => {
      if (!prev || typeof prev !== 'object') return prev;
      const keys = Object.keys(prev);
      const next = {};
      for (const k of keys) if (has(k)) next[k] = prev[k];
      return Object.keys(next).length === keys.length ? prev : next;
    });

    // column_rules (dataview) — same treatment: a rule set keyed on a column
    // the query no longer returns can never fire, so don't carry it forward.
    setColumnRules((prev) => {
      if (!prev || typeof prev !== 'object') return prev;
      const keys = Object.keys(prev);
      const next = {};
      for (const k of keys) if (has(k)) next[k] = prev[k];
      return Object.keys(next).length === keys.length ? prev : next;
    });

    // Time bucket value + timestamp columns.
    setTimeBucketValueCols((prev) => {
      const kept = (prev || []).filter(has);
      return kept.length === (prev || []).length ? prev : kept;
    });
    if (timeBucketTimestampCol && !has(timeBucketTimestampCol)) setTimeBucketTimestampCol('');

    // Banded-bar column map — clear any mapped column not in the new data
    // schema. `scheme` is the scheme id, not a column, so skip it.
    setBandColumns((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (k === 'scheme') continue;
        if (next[k] && !has(next[k])) { next[k] = ''; changed = true; }
      }
      return changed ? next : prev;
    });
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
    setTitle('');
    setDescription('');
    setNamespace(activeNamespace || 'default');
    setTags([]);
    setComponentType('chart');
    setControlConfig(null);
    setDisplayConfig(null);
    // Line is the most-used chart type on this platform (most data
    // is time-stamped). The initialState snapshot below must agree
    // so dirty-detection doesn't think the form is dirty on mount.
    setChartType('line');
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
        setYAxisColors([]);
    setGroupByColumn('');
    setSeriesColumn('');
    setFilters([]);
    setAggregation({ type: '', sortBy: '', field: '', count: 10 });
    setSortBy('');
    setSortOrder('desc');
    setLimitRows(0);
    setColumnAliases({});
    setColumnWidths({});
    setColumnFormats({});
    setColumnRules({});
    setVisibleColumns(null);
    setSlidingWindowEnabled(false);
    setSlidingWindowDuration(300);
    setSlidingWindowTimestampCol('');
    setLatestByEnabled(false);
    setLatestByKeyCol('');
    setLatestByTimestampCol('');
    setBandColumns({ scheme: 'sd' });
    setBandedBarStyle('time_series');
    setTimeBucketEnabled(false);
    setTimeBucketInterval(60);
    setTimeBucketFunction('avg');
    setTimeBucketValueCols([]);
    setTimeBucketTimestampCol('');
    setTsstoreQueryType('newest');
    setTsstoreLimit(defaultTsstoreLimit('line'));
    setTsstoreLatestBy('');
    setTsstoreSinceDuration('1h');
    setPromQueryType('range');
    setPromTimeRange('1h');
    setPromStep('1m');
    setTsstoreFilter('');
    setTsstoreFilterSource('literal');
    setTsstoreFilterIgnoreCase(false);
    setEdgelakeDatabase('');
    setParserPreset('none');
    setParserDataPath('');
    setParserTimestampField('');
    setParserTimestampScale('');
    setComponentCode('');
    setShowCustomCode(false);
    setUsesDashboardVariable(false);
    // Wholesale replace — a fresh copy of the defaults, NOT a merge over
    // the prior chartOptions state, so spec-driven keys (xAxisRange,
    // sizeColumn, tooltip, …) can't bleed from a previously-edited chart.
    setChartOptions({ ...DEFAULT_CHART_OPTIONS });
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

  // Load adapter-declared query surfaces once. Keyed by the SHORT connection
  // type because that's what connection records carry ('synology'), while the
  // registry keys on the dotted adapter id ('api.synology') — registryTypeIdToLegacy
  // bridges the two, mirroring legacyToRegistryTypeID on the server.
  //
  // A failure here is non-fatal on purpose: the map stays empty, every type
  // falls back to the raw query box, and the editor works exactly as it did
  // before query surfaces existed. Losing a nicer picker should never block
  // authoring a component.
  const fetchQuerySurfaces = async () => {
    try {
      const data = await apiClient.getRegistryConnectionTypes();
      const surfaces = {};
      for (const t of data?.types || []) {
        if (t?.query_surface?.kind) {
          surfaces[registryTypeIdToLegacy(t.type_id)] = t.query_surface;
        }
      }
      setQuerySurfaces(surfaces);
    } catch (err) {
      console.error('Failed to fetch connection query surfaces:', err);
    }
  };

  // fetchPreviewData runs the preview query. variableValueOverride lets the
  // value-picker re-invoke it with the chosen value directly (state updates are
  // async, so we can't rely on previewVariableValue being set yet on re-entry).
  const fetchPreviewData = async (variableValueOverride = undefined) => {
    // Buttons wire onClick={fetchPreviewData}, so React passes a click EVENT as
    // the first arg. Only honor a real string override (the value picker passes
    // one); ignore anything else so an event never lands in query.params and
    // breaks JSON.stringify ("cyclic object value").
    if (typeof variableValueOverride !== 'string') variableValueOverride = undefined;
    if (!selectedConnectionId) {
      setPreviewError('Please select a connection');
      return;
    }

    // Socket, API, and TSStore datasources don't require manual query entry
    if (!isSocket && !isMQTT && !isAPI && !isTSStore && !queryRaw.trim()) {
      setPreviewError('Please enter a query');
      return;
    }

    // Intercept: a query that uses the dashboard-variable token can't run
    // without a value. Rather than a separate "set a preview value" step, the
    // Fetch action opens the value picker; the user picks a value and the
    // picker re-invokes this fetch with it. The chosen value is transient —
    // the returned data makes the selection self-evident, so we don't surface
    // a "current value" field.
    const effectiveVarValue = variableValueOverride !== undefined ? variableValueOverride : previewVariableValue;
    if (
      typeof queryRaw === 'string' &&
      queryRaw.includes(DASHBOARD_VARIABLE_TOKEN) &&
      !effectiveVarValue
    ) {
      setValuePickerOpen(true);
      return;
    }

    // Raw socket/mqtt value discovery: these have NO query API, so we can't
    // harvest from a one-shot fetch. When a client-side filter is bound to the
    // variable and no value is chosen yet, open the picker and stream distinct
    // values into it live (Stop when it stabilizes), instead of running a
    // preview query. tsstore/API/SQL harvest from their query result below.
    if ((isSocket || isMQTT) && variableBoundFilter && !effectiveVarValue) {
      startClientCapture(variableBoundFilter.field);
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
        const sseUrl = `${apiClient.httpOriginForApi()}/api/connections/${selectedConnectionId}/stream?${authParam}${topicParam}`;
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
          const resultSet = { columns, rows, metadata: { row_count: rows.length } };
          setPreviewData(resultSet);
          if (columns.length > 0) {
            setAvailableColumns(columns);
            if (!xAxisColumn) setXAxisColumn(columns[0]);
            if (yAxisColumns.length === 0 && columns.length > 1) setYAxisColumns([columns[1]]);
          }
          // Streaming captures are always potentially incomplete (the user
          // stops, or the window/cap ends) — flag the discovered list partial.
          maybeOpenClientValuePicker(resultSet, { partial: true });
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

      if (isTSStoreStreaming) {
        // tsstore answers "newest" over HTTP even in streaming transport, so we
        // don't rely on a live stream collect. For value discovery (a filter
        // bound to the variable, no value chosen yet) pull a deep window so the
        // harvest sees enough distinct values; otherwise a small newest is
        // plenty for schema preview.
        rawQuery = 'newest';
        queryParams = { limit: (variableBoundFilter && !effectiveVarValue) ? 1000 : (tsstoreLimit || defaultTsstoreLimit(chartType)) };
        // Apply the source-side filter unless we're discovering distinct
        // values for the picker (variable bound + no value yet) — in that
        // case a variable filter would resolve to nothing and starve the harvest.
        if (!(tsstoreFilterUsesVariable && !effectiveVarValue)) {
          Object.assign(queryParams, buildTsstoreFilterParams());
        }
      } else if (isSocket) {
        rawQuery = ''; // Raw socket has no query API — adapter collects from the live stream
      } else if (isTSStore) {
        // Build TSStore query: 'newest', 'oldest', or 'since:DURATION'
        if (tsstoreQueryType === 'since') {
          // For 'since' queries, don't limit - fetch all data in time window
          rawQuery = `since:${tsstoreSinceDuration}`;
          queryParams = {};
        } else if (tsstoreQueryType === 'range') {
          // Absolute from→to window. Falls back to 'newest' if either bound is
          // unset/invalid so we never emit a malformed range: the adapter rejects.
          rawQuery = buildTsstoreRangeRaw(tsstoreRangeFrom, tsstoreRangeTo) || 'newest';
          queryParams = {};
        } else if (tsstoreQueryType === 'latest') {
          // Current state per series — latest_by rides in params, raw is 'newest'.
          // No limit: it would cap distinct series (ts-store defaults to 1000).
          rawQuery = 'newest';
          queryParams = { ...buildTsstoreLatestByParams() };
        } else {
          // For 'newest' or 'oldest', use the configured limit
          rawQuery = tsstoreQueryType;
          queryParams = { limit: tsstoreLimit };
        }
        if (!(tsstoreFilterUsesVariable && !effectiveVarValue)) {
          Object.assign(queryParams, buildTsstoreFilterParams());
        }
      } else if (selectedDatasource?.type === 'prometheus') {
        // Preview must use the chosen instant/range so the editor shows the
        // same shape the saved chart will render. (Raw mode's radio group;
        // visual mode keeps using its own builder execution.)
        queryParams = buildPrometheusParams();
      } else if (selectedDatasource?.type === 'edgelake' && edgelakeDatabase) {
        queryParams = { database: edgelakeDatabase };
      } else {
        // Adapter-declared surface (the selected catalog preset's params), or
        // the STORED params for a type with no surface. Sending neither makes
        // the fetch go out bare and the adapter reject it — for Synology, DSM
        // returns error 120 — so the preview errors and availableColumns is
        // never refreshed, which in turn makes the dataview column list look
        // permanently stuck at the saved subset.
        queryParams = buildSurfaceParams();
      }

      // Must go through apiClient — raw fetch() sends no auth headers
      // and 401s under session-token auth. apiClient attaches the
      // access JWT (or API key) and throws an Error with .status / .body
      // on non-2xx, so the existing error handling works unchanged.
      // Server's QueryRequest shape is { query: { raw, type, params } } —
      // see server-go/internal/models/connection.go. SQLQueryBuilder and
      // friends wrap correctly; this caller had been sending the inner
      // object flat, which bound to QueryRequest{Query: zero} on the
      // server and made the adapter reject with "query is required".
      // Why did anything ever work? Because tsstore's adapter treats
      // empty raw as "newest" + default cap, so flat payloads got back
      // ANY result on tsstore connections — masking the bug for SQL /
      // EdgeLake / Prometheus / API users who hit "query is required."
      // Supply the dashboard-variable value (from the picker) when the query
      // uses the token, so the server substitutes it instead of erroring.
      if (typeof rawQuery === 'string' && rawQuery.includes(DASHBOARD_VARIABLE_TOKEN)) {
        queryParams = { ...queryParams, dashboard_variable: effectiveVarValue };
      }
      // Range token: drop the `<col> {{range-variable}}` predicate for the
      // preview so it runs UNBOUNDED — the range only scopes data at view time,
      // and a seeded window could land on an empty period and hide the shape.
      if (typeof rawQuery === 'string' && rawQuery.includes(RANGE_VARIABLE_TOKEN)) {
        rawQuery = stripRangePredicate(rawQuery);
      }

      // Cap SQL/EdgeLake PREVIEWS at a small limit (the results table only shows
      // the first handful) regardless of the component's own LIMIT — the saved
      // component keeps its real LIMIT for the dashboard.
      if (queryLanguageOwnsClientSideOps && typeof rawQuery === 'string') {
        rawQuery = rawQuery.replace(/\s+LIMIT\s+\d+(\s+OFFSET\s+\d+)?\s*$/i, '') + '\nLIMIT 100';
      }

      const data = await apiClient.queryConnection(selectedConnectionId, {
        query: {
          raw: rawQuery,
          type: queryType,
          params: queryParams,
        },
      });

      setPreviewData(data.result_set);

      // Client-side-filter value discovery: if a filter is bound to the
      // variable and no value is chosen yet, open the picker on the captured
      // rows. API/SQL fetches are bounded by the query limit (treat as
      // complete); only flag partial for streaming captures (handled below).
      maybeOpenClientValuePicker(data.result_set);

      if (data.result_set?.columns) {
        const cols = data.result_set.columns;
        setAvailableColumns(cols);

        // Drop any saved column selection the new result set no longer
        // contains (connection switch / query edit changes the schema).
        // Otherwise stale selections linger in the pickers and silently
        // break the chart.
        pruneStaleColumnSelections(cols);

        if (!xAxisColumn && cols.length > 0) {
          // Prefer the column the range variable binds (`<col> {{range-variable}}`)
          // as the x-axis — a range-scoped chart is time-series on that column.
          // Else prefer a timestamp-looking column, else the first column.
          const rangeCol = extractRangeColumn(queryRaw);
          const tsCol = cols.find((c) => isTimestampColumn(c));
          setXAxisColumn(
            (rangeCol && cols.includes(rangeCol) && rangeCol) ||
            tsCol ||
            cols[0]
          );
        }
        if (yAxisColumns.length === 0 && cols.length > 1) {
          setYAxisColumns([cols[1]]);
        }
      }
    } catch (err) {
      setPreviewError(err.message);
      setPreviewData(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Auto-fetch the preview query once when the editor opens on a SAVED
  // component that already has everything the query needs.
  //
  // availableColumns is only populated by a fetch (the old seed-from-saved-
  // references was removed — it showed a misleading subset, see the note in
  // the chart-load effect). That left every column surface inert on open:
  // the dataview column formatter rendered nothing but its "run the query"
  // hint, and the x/y/series dropdowns offered only the already-chosen value.
  // The author had to know to press Fetch Data before the editor was usable
  // at all. Running it for them is the whole point.
  //
  // Deliberately conservative — this must never surprise the author:
  //   - saved components only. A brand-new component has nothing to run.
  //   - ONCE per component id (autoFetchedRef), so it can't re-fire on an
  //     unrelated state change or fight a manual fetch.
  //   - skipped when anything is already in flight or already fetched.
  //   - skipped for custom-code components, which own their own data path.
  //   - skipped for any case where fetchPreviewData would OPEN A MODAL or
  //     start a live capture rather than just query: an unresolved dashboard
  //     variable (value picker) and raw socket/mqtt discovery. An automatic
  //     action must not pop UI the author didn't ask for.
  //   - skipped for MQTT, whose "fetch" is a long-lived SSE capture, not a
  //     one-shot query.
  // The same preconditions fetchPreviewData would otherwise reject with a
  // user-facing error are checked here so the auto path stays silent.
  const autoFetchedRef = useRef(null);
  useEffect(() => {
    const id = chart?.id;
    if (!id) return;                         // new component — nothing saved
    if (autoFetchedRef.current === id) return;
    if (showCustomCode) return;
    if (!selectedConnectionId) return;
    if (previewLoading || previewData) return;
    // Needs a query unless the type supplies its own.
    if (!isSocket && !isMQTT && !isAPI && !isTSStore && !queryRaw.trim()) return;
    // Would open the value picker instead of querying.
    if (typeof queryRaw === 'string' && queryRaw.includes(DASHBOARD_VARIABLE_TOKEN) && !previewVariableValue) return;
    // Would start a live capture instead of querying.
    if ((isSocket || isMQTT) && variableBoundFilter && !previewVariableValue) return;
    if (isMQTT) return;
    autoFetchedRef.current = id;
    fetchPreviewData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chart?.id, selectedConnectionId, queryRaw, showCustomCode, isSocket, isMQTT, isAPI, isTSStore]);

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
    // Source-side filter params (shared with backfill below).
    const tsstoreFilterParams = buildTsstoreFilterParams();
    if (isTSStoreStreaming) {
      // Streaming TS-STORE — no query needed, data arrives via SSE. The
      // source-side filter still rides on the live stream params.
      rawQuery = '';
      queryParams = { ...tsstoreFilterParams };
    } else if (isTSStore) {
      if (tsstoreQueryType === 'since') {
        // For 'since' queries, don't limit - fetch all data in time window
        rawQuery = `since:${tsstoreSinceDuration}`;
        queryParams = { ...tsstoreFilterParams };
      } else if (tsstoreQueryType === 'range') {
        // Absolute from→to window (epoch seconds). Falls back to 'newest' if a
        // bound is missing so a half-filled form never emits a bad range:.
        rawQuery = buildTsstoreRangeRaw(tsstoreRangeFrom, tsstoreRangeTo) || 'newest';
        queryParams = { ...tsstoreFilterParams };
      } else if (tsstoreQueryType === 'latest') {
        // Current state per series — latest_by rides in params, raw is 'newest'.
        rawQuery = 'newest';
        queryParams = { ...buildTsstoreLatestByParams(), ...tsstoreFilterParams };
      } else {
        // For 'newest' or 'oldest', use the configured limit
        rawQuery = tsstoreQueryType;
        queryParams = { limit: tsstoreLimit, ...tsstoreFilterParams };
      }
    } else if (selectedDatasource?.type === 'prometheus') {
      queryParams = buildPrometheusParams();
    } else if (selectedDatasource?.type === 'edgelake' && edgelakeDatabase) {
      queryParams = { database: edgelakeDatabase };
    }

    // Inject the preview value so the rendered preview's own useData fetch
    // resolves the {{dashboard-variable}} token — in raw OR in the filter param
    // (the filter token is resolved server-side via the dashboard_variable param).
    const usesVarToken =
      (typeof rawQuery === 'string' && rawQuery.includes(DASHBOARD_VARIABLE_TOKEN)) ||
      queryParams.filter === DASHBOARD_VARIABLE_TOKEN;
    if (usesVarToken) {
      queryParams = { ...queryParams, dashboard_variable: previewVariableValue };
    }

    const transforms = {
      filters,
      aggregation: aggregation.type ? aggregation : null,
      sortBy,
      sortOrder,
      limit: limitRows || 0,
      xAxisFormat: xAxisFormat || 'auto',
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

    return getDataDrivenChartCode(chartType, selectedConnectionId, rawQuery, queryType, xAxisColumn, yAxisColumns, transforms, chartOptions, queryParams, seriesColumn, columnAliases, isTSStoreStreaming || isMQTT, slidingWindow, activeParser, chart?.id || '', isTSStoreStreaming, true, tsstoreFilterParams);
  }, [chartType, selectedConnectionId, queryRaw, queryType, xAxisColumn, xAxisLabel, xAxisFormat, yAxisColumns, yAxisLabel, yAxisLabels, yAxisColors, filters, aggregation, sortBy, sortOrder, limitRows, showCustomCode, componentCode, name, title, chartOptions, selectedDatasource, tsstoreLimit, tsstoreQueryType, tsstoreSinceDuration, tsstoreRangeFrom, tsstoreRangeTo, seriesColumn, edgelakeDatabase, columnAliases, visibleColumns, isTSStoreStreaming, isMQTT, slidingWindowEnabled, slidingWindowDuration, slidingWindowTimestampCol, parserPreset, parserDataPath, parserTimestampField, parserTimestampScale, bandColumns, bandedBarStyle, previewVariableValue, buildTsstoreFilterParams, buildTsstoreLatestByParams, buildPrometheusParams]);

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

    const parsedFilters = completeFilters.map(f => {
      // Resolve the dashboard-variable token to the preview value so a
      // variable-driven filter previews against the sample value.
      const rawValue = (typeof f.value === 'string' && f.value.trim() === DASHBOARD_VARIABLE_TOKEN)
        ? previewVariableValue
        : f.value;
      return {
        field: f.field,
        op: f.op,
        value: (f.op === 'in' || f.op === 'notIn') && typeof rawValue === 'string'
          ? rawValue.split(',').map(v => v.trim())
          : rawValue
      };
    });

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
  }, [previewData, filters, aggregation, sortBy, sortOrder, limitRows, previewVariableValue]);

  const handleSave = () => {
    if (!name.trim()) {
      alert('Please enter a chart name');
      return;
    }

    // Guard against silently saving away a configured chart's data binding.
    // The save block below gates connection_id / query_config / data_mapping
    // entirely on selectedConnectionId — if that's empty at save time (a
    // reported case where the connection was bound but somehow got cleared),
    // all three get written as null and the chart looks unconfigured after
    // reload. Rather than persist that loss, block the save when the chart
    // clearly HAS configured data (a query, an axis mapping, filters, etc.)
    // but no connection. A genuinely blank new chart (nothing configured yet)
    // is still allowed to save as a stub.
    if (componentType === 'chart' && !showCustomCode && !selectedConnectionId) {
      const hasConfiguredData = !!(
        queryRaw?.trim() ||
        xAxisColumn ||
        (Array.isArray(yAxisColumns) && yAxisColumns.some((c) => typeof c === 'string' && c.trim())) ||
        seriesColumn ||
        groupByColumn ||
        (Array.isArray(filters) && filters.length > 0)
      );
      if (hasConfiguredData) {
        alert(
          'This chart has data-mapping configured but no connection selected. ' +
          'Saving now would drop the connection and data mapping. Re-select the ' +
          'connection on the Details tab before saving.'
        );
        return;
      }
    }

    // Sliding window requires a timestamp column to be meaningful, but
    // "enabled with no timestamp" isn't a user error to block on — it
    // happens when the timestamp column gets pruned (connection switch /
    // query edit) while the toggle lingers on. Self-heal: default the
    // feature to off when no timestamp is present, and reset the toggle
    // so the UI matches. The save block below only persists
    // sliding_window when both are set, so nothing stale is written.
    if (slidingWindowEnabled && !slidingWindowTimestampCol) {
      setSlidingWindowEnabled(false);
    }
    // Same self-heal for latest-by, keyed on its required KEY column (the
    // timestamp column is optional). The save block only persists latest_by
    // when a key column is set, so nothing stale is written.
    if (latestByEnabled && !latestByKeyCol) {
      setLatestByEnabled(false);
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
          ? buildTsstoreRaw(tsstoreQueryType, tsstoreSinceDuration, tsstoreRangeFrom, tsstoreRangeTo)
          : queryRaw,
        type: queryType,
        params: selectedDatasource?.type === 'tsstore'
          // 'since' and 'range' are time-windowed (no limit); 'newest'/'oldest'
          // use the limit. 'latest' omits it too — there the limit would cap
          // DISTINCT SERIES, and ts-store's own default (up to 1000 groups) is
          // the right ceiling.
          ? { ...(tsstoreQueryType === 'since' || tsstoreQueryType === 'range' || tsstoreQueryType === 'latest' ? {} : { limit: tsstoreLimit }), ...buildTsstoreLatestByParams(), ...buildTsstoreFilterParams() }
          : selectedDatasource?.type === 'prometheus'
            ? buildPrometheusParams()
            : selectedDatasource?.type === 'edgelake' && edgelakeDatabase
              ? { database: edgelakeDatabase }
              // Adapter-declared surface, else whatever was stored. Dropping
              // to {} here destroys required dispatch params — see
              // buildSurfaceParams / passthroughQueryParams.
              : buildSurfaceParams()
      } : null,
      data_mapping: selectedConnectionId ? {
        x_axis: xAxisColumn,
        x_axis_label: xAxisLabel || '',
        x_axis_format: xAxisFormat || 'auto',
        // Strip empty-column placeholders before saving. The spec-driven
        // y_axis_columns_list keeps unfilled new rows around so the user
        // can pick a column, but they shouldn't reach the wire — same for
        // their index-aligned labels + colors.
        y_axis: yAxisColumns.filter((c) => typeof c === 'string' && c.length > 0),
        // y_axis_label is the AXIS label (rendered along the axis, same
        // semantics as scatter) — series labels live in y_axis_labels.
        // The old back-compat mirror (first series label copied here) is
        // gone; strip_y_axis_label_mirror cleaned the stored copies.
        y_axis_label: yAxisLabel || '',
        y_axis_labels: (() => {
          if (!Array.isArray(yAxisLabels) || yAxisLabels.length === 0) return undefined;
          // Realign labels with the filtered y_axis. We compute the index
          // map from yAxisColumns → kept indices and project labels through it.
          const keep = yAxisColumns.map((c, i) => (typeof c === 'string' && c.length > 0 ? i : -1)).filter((i) => i >= 0);
          const aligned = keep.map((i) => yAxisLabels[i] || '');
          return aligned.length > 0 ? aligned : undefined;
        })(),
        // Per-column series colors — parallel string array, index-aligned to the
        // FILTERED y_axis (same realignment + pattern as y_axis_labels). '' = auto.
        // Omitted when no column has an explicit color, to keep records lean.
        y_axis_colors: (() => {
          const keep = yAxisColumns.map((c, i) => (typeof c === 'string' && c.length > 0 ? i : -1)).filter((i) => i >= 0);
          const aligned = keep.map((i) => (Array.isArray(yAxisColors) ? yAxisColors[i] : '') || '');
          return aligned.some((c) => c) ? aligned : undefined;
        })(),
        group_by: groupByColumn || '',
        series: seriesColumn || '', // Column for series partitioning in time buckets
        // Per-column accumulator/delta (#8). Parallel boolean array realigned to
        // the FILTERED y_axis (same realignment as y_axis_colors). Omitted when
        // no column accumulates (keeps records lean); reset_policy rides along
        // only when at least one column does, so it round-trips.
        accumulator_columns: (() => {
          const keep = yAxisColumns.map((c, i) => (typeof c === 'string' && c.length > 0 ? i : -1)).filter((i) => i >= 0);
          const aligned = keep.map((i) => (Array.isArray(yAxisAccumulate) ? yAxisAccumulate[i] === true : false));
          return aligned.some(Boolean) ? aligned : undefined;
        })(),
        accumulator_reset_policy: (Array.isArray(yAxisAccumulate) && yAxisAccumulate.some(Boolean)) ? accumulatorResetPolicy : undefined,
        // Scatter bubble mode: column whose value sizes each point.
        // Persisted on data_mapping (a data dimension, like series) so
        // scatter.js reads it alongside x/y. Empty for non-scatter.
        size_column: chartOptions.sizeColumn || '',
        filters: filters.length > 0 ? filters : [],
        aggregation: aggregation.type ? aggregation : null,
        sliding_window: slidingWindowEnabled && slidingWindowTimestampCol ? {
          duration: slidingWindowDuration,
          timestamp_col: slidingWindowTimestampCol
        } : null,
        // Only the KEY column is required; an empty timestamp_col is a valid
        // saved state meaning "newest = last-arrived".
        latest_by: latestByEnabled && latestByKeyCol ? {
          key_col: latestByKeyCol,
          timestamp_col: latestByTimestampCol || ''
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
        column_widths: pruneColumnWidths(columnWidths),
        column_formats: Object.keys(columnFormats).length > 0 ? columnFormats : undefined,
        column_rules: pruneColumnRules(columnRules),
        visible_columns: Array.isArray(visibleColumns) && visibleColumns.length > 0 ? visibleColumns : undefined,
        parser: parserPreset !== 'none' && (parserDataPath || parserTimestampField) ? {
          data_path: parserDataPath || undefined,
          timestamp_field: parserTimestampField || undefined,
          timestamp_scale: parserTimestampScale || undefined
        } : null,
        // Banded-bar column mapping — only persisted for chart_type 'banded_bar'.
        // Each row in the data must carry the named columns; the renderer
        // reads each row's own values to draw a per-row envelope.
        band_columns: chartType === 'banded_bar' && hasBandCenter(bandColumns) ? bandColumns : undefined
      } : null,
      component_code: showCustomCode ? componentCode : generatedCode,
      use_custom_code: showCustomCode,
      // Derive from token presence (query or a filter value) rather than a
      // toggle — the field reflects whether this component actually uses the
      // {{dashboard-variable}} token, however it was authored.
      uses_dashboard_variable:
        usesDashboardVariable ||
        (typeof queryRaw === 'string' && queryRaw.includes(DASHBOARD_VARIABLE_TOKEN)) ||
        filters.some((f) => typeof f.value === 'string' && f.value.trim() === DASHBOARD_VARIABLE_TOKEN) ||
        tsstoreFilterUsesVariable,
      options: (() => {
        if (chartType === 'banded_bar') {
          return { ...chartOptions, bandedBarStyle };
        }
        // When dual-axis is on, the In-stack checkbox is hidden in
        // the editor (stacking across different axes doesn't produce
        // meaningful values). Strip the stale chartStacked flag from
        // the wire so a hidden setting doesn't quietly persist.
        if (chartType === 'line' && chartOptions.multipleYAxis && chartOptions.chartStacked) {
          const { chartStacked: _drop, ...rest } = chartOptions;
          return rest;
        }
        return chartOptions;
      })(),
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

  // Single-value charts (gauge, value) render ONE column, so an
  // aggregation's "Field" can only sensibly be that same column — the
  // editor shows it disabled. Keep the stored value bound to it so the
  // record is correct rather than merely displayed correctly.
  //
  // This closes two silent-wrong-number holes: a blank field makes
  // applyAggregation return value:null (the chart falls back to row 0
  // while claiming an average), and a field pointing at a DIFFERENT
  // column aggregates data the chart never displays. Neither surfaces
  // an error.
  //
  // Only runs when an aggregation type that consumes a field is
  // selected, so it can't resurrect a stale field on a 'none'/'count'
  // config, and only writes on an actual mismatch to avoid a render loop.
  const singleValueColumn = SINGLE_VALUE_CHART_TYPES.has(chartType) ? (yAxisColumns[0] || '') : null;
  useEffect(() => {
    if (singleValueColumn == null) return;
    const needsField = AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.needsField;
    if (!needsField) return;
    if (aggregation.field !== singleValueColumn) {
      setAggregation(prev => ({ ...prev, field: singleValueColumn }));
    }
  }, [singleValueColumn, aggregation.type, aggregation.field]);

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
            {/* Title field with the show-title toggle anchored in its
                label row (label left, toggle right — no redundant "Show
                title" text). Toggling off suppresses the rendered title
                band on the chart (reclaiming its vertical space) AND
                hides this input, since the value is then unused; the
                label row stays so the toggle remains reachable to turn
                it back on. Default ON (showTitle !== false). Stored on
                options.showTitle so it persists / snapshots / dirty-
                tracks with chartOptions. Honored uniformly by ChartShell
                + the non-ECharts views (ValueView, DataViewGrid). */}
            <div className="title-with-toggle">
              {/* No heading label — the toggle's inline state text carries
                  the meaning AND clarifies the effect is on the rendered
                  dashboard (not just the editor): "Title shown on
                  dashboard" when on, "Title hidden on dashboard" when off
                  (labelB = checked/on, labelA = off). The input drops
                  below, label-less; its helper text is dropped since the
                  toggle label now states what it does. */}
              <Toggle
                id="chart-show-title"
                size="sm"
                aria-label="Show title on dashboard"
                labelA="Title hidden on dashboard"
                labelB="Title shown on dashboard"
                toggled={chartOptions.showTitle !== false}
                onToggle={(checked) => updateChartOption('showTitle', checked)}
              />
              {chartOptions.showTitle !== false && (
                <TextInput
                  id="chart-title"
                  labelText="Title"
                  hideLabel
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={name || (componentType === 'control' ? 'Defaults to control name' : 'Defaults to chart name')}
                  size="md"
                />
              )}
            </div>
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
            {/* The per-component "accepts substitution" toggle was removed —
                substitution capabilities (the query pill + visual-builder
                "Dashboard variable" value type) now show whenever the
                deployment has dashboard variables enabled. The runtime keys on
                the {{dashboard-variable}} token's presence, not a flag; the
                stored uses_dashboard_variable field is still set on save (auto)
                for any future surface that wants the authoring-intent signal. */}
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
              <Button kind="tertiary" size="md" onClick={(e) => { e.stopPropagation(); setChartTypeModalOpen(true); }}>
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
          size="md"
          className="chart-type-modal"
        >
          <div className="chart-type-modal-body">
            {/* All chart types in one flowing grid, in CHART_TYPES
                order. Disabled types are hidden, but the active type
                stays visible so editing existing charts of that type
                still works. */}
            <div className="category-grid">
              {CHART_TYPES
                .filter(t => isChartTypeEnabled(t.id) || t.id === chartType)
                .map(type => {
                  const TypeIcon = type.icon;
                  return (
                    <div
                      key={type.id}
                      className={`chart-type-option ${chartType === type.id ? 'selected' : ''}`}
                      onClick={() => {
                        handleChartTypeChange(type.id);
                        setShowCustomCode(type.id === 'custom');
                        setChartTypeModalOpen(false);
                      }}
                    >
                      {TypeIcon && <TypeIcon size={24} className="type-icon" />}
                      <div className="type-label">{type.label}</div>
                      <div className="type-description">{type.description}</div>
                    </div>
                  );
                })}
            </div>
          </div>
        </Modal>,
        document.body
      )}

      {/* Connection picker — modeled on the connections list (sortable table,
          same filters), trimmed for selection. Portaled to escape the parent
          editor modal. On select, routes through handleDatasourceChange so the
          type-dependent editor state updates exactly as the old dropdown did. */}
      {connectionPickerOpen && createPortal(
        <ConnectionPickerModal
          open
          onClose={() => setConnectionPickerOpen(false)}
          onSelect={(conn) => {
            // The editor's own connections list is capped (page_size 100); the
            // picker loads more. Merge the chosen connection in (for the tag
            // row / guidance that read from `connections`), and pass it
            // explicitly so handleDatasourceChange's type-based defaults fire
            // even before the async merge lands.
            setConnections((prev) =>
              prev.some((c) => c.id === conn.id) ? prev : [...prev, conn]);
            handleDatasourceChange(conn.id, conn);
          }}
          selectedId={selectedConnectionId}
        />,
        document.body
      )}

      {/* Dashboard-variable value picker — distinct values from the connection.
          Portaled to escape the parent editor modal. On select, sets the
          preview value and remembers the column/table for the variable's
          runtime discovery config. */}
      {valuePickerOpen && createPortal(
        <VariableValuePickerModal
          open
          onClose={() => setValuePickerOpen(false)}
          onSelect={(value) => {
            // Remember the value for the live-preview render path, auto-enable
            // the substitution flag (the author clearly intends it), close the
            // picker, and run the real query with the chosen value.
            setPreviewVariableValue(value);
            setUsesDashboardVariable(true);
            setValuePickerOpen(false);
            fetchPreviewData(value);
          }}
          connectionId={selectedConnectionId}
          column={derivedVariableColumn.column}
          table={derivedVariableColumn.table}
          database={edgelakeDatabase}
          schemaColumns={availableColumns}
        />,
        document.body
      )}

      {/* Client-mode value picker — for a client-side filter bound to the
          variable. Populated from the rows just captured (uniqued in the
          browser); no server fetch. On select we remember the preview value
          (filteredPreviewData re-filters the captured rows to it) and, for
          stream-like connections, persist the list onto the connection so the
          dashboard dropdown can read it without a costly view-time capture.
          Persistence is design-gated server-side; a viewer's 403 is swallowed. */}
      {clientValuePickerOpen && createPortal(
        <VariableValuePickerModal
          open
          onClose={() => { stopClientCapture(); setClientValuePickerOpen(false); }}
          onSelect={(value) => {
            setPreviewVariableValue(value);
            setUsesDashboardVariable(true);
            setClientValuePickerOpen(false);
            if (shouldPersistDiscovered && selectedConnectionId && clientDiscoveredColumn) {
              apiClient.saveDiscoveredValues(selectedConnectionId, {
                column: clientDiscoveredColumn,
                values: clientDiscoveredValues,
                partial: clientDiscoveredPartial,
              }).catch(() => { /* design-gated; viewers can't persist — ignore */ });
            }
          }}
          connectionId={selectedConnectionId}
          providedValues={clientDiscoveredValues}
          providedPartial={clientDiscoveredPartial}
          providedLoading={clientCapturing}
          providedRecordCount={clientRecordCount}
          onStop={stopClientCapture}
        />,
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
          The Connection (Details) tab stays visible in custom-code mode
          because the connection + query + parser + sliding window all
          govern what `data` looks like at runtime — those fields aren't
          in the React code but they shape its input, so the user must be
          able to edit them. Inside the tab, the data-mapping and chart-
          options subsections hide themselves when in custom-code mode
          (the user controls those things directly in their JSX, so the
          form values are no longer load-bearing). The Code tab's runtime
          summary links back here via "Edit in Connection tab". */}
      {componentType === 'chart' && (() => {
        const tabs = [
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
                {/* Connection picker: a Change button opens a modal (modeled
                    on the connections list) to select; the chosen connection
                    is shown inline as "name (type)". Replaces the old inline
                    Select dropdown. */}
                <div className="connection-picker-control">
                  <Button
                    kind="tertiary"
                    size="md"
                    onClick={() => setConnectionPickerOpen(true)}
                  >
                    {selectedDatasource ? 'Change' : 'Select'}
                  </Button>
                  <span className="connection-picker-selected">
                    {selectedDatasource
                      ? `${selectedDatasource.name} (${selectedDatasource.type})`
                      : 'No connection selected'}
                  </span>
                </div>
                {selectedDatasource && (() => {
                  // Type tag first, then the connection's user tags,
                  // deduped (a user tag equal to the type tag shows once).
                  // ConnectionTagsRow fits as many as the row width allows
                  // and collapses the rest into a +N… toggletip — no fixed
                  // cap, so tags aren't hidden when there's room.
                  const seen = new Set();
                  const chips = [selectedDatasource.type, ...(Array.isArray(selectedDatasource.tags) ? selectedDatasource.tags : [])]
                    .filter((t) => {
                      if (!t || seen.has(t)) return false;
                      seen.add(t);
                      return true;
                    });
                  return <ConnectionTagsRow tags={chips} />;
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
                            <SelectItem value="range" text="Time range (from–to)" />
                            <SelectItem value="latest" text="Current State (latest per series)" />
                          </Select>
                        </div>
                        {tsstoreQueryType === 'latest' ? (
                          // ts-store v0.19.0 latest_by: one row per distinct
                          // value of this field — each its newest record.
                          <div className="tsstore-query-row__col">
                            <TextInput
                              id="tsstore-latest-by"
                              labelText="Series field"
                              placeholder="e.g. container"
                              value={tsstoreLatestBy}
                              onChange={(e) => setTsstoreLatestBy(e.target.value)}
                              helperText="One row per distinct value — its newest record"
                            />
                          </div>
                        ) : tsstoreQueryType === 'since' ? (
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
                              <SelectItem value="14d" text="Last 14 days" />
                              <SelectItem value="30d" text="Last 30 days" />
                            </Select>
                          </div>
                        ) : tsstoreQueryType === 'range' ? (
                          // Absolute from→to window — two native datetime-local inputs.
                          // Each occupies a half-row col like the since/limit controls.
                          <>
                            <div className="tsstore-query-row__col">
                              <TextInput
                                id="tsstore-range-from"
                                labelText="From"
                                type="datetime-local"
                                value={tsstoreRangeFrom}
                                onChange={(e) => setTsstoreRangeFrom(e.target.value)}
                              />
                            </div>
                            <div className="tsstore-query-row__col">
                              <TextInput
                                id="tsstore-range-to"
                                labelText="To"
                                type="datetime-local"
                                value={tsstoreRangeTo}
                                onChange={(e) => setTsstoreRangeTo(e.target.value)}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="tsstore-query-row__col">
                            <NumberInput
                              id="tsstore-limit"
                              label="Number of Records"
                              value={tsstoreLimit}
                              allowEmpty
                              onChange={(e, { value }) => setTsstoreLimit(value === '' || value == null ? 1 : value)}
                              min={1}
                              max={10000}
                            />
                          </div>
                        )}
                      </div>
                      {/* Source-side FILTER row — mirrors the SQL WHERE
                          value-source pattern: [Value | Dashboard variable]
                          then the value (literal text or a bound-variable
                          chip). ts-store's filter is a plain SUBSTRING over
                          the whole record (NOT field-scoped); the targeted
                          data sets have very few label fields, so a general
                          substring is fine. Applied at the source so a
                          variable-filtered limited/streaming query returns
                          full per-value history (#18). */}
                      <div className="tsstore-query-row tsstore-filter-row">
                        <div className="tsstore-query-row__col tsstore-filter-col">
                          <label className="cds--label" htmlFor="tsstore-filter-value">Filter (substring, optional)</label>
                          <div className="tsstore-filter-controls">
                            {dashboardVariableEnabled && (
                              <Select
                                id="tsstore-filter-source"
                                labelText=""
                                hideLabel
                                size="md"
                                value={tsstoreFilterSource}
                                onChange={(e) => setTsstoreFilterSource(e.target.value)}
                                className="tsstore-filter-source-select"
                              >
                                <SelectItem value="literal" text="Value" />
                                <SelectItem value="variable" text="Dashboard variable" />
                              </Select>
                            )}
                            {tsstoreFilterSource === 'variable' ? (
                              <Tag type="purple" size="md" className="value-variable-chip" title="Bound to the dashboard variable at view time">
                                {DASHBOARD_VARIABLE_TOKEN}
                              </Tag>
                            ) : (
                              <TextInput
                                id="tsstore-filter-value"
                                labelText=""
                                hideLabel
                                size="md"
                                placeholder="e.g. Warehouse"
                                value={tsstoreFilter}
                                onChange={(e) => setTsstoreFilter(e.target.value)}
                                className="tsstore-filter-value-input"
                              />
                            )}
                          </div>
                          <Checkbox
                            id="tsstore-filter-ignore-case"
                            labelText="Ignore case"
                            checked={tsstoreFilterIgnoreCase}
                            onChange={(_, { checked }) => setTsstoreFilterIgnoreCase(checked)}
                          />
                          <p className="editor-info-hint">
                            Matches records containing this text anywhere in the
                            record (substring, not field-specific), filtered at the
                            source. Binding it to the dashboard variable returns full
                            history for the selected value.
                          </p>
                        </div>
                      </div>
                    </div>
                  ) : selectedDatasource.type === 'sql' && queryMode === 'visual' ? (
                    (() => {
                      // Pre-check importability BEFORE mounting the builder. If
                      // there's a non-empty raw query the visual builder can't
                      // represent, show a warning + "Switch to Raw" instead of
                      // mounting the builder — which would otherwise fire a slow
                      // schema fetch (and a "Schema Error — timed out") under an
                      // empty form the user shouldn't be looking at. (#52)
                      const importCheck = queryRaw?.trim() ? parseSimpleQuery(queryRaw) : { ok: true };
                      if (!importCheck.ok) {
                        return (
                          <div className="query-import-blocked">
                            <InlineNotification
                              kind="warning"
                              title="This query can't be edited in the visual builder"
                              subtitle={`${importCheck.reason}. Your raw query is unchanged — edit it in Raw mode.`}
                              hideCloseButton
                              lowContrast
                              style={{ marginBottom: '0.5rem' }}
                            />
                            <Button kind="tertiary" size="sm" onClick={() => setQueryMode('raw')}>
                              Switch to Raw mode
                            </Button>
                          </div>
                        );
                      }
                      return (
                        <SQLQueryBuilder
                          connectionId={selectedConnectionId}
                          allowDashboardVariable={dashboardVariableEnabled}
                          allowRangeVariable={dashboardVariableEnabled}
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
                      );
                    })()
                  ) : selectedDatasource.type === 'prometheus' && queryMode === 'visual' ? (
                    <PrometheusQueryBuilder
                      connectionId={selectedConnectionId}
                      onQueryChange={(query) => setQueryRaw(query)}
                      onParamsChange={(params) => {
                        // Capture the builder's instant/range + window/step into
                        // the shared Prometheus state so they reach
                        // query_config.params on save. (Previously a no-op stub —
                        // the params were silently dropped → adapter defaulted to
                        // range even for instant charts.)
                        if (params?.query_type) setPromQueryType(params.query_type);
                        if (typeof params?.start === 'string' && params.start.startsWith('now-')) {
                          setPromTimeRange(params.start.slice(4));
                        }
                        if (params?.step) setPromStep(params.step);
                      }}
                      initialParams={{ query_type: promQueryType, time_range: promTimeRange, step: promStep }}
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
                  ) : activeQuerySurface?.kind === 'catalog' ? (
                    /* Catalog surface — the adapter declared a fixed set of
                       named queries, so the user picks WHAT TO LOOK AT and the
                       preset carries the dispatch params (for Synology DSM:
                       method / version / result_path / additional).
                       Those are mechanics, not knobs: getting one wrong makes
                       the API error or return an unchartable shape, so they are
                       deliberately never rendered as inputs. Keyed on the
                       declared surface rather than on a connection type, so the
                       next adapter to declare one renders here for free. */
                    <div className="query-catalog-section">
                      <Select
                        id="query-catalog-preset"
                        labelText={activeQuerySurface.label || 'Query'}
                        value={selectedQueryPreset?.id || ''}
                        helperText={
                          selectedQueryPreset?.description || activeQuerySurface.description || ''
                        }
                        onChange={(e) => {
                          const preset = (activeQuerySurface.presets || []).find(
                            (p) => p.id === e.target.value
                          );
                          setSelectedQueryPreset(preset || null);
                          // Raw and params both come from the preset. Clearing
                          // the passthrough is what lets a user CHANGE the API
                          // on an existing component — otherwise the stored
                          // params would keep overriding the new choice.
                          setQueryRaw(preset?.raw || '');
                          setPassthroughQueryParams(null);
                          // Columns belong to the previous API's shape.
                          setPreviewData(null);
                          setPreviewError(null);
                          setAvailableColumns([]);
                        }}
                      >
                        <SelectItem value="" text="Select a query…" />
                        {(activeQuerySurface.presets || []).map((preset) => (
                          <SelectItem key={preset.id} value={preset.id} text={preset.label} />
                        ))}
                      </Select>
                      {/* A component authored before this catalog existed (or
                          against an API outside it) matches no preset. Say so
                          plainly instead of showing an empty picker that looks
                          like data loss — its stored query still round-trips
                          and still runs. */}
                      {!selectedQueryPreset && queryRaw && (
                        <InlineNotification
                          kind="info"
                          lowContrast
                          hideCloseButton
                          title="Custom query"
                          subtitle={`This component queries "${queryRaw}", which isn't one of the presets. It keeps working as saved; picking a preset above replaces it.`}
                          style={{ marginTop: '0.5rem', maxWidth: '100%' }}
                        />
                      )}
                    </div>
                  ) : (
                    <>
                      {/* EdgeLake Raw mode needs a database parameter
                          (AnyLog routes by database — the adapter
                          wraps the bare SQL as `sql <db> format=json
                          "…"` server-side). Use a Select populated
                          from list_edgelake_databases so the user
                          doesn't have to remember the exact name;
                          constrained to half the row width since
                          database names are short. */}
                      {selectedDatasource.type === 'edgelake' && (
                        <div className="edgelake-database-row">
                          <Select
                            id="edgelake-database"
                            labelText="Database"
                            value={edgelakeDatabase}
                            onChange={(e) => setEdgelakeDatabase(e.target.value)}
                            disabled={edgelakeDatabasesLoading}
                            helperText={
                              edgelakeDatabasesLoading
                                ? 'Loading databases…'
                                : 'EdgeLake routes queries by database name.'
                            }
                          >
                            <SelectItem value="" text={edgelakeDatabasesLoading ? 'Loading…' : 'Select a database…'} />
                            {edgelakeDatabasesList.map((db) => (
                              <SelectItem key={db} value={db} text={db} />
                            ))}
                            {/* If the saved value isn't in the
                                list (e.g. the list fetch failed,
                                or the DB was renamed), keep it as
                                a fallback option so the form
                                doesn't silently clear it. */}
                            {edgelakeDatabase && !edgelakeDatabasesList.includes(edgelakeDatabase) && (
                              <SelectItem value={edgelakeDatabase} text={`${edgelakeDatabase} (not in list)`} />
                            )}
                          </Select>
                        </div>
                      )}
                      <TextArea
                        id="query-raw"
                        ref={queryRawRef}
                        labelText={getQueryLabelForType(selectedDatasource.type)}
                        value={queryRaw}
                        onChange={(e) => setQueryRaw(e.target.value)}
                        placeholder={getQueryPlaceholderForType(selectedDatasource.type)}
                        rows={selectedDatasource.type === 'api' || selectedDatasource.type === 'mqtt' ? 1 : 6}
                        className={`query-textarea ${selectedDatasource.type === 'api' || selectedDatasource.type === 'mqtt' ? 'query-textarea--compact' : ''}`}
                      />
                      {/* Substitution pills — click to drop a dashboard-variable
                          token into the query at the cursor. Shown when the
                          deployment has dashboard variables enabled, so the
                          author can author a variable-driven query. Fetching a
                          query that contains the token opens the value picker
                          automatically (no separate "set a value" step). Sits
                          directly under the query box, ABOVE the Prometheus
                          query-type radios. */}
                      {dashboardVariableEnabled && (
                        <VariablePills
                          tokens={DASHBOARD_VARIABLE_TOKENS}
                          onInsert={insertTokenIntoQuery}
                          hint="Insert variable:"
                        />
                      )}
                      {/* Prometheus query type — raw (PromQL) mode. Single
                          Instance = a snapshot (current value per series; pick
                          for gauges, number tiles, "current value per label"
                          bars). Range = a time series. Time Range + Step appear
                          to the RIGHT of the radios ONLY for Range — they're
                          meaningless for a single instant. Quarter-row layout:
                          radios | time range | step | (empty). Without this the
                          params saved empty and the adapter defaulted to range,
                          producing repeating timestamps on a snapshot. */}
                      {selectedDatasource.type === 'prometheus' && (
                        <div className="prometheus-query-type">
                          <div className="prometheus-query-type__row">
                            <div className="prometheus-query-type__col">
                              <RadioButtonGroup
                                legendText="Query type"
                                name="prom-query-type"
                                valueSelected={promQueryType}
                                onChange={(value) => setPromQueryType(value)}
                              >
                                <RadioButton labelText="Single Instance" value="instant" id="prom-qt-instant" />
                                <RadioButton labelText="Range" value="range" id="prom-qt-range" />
                              </RadioButtonGroup>
                            </div>
                            {promQueryType === 'range' && (
                              <>
                                <div className="prometheus-query-type__col">
                                  <Select
                                    id="prom-time-range"
                                    labelText="Time Range"
                                    value={promTimeRange}
                                    onChange={(e) => setPromTimeRange(e.target.value)}
                                  >
                                    <SelectItem value="5m" text="Last 5 minutes" />
                                    <SelectItem value="15m" text="Last 15 minutes" />
                                    <SelectItem value="30m" text="Last 30 minutes" />
                                    <SelectItem value="1h" text="Last 1 hour" />
                                    <SelectItem value="3h" text="Last 3 hours" />
                                    <SelectItem value="6h" text="Last 6 hours" />
                                    <SelectItem value="12h" text="Last 12 hours" />
                                    <SelectItem value="24h" text="Last 24 hours" />
                                    <SelectItem value="2d" text="Last 2 days" />
                                    <SelectItem value="7d" text="Last 7 days" />
                                  </Select>
                                </div>
                                <div className="prometheus-query-type__col">
                                  <Select
                                    id="prom-step"
                                    labelText="Step"
                                    value={promStep}
                                    onChange={(e) => setPromStep(e.target.value)}
                                  >
                                    <SelectItem value="15s" text="15s" />
                                    <SelectItem value="30s" text="30s" />
                                    <SelectItem value="1m" text="1m" />
                                    <SelectItem value="5m" text="5m" />
                                    <SelectItem value="15m" text="15m" />
                                    <SelectItem value="1h" text="1h" />
                                  </Select>
                                </div>
                                <div className="prometheus-query-type__col" aria-hidden="true" />
                              </>
                            )}
                          </div>
                          <p className="editor-info-hint prometheus-query-type__hint">
                            Single Instance returns one current value per series
                            (gauges, number tiles, current-value-per-label bars).
                            Range returns a time series over the selected window.
                          </p>
                        </div>
                      )}
                    </>
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


                {!showCustomCode && chartType === 'gauge' && getChartTypeSpec('gauge') && (
                  <SpecDrivenSections
                    spec={getChartTypeSpec('gauge')}
                    availableColumns={availableColumns}
                    formState={{
                      y_axis_0: yAxisColumns[0] || '',
                      gauge_min: chartOptions.gaugeMin,
                      gauge_max: chartOptions.gaugeMax,
                      gauge_warning_threshold: chartOptions.gaugeWarningThreshold,
                      gauge_danger_threshold: chartOptions.gaugeDangerThreshold,
                      gauge_unit: chartOptions.gaugeUnit,
                      gauge_decimals: chartOptions.gaugeDecimals ?? 'auto',
                      // Style is DERIVED from the values, never read from the
                      // stored gaugeStyle marker — that's what flips the
                      // dropdown to "Custom" the moment any governed field is
                      // tuned, and what makes a pre-styles record (no keys at
                      // all) correctly report as Classic.
                      gauge_style: resolveGaugeStyle(chartOptions),
                      // Every appearance field falls back to its CLASSIC value
                      // so an existing gauge shows the values it actually
                      // renders with, not the Modern defaults.
                      gauge_line_thickness: chartOptions.gaugeLineThickness ?? CLASSIC_GAUGE_STYLE.gaugeLineThickness,
                      gauge_arc_mode: chartOptions.gaugeArcMode ?? CLASSIC_GAUGE_STYLE.gaugeArcMode,
                      gauge_start_angle: chartOptions.gaugeStartAngle ?? CLASSIC_GAUGE_STYLE.gaugeStartAngle,
                      gauge_end_angle: chartOptions.gaugeEndAngle ?? CLASSIC_GAUGE_STYLE.gaugeEndAngle,
                      gauge_radius: chartOptions.gaugeRadius ?? CLASSIC_GAUGE_STYLE.gaugeRadius,
                      gauge_show_split_line: chartOptions.gaugeShowSplitLine ?? CLASSIC_GAUGE_STYLE.gaugeShowSplitLine,
                      gauge_show_axis_label: chartOptions.gaugeShowAxisLabel ?? CLASSIC_GAUGE_STYLE.gaugeShowAxisLabel,
                      gauge_show_pointer: chartOptions.gaugeShowPointer ?? CLASSIC_GAUGE_STYLE.gaugeShowPointer,
                      // Pointer geometry is null in Classic ("ECharts default").
                      // The sliders can't render null, so they show the Modern
                      // values as a starting point — picking one then writes a
                      // concrete number, which is the intent of touching it.
                      gauge_pointer_length: chartOptions.gaugePointerLength ?? MODERN_GAUGE_STYLE.gaugePointerLength,
                      gauge_pointer_width: chartOptions.gaugePointerWidth ?? MODERN_GAUGE_STYLE.gaugePointerWidth,
                      gauge_show_anchor: chartOptions.gaugeShowAnchor ?? CLASSIC_GAUGE_STYLE.gaugeShowAnchor,
                      gauge_value_font_size: chartOptions.gaugeValueFontSize ?? CLASSIC_GAUGE_STYLE.gaugeValueFontSize,
                      gauge_value_offset: chartOptions.gaugeValueOffset ?? CLASSIC_GAUGE_STYLE.gaugeValueOffset,
                      gauge_label: chartOptions.gaugeLabel ?? CLASSIC_GAUGE_STYLE.gaugeLabel,
                      gauge_label_font_size: chartOptions.gaugeLabelFontSize ?? CLASSIC_GAUGE_STYLE.gaugeLabelFontSize,
                      gauge_label_offset: chartOptions.gaugeLabelOffset ?? CLASSIC_GAUGE_STYLE.gaugeLabelOffset,
                    }}
                    onFieldChange={(fieldId, value) => {
                      switch (fieldId) {
                        case 'y_axis_0':
                          setYAxisColumns(value ? [value] : []);
                          break;
                        case 'gauge_min': updateChartOption('gaugeMin', value); break;
                        case 'gauge_max': updateChartOption('gaugeMax', value); break;
                        case 'gauge_warning_threshold': updateChartOption('gaugeWarningThreshold', value); break;
                        case 'gauge_danger_threshold': updateChartOption('gaugeDangerThreshold', value); break;
                        case 'gauge_unit': updateChartOption('gaugeUnit', value); break;
                        case 'gauge_decimals': updateChartOption('gaugeDecimals', value); break;
                        // Selecting a style overwrites the whole appearance set
                        // in ONE state update. Doing it via repeated
                        // updateChartOption calls would queue N updates against
                        // a stale closure and land only the last one.
                        // 'custom' isn't a real preset — applyGaugeStyle returns
                        // {} for it, so choosing it is a no-op rather than a
                        // reset to nothing.
                        case 'gauge_style':
                          setChartOptions((prev) => ({ ...prev, ...applyGaugeStyle(value) }));
                          break;
                        case 'gauge_line_thickness': updateChartOption('gaugeLineThickness', value); break;
                        case 'gauge_arc_mode': updateChartOption('gaugeArcMode', value); break;
                        case 'gauge_start_angle': updateChartOption('gaugeStartAngle', value); break;
                        case 'gauge_end_angle': updateChartOption('gaugeEndAngle', value); break;
                        case 'gauge_radius': updateChartOption('gaugeRadius', value); break;
                        case 'gauge_show_split_line': updateChartOption('gaugeShowSplitLine', value); break;
                        case 'gauge_show_axis_label': updateChartOption('gaugeShowAxisLabel', value); break;
                        case 'gauge_show_pointer': updateChartOption('gaugeShowPointer', value); break;
                        case 'gauge_pointer_length': updateChartOption('gaugePointerLength', value); break;
                        case 'gauge_pointer_width': updateChartOption('gaugePointerWidth', value); break;
                        case 'gauge_show_anchor': updateChartOption('gaugeShowAnchor', value); break;
                        case 'gauge_value_font_size': updateChartOption('gaugeValueFontSize', value); break;
                        case 'gauge_value_offset': updateChartOption('gaugeValueOffset', value); break;
                        case 'gauge_label': updateChartOption('gaugeLabel', value); break;
                        case 'gauge_label_font_size': updateChartOption('gaugeLabelFontSize', value); break;
                        case 'gauge_label_offset': updateChartOption('gaugeLabelOffset', value); break;
                        default: break;
                      }
                    }}
                  />
                )}

                {/* Spec-driven sections for line (Stage 2). When the
                    editor flag is on AND the chart_type has a spec,
                    render its sections (Data Mapping, Chart Options,
                    Performance, Y-axis ranges, Tooltip, Legend,
                    Thresholds). The legacy Bar/Line/Area block below
                    is suppressed for line in that case to avoid
                    rendering both. Bar and area continue to use the
                    legacy block until they migrate. */}
                {!showCustomCode && ['line', 'bar', 'area', 'pie', 'scatter', 'banded_bar', 'value', 'number', 'dataview'].includes(chartType) && getChartTypeSpec(chartType) && (
                  <SpecDrivenSections
                    spec={getChartTypeSpec(chartType)}
                    availableColumns={availableColumns}
                    // The dataview column manager instantiates the REAL grid
                    // so the author sizes columns against their own data
                    // (#214). No other field type reads this.
                    previewData={previewData}
                    formState={{
                      // data_mapping. multipleYAxis is purely the user's
                      // explicit choice (gated on the chart_type being
                      // dual-axis capable). It defaults OFF and is only
                      // turned on when the user flips the toggle — adding a
                      // second column does NOT auto-engage dual-axis. (We
                      // dropped the old "2 columns ⇒ dual-axis by
                      // convention" fallback; any pre-existing 2-column
                      // chart that relied on it now renders single-axis
                      // until the toggle is flipped.)
                      multipleYAxis: chartTypeConfig.multipleYAxis
                        && Boolean(chartOptions.multipleYAxis),
                      y_axis_columns: yAxisColumns.map((col, i) => ({
                        column: col,
                        // Per-column user-facing label sourced from the
                        // existing yAxisLabels array (index-aligned to
                        // yAxisColumns). Empty falls back to the column
                        // name at render time.
                        label: (Array.isArray(yAxisLabels) ? yAxisLabels[i] : '') || '',
                        stack: Boolean(chartOptions.chartStacked),
                        axis: i === 1 && chartOptions.multipleYAxis ? 'right' : 'left',
                        // Per-column color override (index-aligned yAxisColors).
                        color: (Array.isArray(yAxisColors) ? yAxisColors[i] : '') || '',
                        // Per-column accumulator/delta flag (#8), index-aligned.
                        accumulate: (Array.isArray(yAxisAccumulate) ? yAxisAccumulate[i] : false) === true,
                      })),
                      x_axis_column: xAxisColumn,
                      x_axis_label: xAxisLabel || '',
                      x_axis_format: xAxisFormat || 'auto',
                      series_column: seriesColumn,
                      // accumulator/delta (#8). any_accumulator gates the
                      // reset-policy subsection's visibility (shown only when at
                      // least one column has Δ Delta ticked).
                      any_accumulator: Array.isArray(yAxisAccumulate) && yAxisAccumulate.some(Boolean),
                      accumulator_reset_policy: accumulatorResetPolicy,
                      // pie field ids — label binds to x_axis, value to
                      // y_axis[0]; map the shared state onto pie's ids so
                      // ColumnSelect (keyed by field.id) shows the saved
                      // selection.
                      label_column: xAxisColumn,
                      value_column: (Array.isArray(yAxisColumns) ? yAxisColumns[0] : '') || '',
                      pie_inner_radius: chartOptions.pieInnerRadius ?? 0,
                      pie_show_labels: chartOptions.pieShowLabels !== false,
                      // scatter field ids
                      y_axis_label: yAxisLabel || '',
                      size_column: chartOptions.sizeColumn || '',
                      symbol_size: chartOptions.symbolSize ?? 15,
                      symbol_shape: chartOptions.symbolShape || 'circle',
                      x_min: chartOptions.xAxisRange?.min ?? null,
                      x_max: chartOptions.xAxisRange?.max ?? null,
                      x_scale: chartOptions.xAxisRange?.scale || 'linear',
                      // chart_options
                      chart_smooth: chartOptions.chartSmooth !== false,
                      chart_show_data_labels: Boolean(chartOptions.chartShowDataLabels),
                      chart_si_prefixes: chartOptions.chartSiPrefixes !== false,
                      chart_show_zoom_slider: Boolean(chartOptions.chartShowZoomSlider),
                      x_axis_label_rotate: chartOptions.xAxisLabelRotate ?? 0,
                      show_symbol: chartOptions.showSymbol !== false,
                      // bar
                      bar_orientation: chartOptions.barOrientation || 'vertical',
                      bar_width_pct: chartOptions.barWidthPct ?? null,
                      // perf
                      sampling: chartOptions.sampling || 'off',
                      // y range
                      y_left_min: chartOptions.yAxisRange?.left?.min ?? null,
                      y_left_max: chartOptions.yAxisRange?.left?.max ?? null,
                      y_left_scale: chartOptions.yAxisRange?.left?.scale || 'linear',
                      y_right_min: chartOptions.yAxisRange?.right?.min ?? null,
                      y_right_max: chartOptions.yAxisRange?.right?.max ?? null,
                      y_right_scale: chartOptions.yAxisRange?.right?.scale || 'linear',
                      // tooltip
                      tooltip_mode: chartOptions.tooltip?.mode || 'multi',
                      tooltip_decimals: chartOptions.tooltip?.decimals ?? null,
                      tooltip_units: chartOptions.tooltip?.units || '',
                      // legend
                      legend_show: chartOptions.legend?.show !== false,
                      legend_position: chartOptions.legend?.position || 'top',
                      legend_width_mode: chartOptions.legend?.widthMode || 'auto',
                      legend_width_px: chartOptions.legend?.width ?? 135,
                      legend_overflow: chartOptions.legend?.overflow || 'wrap',
                      // Derived gates for the legend-width fields (single-clause
                      // visibleWhen can't express "shown AND side AND manual").
                      legend_side_position: chartOptions.legend?.show !== false
                        && (chartOptions.legend?.position === 'left' || chartOptions.legend?.position === 'right'),
                      legend_manual_side: chartOptions.legend?.show !== false
                        && (chartOptions.legend?.position === 'left' || chartOptions.legend?.position === 'right')
                        && (chartOptions.legend?.widthMode || 'auto') === 'manual',
                      // thresholds
                      y_thresholds: Array.isArray(chartOptions.yThresholds) ? chartOptions.yThresholds : [],
                      y_threshold_render_mode: chartOptions.yThresholdRenderMode || 'line',
                      // banded_bar: the band_scheme field type owns the
                      // scheme selector + per-scheme column pickers, fed the
                      // whole bandColumns object ({ scheme, ...mappings }).
                      // The visual style maps onto bandedBarStyle.
                      // (x_axis_column / x_axis_format above are reused by
                      // banded_bar's timestamp fields.)
                      band_scheme: bandColumns,
                      banded_bar_style: bandedBarStyle || 'time_series',
                      // value field ids. value_column reuses the shared
                      // case above (maps to yAxisColumns[0]). Size is an
                      // enum (string-valued options) so stringify the
                      // stored number; unit is free text. The `?? number*`
                      // reads are the accept-old fallback for a record
                      // that escaped the boot migration.
                      // value_type drives which Display row renders
                      // (numeric vs text). 'auto' = infer from the data.
                      value_type: chartOptions.valueType ?? 'auto',
                      value_text_case: chartOptions.valueTextCase ?? 'none',
                      // Threshold coloring (#36) — numeric bands and
                      // text match-rules are separate lists.
                      value_thresholds: Array.isArray(chartOptions.valueThresholds) ? chartOptions.valueThresholds : [],
                      value_text_thresholds: Array.isArray(chartOptions.valueTextThresholds) ? chartOptions.valueTextThresholds : [],
                      // Background fill (#214). Applies to both value types,
                      // so it binds one key regardless of the numeric/text
                      // split above.
                      value_background: chartOptions.valueBackground ?? '',
                      // Both size fields bind the SAME stored key — only
                      // one is ever visible, so the size survives a
                      // number↔text switch.
                      value_size: String(chartOptions.valueSize ?? chartOptions.numberSize ?? 56),
                      value_size_text: String(chartOptions.valueSize ?? chartOptions.numberSize ?? 56),
                      value_unit: chartOptions.valueUnit ?? chartOptions.numberUnit ?? '',
                      // Decimal places enum. Stored as a string ('auto' |
                      // '0'..'4'); default 'auto' keeps the auto formatter.
                      value_decimals: chartOptions.valueDecimals ?? chartOptions.numberDecimals ?? 'auto',
                      // Value-format enum + date sub-format (number-formats.js).
                      value_format: chartOptions.valueFormat ?? chartOptions.numberFormat ?? 'auto',
                      value_date_format: chartOptions.valueDateFormat ?? chartOptions.numberDateFormat ?? 'datetime',
                      // Source unit: what the STORED number already is (a
                      // megabytes column needs ×1e6 before SI, else 123456
                      // MB reads "123.5k" instead of "123.5G"). 'none' is
                      // the no-scaling default, so untouched records are
                      // unaffected.
                      value_source_unit: chartOptions.valueSourceUnit ?? chartOptions.numberSourceUnit ?? 'none',
                      // Where a matched threshold's color lands (text |
                      // background | both). Numeric and text value types each
                      // render their own copy of the control, but there is ONE
                      // stored key — same pattern as value_size/value_size_text.
                      value_threshold_target: chartOptions.valueThresholdTarget ?? 'text',
                      value_threshold_target_text_field: chartOptions.valueThresholdTarget ?? 'text',
                      // dataview: the column_manager widget reads these
                      // keys directly (visible_columns null = show all).
                      visible_columns: visibleColumns,
                      column_aliases: columnAliases,
                      column_widths: columnWidths,
                      column_formats: columnFormats,
                      column_rules: columnRules,
                    }}
                    onFieldChange={(fieldId, value) => {
                      switch (fieldId) {
                        case 'multipleYAxis': {
                          // Soft block: turning ON with ≥3 columns already
                          // present refuses (helper text on the spec section
                          // explains "drop columns to 2 before switching").
                          if (value && yAxisColumns.length > 2) {
                            return;
                          }
                          // Persist the user's explicit choice on chartOptions.
                          // This is what the read path consults so the toggle
                          // round-trips correctly (off → off stays off).
                          updateChartOption('multipleYAxis', value);
                          // When turning ON with only one column picked, seed
                          // a second column so dual-axis has something on the
                          // right side. When turning OFF, leave the column
                          // count alone but normalize stored axis values to
                          // 'left' so saved data doesn't carry stale 'right'
                          // assignments from a previous dual-axis state.
                          if (value && yAxisColumns.length === 1 && availableColumns.length > 1) {
                            const next = availableColumns.find((c) => c !== yAxisColumns[0]);
                            if (next) setYAxisColumns([yAxisColumns[0], next]);
                          }
                          // Note: the y_axis_columns entries' axis fields are
                          // derived from chartOptions.multipleYAxis in the
                          // formState builder, so they re-render correctly on
                          // toggle. The actual saved record still uses the
                          // legacy flat yAxisColumns array, so there's no
                          // stale-axis field on disk.
                          break;
                        }
                        case 'y_axis_columns': {
                          // Free list of {column, label, stack, axis}.
                          //   - Push columns into yAxisColumns. Empty-column
                          //     entries (created by "+ Add column" before the
                          //     user picks one) are preserved as empty strings
                          //     so the row stays visible until the user picks
                          //     a column or removes it. Filtering them out
                          //     here would make the new row vanish on the
                          //     next render.
                          //   - Push per-row labels into yAxisLabels
                          //     (index-aligned to yAxisColumns).
                          //   - Best-effort translate "any entry stacked"
                          //     to the legacy single chartStacked toggle
                          //     until per-column stack lands in codegen.
                          const cols = (value || []).map((e) => (typeof e?.column === 'string' ? e.column : ''));
                          const labels = (value || []).map((e) => (typeof e?.label === 'string' ? e.label : ''));
                          const colors = (value || []).map((e) => (typeof e?.color === 'string' ? e.color : ''));
                          // Per-column accumulator/delta flag (#8), index-aligned.
                          const accum = (value || []).map((e) => e?.accumulate === true);
                          setYAxisColumns(cols);
                          setYAxisLabels(labels);
                          setYAxisColors(colors);
                          setYAxisAccumulate(accum);
                          const anyStacked = (value || []).some((e) => e?.stack);
                          updateChartOption('chartStacked', anyStacked);
                          break;
                        }
                        case 'x_axis_column': setXAxisColumn(value); break;
                        case 'x_axis_label': setXAxisLabel(value); break;
                        case 'x_axis_format': setXAxisFormat(value); break;
                        case 'series_column': setSeriesColumn(value); break;
                        case 'accumulator_reset_policy': setAccumulatorResetPolicy(value); break;
                        // Pie: label column binds to data_mapping.x_axis,
                        // value column to data_mapping.y_axis[0]. Map the
                        // pie-specific field ids onto the same state.
                        case 'label_column': setXAxisColumn(value); break;
                        case 'value_column': setYAxisColumns(value ? [value] : []); break;
                        case 'pie_inner_radius': updateChartOption('pieInnerRadius', value); break;
                        case 'pie_show_labels': updateChartOption('pieShowLabels', value); break;
                        // Scatter: y label uses the shared yAxisLabel state;
                        // size column + symbol style live on chartOptions;
                        // x-axis range is scatter-only (true value axis).
                        case 'y_axis_label': setYAxisLabel(value); break;
                        case 'size_column': updateChartOption('sizeColumn', value); break;
                        case 'symbol_size': updateChartOption('symbolSize', value); break;
                        case 'symbol_shape': updateChartOption('symbolShape', value); break;
                        case 'x_min':
                          updateChartOption('xAxisRange', { ...(chartOptions.xAxisRange || {}), min: value });
                          break;
                        case 'x_max':
                          updateChartOption('xAxisRange', { ...(chartOptions.xAxisRange || {}), max: value });
                          break;
                        case 'x_scale':
                          updateChartOption('xAxisRange', { ...(chartOptions.xAxisRange || {}), scale: value });
                          break;
                        case 'chart_smooth': updateChartOption('chartSmooth', value); break;
                        case 'chart_show_data_labels': updateChartOption('chartShowDataLabels', value); break;
                        case 'chart_si_prefixes': updateChartOption('chartSiPrefixes', value); break;
                        case 'chart_show_zoom_slider': updateChartOption('chartShowZoomSlider', value); break;
                        // Select values arrive as strings; store a number so the
                        // render's Number() coercion + axis rotate stay clean.
                        case 'x_axis_label_rotate': updateChartOption('xAxisLabelRotate', Number(value) || 0); break;
                        case 'show_symbol': updateChartOption('showSymbol', value); break;
                        case 'sampling': updateChartOption('sampling', value); break;
                        case 'bar_orientation': updateChartOption('barOrientation', value); break;
                        case 'bar_width_pct': updateChartOption('barWidthPct', value); break;
                        case 'y_left_min':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), left: { ...(chartOptions.yAxisRange?.left || {}), min: value } });
                          break;
                        case 'y_left_max':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), left: { ...(chartOptions.yAxisRange?.left || {}), max: value } });
                          break;
                        case 'y_left_scale':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), left: { ...(chartOptions.yAxisRange?.left || {}), scale: value } });
                          break;
                        case 'y_right_min':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), right: { ...(chartOptions.yAxisRange?.right || {}), min: value } });
                          break;
                        case 'y_right_max':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), right: { ...(chartOptions.yAxisRange?.right || {}), max: value } });
                          break;
                        case 'y_right_scale':
                          updateChartOption('yAxisRange', { ...(chartOptions.yAxisRange || {}), right: { ...(chartOptions.yAxisRange?.right || {}), scale: value } });
                          break;
                        case 'tooltip_mode':
                          updateChartOption('tooltip', { ...(chartOptions.tooltip || {}), mode: value });
                          break;
                        case 'tooltip_decimals':
                          updateChartOption('tooltip', { ...(chartOptions.tooltip || {}), decimals: value });
                          break;
                        case 'tooltip_units':
                          updateChartOption('tooltip', { ...(chartOptions.tooltip || {}), units: value });
                          break;
                        case 'legend_show':
                          updateChartOption('legend', { ...(chartOptions.legend || {}), show: value });
                          break;
                        case 'legend_position':
                          updateChartOption('legend', { ...(chartOptions.legend || {}), position: value });
                          break;
                        case 'legend_width_mode':
                          updateChartOption('legend', { ...(chartOptions.legend || {}), widthMode: value });
                          break;
                        case 'legend_width_px':
                          updateChartOption('legend', { ...(chartOptions.legend || {}), width: value });
                          break;
                        case 'legend_overflow':
                          updateChartOption('legend', { ...(chartOptions.legend || {}), overflow: value });
                          break;
                        case 'y_thresholds':
                          updateChartOption('yThresholds', value);
                          break;
                        case 'y_threshold_render_mode':
                          updateChartOption('yThresholdRenderMode', value);
                          break;
                        // banded_bar: the band_scheme widget writes the whole
                        // bandColumns object ({ scheme, ...mappings }) in one
                        // shot; the visual style writes bandedBarStyle.
                        // (x_axis_column / x_axis_format are handled by the
                        // shared cases above.)
                        case 'band_scheme':
                          setBandColumns(value || { scheme: 'sd' });
                          break;
                        case 'banded_bar_style':
                          setBandedBarStyle(value);
                          break;
                        // value: size enum stores back as a Number (legacy
                        // shape); unit is free text. (value_column is handled
                        // by the shared case above.)
                        case 'value_type':
                          updateChartOption('valueType', value);
                          break;
                        case 'value_text_case':
                          updateChartOption('valueTextCase', value);
                          break;
                        case 'value_thresholds':
                          updateChartOption('valueThresholds', value);
                          break;
                        case 'value_text_thresholds':
                          updateChartOption('valueTextThresholds', value);
                          break;
                        case 'value_background':
                          updateChartOption('valueBackground', value);
                          break;
                        // Both size fields write the same stored key —
                        // the numeric and text Display rows each carry
                        // their own field id, but there is one size.
                        case 'value_size':
                        case 'value_size_text':
                          updateChartOption('valueSize', Number(value));
                          break;
                        case 'value_unit':
                          updateChartOption('valueUnit', value);
                          break;
                        // decimals enum stored as the raw string ('auto' |
                        // '0'..'4'); value.js coerces. Keep it a string so
                        // '0' round-trips (Number('0')→0 would be fine but the
                        // spec options are string-valued, so stay consistent).
                        case 'value_decimals':
                          updateChartOption('valueDecimals', value);
                          break;
                        case 'value_format':
                          updateChartOption('valueFormat', value);
                          break;
                        case 'value_date_format':
                          updateChartOption('valueDateFormat', value);
                          break;
                        // Source-unit enum stored as the raw key ('none' |
                        // k/M/G/T | Ki/Mi/Gi/Ti); number-formats.js maps it
                        // to a multiplier. Kept a string so it round-trips
                        // through the spec options verbatim.
                        case 'value_source_unit':
                          updateChartOption('valueSourceUnit', value);
                          break;
                        // Both threshold-target fields write the SAME stored
                        // key — the numeric and text Color-thresholds rows each
                        // carry their own field id, but there is one setting,
                        // so it survives a number↔text switch.
                        case 'value_threshold_target':
                        case 'value_threshold_target_text_field':
                          updateChartOption('valueThresholdTarget', value);
                          break;
                        // dataview: the column_manager widget writes the
                        // visible-columns whitelist (null = show all) and
                        // the per-column alias map.
                        case 'visible_columns':
                          setVisibleColumns(value);
                          break;
                        case 'column_aliases':
                          setColumnAliases(value);
                          break;
                        case 'column_widths':
                          setColumnWidths(value);
                          break;
                        case 'column_formats':
                          setColumnFormats(value);
                          break;
                        case 'column_rules':
                          setColumnRules(value);
                          break;
                        default: break;
                      }
                    }}
                  />
                )}

                {/* Client Side Processing — one parent card grouping the
                    client-side transform panels (Filters, Aggregation &
                    Sorting, Sliding Window, Time Bucket) as subsections.
                    The parent renders only when at least one child would
                    show; each child keeps its own gate below. The
                    SQL/EdgeLake "query language owns these ops" gate
                    (queryLanguageOwnsClientSideOps) hides the first three;
                    Time Bucket is socket-streaming only. */}
                {!showCustomCode && (
                  (!queryLanguageOwnsClientSideOps && (
                    chartTypeConfig.hasFilters !== false ||
                    chartTypeConfig.hasAggregation !== false ||
                    chartTypeConfig.hasSlidingWindow !== false
                  )) ||
                  // Legacy client-side filters on a SQL/EdgeLake component
                  // (pre-gating saves) — keep the tile so the Filters
                  // subsection below can surface them.
                  (chartTypeConfig.hasFilters !== false && filters.length > 0) ||
                  (selectedDatasource?.type === 'socket' && chartTypeConfig.hasTimeBucket !== false)
                ) && (
                <CollapsibleTile title="Client Side Processing" className="spec-section client-side-processing">

                {/* ── SERVER-SIDE PROCESSING ──────────────────────────────
                    Runs in Go BEFORE data reaches the browser, so it changes
                    what data exists at all — not just what is rendered.
                    Placed above the client-side group for that reason. */}

                {/* Time Bucket Section - for socket streaming datasources
                    AND chart types that consume multi-row time series.
                    Single-value displays (gauge/number) opt out via
                    hasTimeBucket:false. */}
                {selectedDatasource?.type === 'socket' && chartTypeConfig.hasTimeBucket !== false && (
                  <div className="spec-subsection time-bucket-section">
                    <div className="section-header">
                      <h5 className="spec-subsection__heading">Time Bucket Aggregation (Streaming)</h5>
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
                              allowEmpty
                              onChange={(e, { value }) => setTimeBucketInterval(value === '' || value == null ? 1 : value)}
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
                              {sortedColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                          </Column>
                          <Column lg={3} md={4} sm={4}>
                            <div className="value-cols-selector">
                              <label className="cds--label">Value Columns to Aggregate</label>
                              <div className="column-tags">
                                {sortedColumns.filter(c => c !== timeBucketTimestampCol).map(col => (
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

                {/* ── CLIENT-SIDE PROCESSING ──────────────────────────────
                    Applied by transformData() to already-fetched data, in the
                    order these sections appear. The order matters and is not
                    commutative: the window bounds which records are in scope,
                    latest-by reduces those to one row per series, and only
                    then do filters/sort/limit/aggregation run over the result.
                    Keep this UI order in step with the pipeline in
                    utils/dataTransforms.js::transformData. */}

                {/* Sliding Window Section - for time-series data.
                    Hidden when the connection's query already
                    expresses time bounds (SQL WHERE ts > … /
                    EdgeLake equivalent) — re-querying with a new
                    time literal is the natural pattern for those
                    types. Also hidden for chart types that opt out
                    via hasSlidingWindow:false. */}
                {!showCustomCode && chartTypeConfig.hasSlidingWindow !== false && !queryLanguageOwnsClientSideOps && (
                <div className="spec-subsection sliding-window-section">
                  <div className="section-header">
                    <h5 className="spec-subsection__heading">Sliding Window (Time-Series)</h5>
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
                  {slidingWindowEnabled && (() => {
                    // The window needs a timestamp column, which only exists
                    // once a query has populated availableColumns (a saved
                    // column counts). Until then, BOTH controls are disabled
                    // and inert so the user can't set a length that can't be
                    // saved (save requires a timestamp col, else it silently
                    // drops the window). One helper line below explains why.
                    const windowNeedsQuery = availableColumns.length === 0 && !slidingWindowTimestampCol;
                    return (
                    <>
                    <Grid narrow>
                      <Column lg={6} md={4} sm={4}>
                        <Select
                          id="sliding-window-timestamp"
                          labelText="Timestamp Column"
                          value={slidingWindowTimestampCol}
                          onChange={(e) => setSlidingWindowTimestampCol(e.target.value)}
                          disabled={availableColumns.length === 0}
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
                          {sortedColumns.map(col => (
                            <SelectItem key={col} value={col} text={col} />
                          ))}
                        </Select>
                      </Column>
                      <Column lg={6} md={4} sm={4}>
                        <TextInput
                          id="sliding-window-duration"
                          labelText="Window Length"
                          value={slidingWindowText}
                          disabled={windowNeedsQuery}
                          onChange={(e) => {
                            const raw = e.target.value;
                            setSlidingWindowText(raw);
                            const secs = durationTokenToSeconds(raw);
                            if (secs == null || secs < 10) {
                              setSlidingWindowError('Use s/m/h/d/w (e.g. 7d, 90m) or seconds; min 10s.');
                            } else if (secs > SLIDING_WINDOW_MAX_SECONDS) {
                              setSlidingWindowError('Max window is 30d.');
                            } else {
                              setSlidingWindowError('');
                              setSlidingWindowDuration(secs);
                            }
                          }}
                          invalid={!windowNeedsQuery && !!slidingWindowError}
                          invalidText={slidingWindowError}
                          placeholder="7d"
                          helperText="Units: s/m/h/d/w — e.g. 90m, 1h, 7d, 1w. Plain number = seconds. Max 30d."
                        />
                      </Column>
                    </Grid>
                    {windowNeedsQuery && (
                      <p className="editor-info-hint">Run a query to set the sliding window.</p>
                    )}
                    </>
                    );
                  })()}
                  {!slidingWindowEnabled && (
                    <p className="editor-info-hint">
                      Enable to show only recent data (e.g., last 5 minutes). Useful for streaming/real-time charts.
                    </p>
                  )}
                  {/* #18: a tsstore-streaming panel filtered ONLY by a
                      client-side dashboard variable backfills count-based
                      ("newest N"), unfiltered at the source, then thins
                      client-side — so the selected value gets ~N/M records when
                      the stream interleaves M values. Two fixes: set a source-
                      side Filter bound to the variable (above; ts-store counts
                      matches, so each value gets full history), or set a sliding
                      window (time-based backfill). Only nudge on the at-risk
                      shape: streaming + client-side variable filter + NO source
                      filter + window off. */}
                  {!slidingWindowEnabled && isTSStoreStreaming && variableBoundFilter && !tsstoreFilterUsesVariable && (
                    <InlineNotification
                      lowContrast
                      kind="info"
                      hideCloseButton
                      title="Filter at the source for full per-value history"
                      subtitle="This panel filters a streaming connection by a dashboard variable client-side only. The history backfill isn't filtered at the source, so each value can load with sparse history. Bind the Filter field (in the Query section) to the dashboard variable, or set a sliding window, to get full per-value history. (For numeric machine data, a separate connection per source avoids this entirely.)"
                      style={{ marginTop: '0.5rem', maxWidth: '100%' }}
                    />
                  )}
                </div>
                )}

                {/* Current State Per Series (latest_by) — keep only the newest
                    row per distinct key value. Multi-series views only: value
                    and gauge render a single scalar (a filter + "last"
                    aggregation already expresses "current value of disk1"),
                    banded_bar's related columns share one timestamp so a
                    per-key dedupe would reduce along the wrong axis, and pie
                    already aggregates by category. Those opt out via
                    hasLatestBy:false. Hidden for query languages that own
                    client-side ops, same as the sliding window. */}
                {!showCustomCode && chartTypeConfig.hasLatestBy !== false && !queryLanguageOwnsClientSideOps && (
                <div className="spec-subsection latest-by-section">
                  <div className="section-header">
                    <h5 className="spec-subsection__heading">Current State Per Series</h5>
                    <Toggle
                      id="latest-by-toggle"
                      labelText=""
                      labelA="Off"
                      labelB="On"
                      toggled={latestByEnabled}
                      onToggle={() => setLatestByEnabled(!latestByEnabled)}
                      size="sm"
                    />
                  </div>
                  {latestByEnabled && (() => {
                    // Both pickers need a populated schema. A saved column
                    // counts (sortedColumns unions saved selections in), so an
                    // author reopening a component sees their choice even
                    // before re-running the query.
                    const latestByNeedsQuery = availableColumns.length === 0 && !latestByKeyCol;
                    return (
                    <>
                    <Grid narrow>
                      <Column lg={6} md={4} sm={4}>
                        <Select
                          id="latest-by-key"
                          labelText="Series Column"
                          value={latestByKeyCol}
                          onChange={(e) => setLatestByKeyCol(e.target.value)}
                          disabled={availableColumns.length === 0}
                          helperText="One row per distinct value — its newest record"
                        >
                          <SelectItem value="" text="Select series column..." />
                          {availableColumns.length === 0 && latestByKeyCol && (
                            <SelectItem value={latestByKeyCol} text={latestByKeyCol} />
                          )}
                          {sortedColumns.map(col => (
                            <SelectItem key={col} value={col} text={col} />
                          ))}
                        </Select>
                      </Column>
                      <Column lg={6} md={4} sm={4}>
                        <Select
                          id="latest-by-timestamp"
                          labelText="Timestamp Column (optional)"
                          value={latestByTimestampCol}
                          onChange={(e) => setLatestByTimestampCol(e.target.value)}
                          disabled={latestByNeedsQuery}
                          helperText="Blank = use the most recently received row"
                        >
                          <SelectItem value="" text="Most recently received" />
                          {availableColumns.length === 0 && latestByTimestampCol && (
                            <SelectItem value={latestByTimestampCol} text={latestByTimestampCol} />
                          )}
                          {sortedColumns.map(col => (
                            <SelectItem key={col} value={col} text={col} />
                          ))}
                        </Select>
                      </Column>
                    </Grid>
                    {latestByNeedsQuery && (
                      <p className="editor-info-hint">Run a query to choose a series column.</p>
                    )}
                    {/* The server-side ts-store latest_by already returns one
                        row per key, so doing it again here is a no-op. Not
                        blocked — a different key column is a legitimate (if
                        unusual) thing to express — but worth naming so the
                        author doesn't think this is what's doing the work. */}
                    {isTSStore && !isTSStoreStreaming && tsstoreQueryType === 'latest' && (
                      <InlineNotification
                        lowContrast
                        kind="info"
                        hideCloseButton
                        title="The query already does this"
                        subtitle="This connection's query type is Current State (latest per series), so ts-store returns one row per series before the data reaches the browser. This client-side reduction is redundant unless you're keying on a different column."
                        style={{ marginTop: '0.5rem', maxWidth: '100%' }}
                      />
                    )}
                    </>
                    );
                  })()}
                  {!latestByEnabled && (
                    <p className="editor-info-hint">
                      Enable to keep only the newest row per series (e.g. one row per disk or volume). Useful for streaming components, where the reduction can&apos;t be pushed down to the source.
                    </p>
                  )}
                </div>
                )}

                {/* Filters subsection. Hidden when the connection's
                    query language already owns this responsibility
                    (SQL WHERE / EdgeLake WHERE) — see
                    queryLanguageOwnsClientSideOps memo. Also hidden
                    for chart types that opt out via
                    hasFilters:false. EXCEPTION: components saved before
                    the SQL gating (2026-05-27) can carry client-side
                    filters that are still applied at render — surface
                    the section whenever filters exist so an active
                    filter is never invisible. Deleting them all (and
                    re-saving) hides the section again. */}
                {!showCustomCode && chartTypeConfig.hasFilters !== false && (!queryLanguageOwnsClientSideOps || filters.length > 0) && (
                <div className="spec-subsection filters-section">
                  <div className="section-header">
                    <h5 className="spec-subsection__heading">Filters</h5>
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
                  {queryLanguageOwnsClientSideOps && (
                    <p className="spec-field-helper">
                      This connection normally filters in the query itself (WHERE clause),
                      but this component has saved client-side filters that are still
                      applied after the query runs. Remove them all to hide this section,
                      or move the condition into the SQL.
                    </p>
                  )}
                  {filters.length > 0 ? (
                    availableColumns.length > 0 ? (
                      <div className="filters-list">
                        {filters.map((filter, index) => {
                          const hasValue = !['isNull', 'isNotNull'].includes(filter.op);
                          // Value-source is DERIVED, not stored: a filter bound
                          // to a dashboard variable carries the token as its
                          // literal value (the same contract the substitution +
                          // save paths already key on). The inline Select just
                          // toggles between a typed literal and that token.
                          const boundToVariable = typeof filter.value === 'string'
                            && filter.value.trim() === DASHBOARD_VARIABLE_TOKEN;
                          return (
                            <div key={index} className="filter-row">
                              <Select
                                id={`filter-field-${index}`}
                                labelText=""
                                hideLabel
                                value={filter.field}
                                onChange={(e) => updateFilter(index, 'field', e.target.value)}
                                size="sm"
                                className="filter-field-select"
                              >
                                {sortedColumns.map(col => (
                                  <SelectItem key={col} value={col} text={col} />
                                ))}
                              </Select>
                              {/* Operator + value-source group sizes to content
                                  and wraps together (never a staircase). */}
                              <div className="filter-ops">
                                <Select
                                  id={`filter-op-${index}`}
                                  labelText=""
                                  hideLabel
                                  value={filter.op}
                                  onChange={(e) => updateFilter(index, 'op', e.target.value)}
                                  size="sm"
                                  className="filter-operator-select"
                                >
                                  {FILTER_OPERATORS.map(op => (
                                    <SelectItem key={op.id} value={op.id} text={op.label} />
                                  ))}
                                </Select>
                                {/* Value-source picker — a typed literal or the
                                    dashboard variable (bound at view time). Only
                                    when the deployment has dashboard variables
                                    enabled, and not for null-checks. */}
                                {dashboardVariableEnabled && hasValue && (
                                  <Select
                                    id={`filter-value-source-${index}`}
                                    labelText=""
                                    hideLabel
                                    value={boundToVariable ? 'variable' : 'literal'}
                                    onChange={(e) => updateFilter(
                                      index,
                                      'value',
                                      e.target.value === 'variable' ? DASHBOARD_VARIABLE_TOKEN : '',
                                    )}
                                    size="sm"
                                    className="filter-value-source-select"
                                  >
                                    <SelectItem value="literal" text="Value" />
                                    <SelectItem value="variable" text="Dashboard variable" />
                                  </Select>
                                )}
                              </div>
                              {hasValue && (
                                boundToVariable ? (
                                  <Tag
                                    type="purple"
                                    size="sm"
                                    className="filter-value-variable-chip"
                                    title="Bound to the dashboard variable at view time"
                                  >
                                    {DASHBOARD_VARIABLE_TOKEN}
                                  </Tag>
                                ) : (
                                  <TextInput
                                    id={`filter-value-${index}`}
                                    labelText=""
                                    hideLabel
                                    value={filter.value}
                                    onChange={(e) => updateFilter(index, 'value', e.target.value)}
                                    placeholder={filter.op === 'in' || filter.op === 'notIn' ? 'val1, val2, val3' : 'Enter value'}
                                    size="sm"
                                    className="filter-value-input"
                                  />
                                )
                              )}
                              {/* Flexible spacer soaks up freed width as empty
                                  space so nothing balloons (esp. null-checks),
                                  keeping the trash anchored right. */}
                              <div className="filter-spacer" aria-hidden="true" />
                              <IconButton
                                label="Remove filter"
                                kind="ghost"
                                size="sm"
                                onClick={() => removeFilter(index)}
                              >
                                <TrashCan />
                              </IconButton>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="saved-filters-display">
                        <div className="filters-list">
                          {filters.map((filter, index) => (
                            <div key={index} className="filter-tag-row">
                              <Tag type="purple">{filter.field}</Tag>
                              <Tag type="gray">{FILTER_OPERATORS.find(op => op.id === filter.op)?.label || filter.op}</Tag>
                              {!['isNull', 'isNotNull'].includes(filter.op) && (
                                <Tag type="blue">{String(filter.value)}</Tag>
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
                <div className="spec-subsection aggregation-section">
                  <h5 className="spec-subsection__heading">Aggregation &amp; Sorting</h5>
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
                              {sortedColumns.map(col => (
                                <SelectItem key={col} value={col} text={col} />
                              ))}
                            </Select>
                          </Column>
                        )}
                        {AGGREGATION_TYPES.find(a => a.id === aggregation.type)?.needsField && (
                          <Column lg={4} md={4} sm={4}>
                            {/* On single-value charts the field is not a
                                choice — there is exactly one displayed
                                column, so it's locked to the Value Column
                                (and kept bound in state by the effect near
                                updateAggregation). Shown rather than hidden
                                so it's visible WHICH column is being
                                aggregated. */}
                            <Select
                              id="aggregation-field"
                              labelText="Field"
                              value={singleValueColumn != null ? singleValueColumn : aggregation.field}
                              onChange={(e) => updateAggregation('field', e.target.value)}
                              disabled={singleValueColumn != null}
                              helperText={
                                singleValueColumn != null
                                  ? (singleValueColumn
                                      ? 'Locked to the Value Column.'
                                      : 'Pick a Value Column above first.')
                                  : undefined
                              }
                            >
                              <SelectItem value="" text="Select column..." />
                              {sortedColumns.map(col => (
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
                              allowEmpty
                              onChange={(e, { value }) => updateAggregation('count', value === '' || value == null ? 1 : value)}
                              min={1}
                              max={1000}
                            />
                          </Column>
                        )}
                      </Grid>
                      {chartTypeConfig.hasSortLimit !== false && (
                        <Grid narrow className="sort-row">
                          <Column lg={4} md={4} sm={4}>
                            <Select
                              id="sort-by"
                              labelText="Sort By"
                              value={sortBy}
                              onChange={(e) => setSortBy(e.target.value)}
                            >
                              <SelectItem value="" text="None" />
                              {sortedColumns.map(col => (
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
                              allowEmpty
                              onChange={(e, { value }) => setLimitRows(value === '' || value == null ? 0 : value)}
                              min={0}
                              max={10000}
                              helperText="0 = no limit"
                            />
                          </Column>
                        </Grid>
                      )}
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


                </CollapsibleTile>
                )}

                {filteredPreviewData && (
                  <div className="data-preview" ref={previewRef}>
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
                                <td key={j}>{formatCellValue(cell, filteredPreviewData.columns?.[j], { timestampFormat: xAxisFormat || 'short', strictTimestampNames: true })}</td>
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
                      componentMeta={{
                        title,
                        name,
                        description,
                        // id lets spec-driven views key per-user state on
                        // the component (dataview's column layout). Empty
                        // for an unsaved new chart — useDataviewLayout
                        // no-ops on a blank id.
                        id: chart?.id || '',
                        // Spec-driven shell (SpecDrivenChart) reads
                        // chart_type / data_mapping / options off the
                        // ComponentConfigContext. Mirror the viewer's
                        // shape here so the preview renders the same
                        // option literal a saved chart would. line.js's
                        // normalizeYEntry shim accepts both string and
                        // object y_axis entries — we pass objects here
                        // so per-row label / stack / axis from the
                        // editor's working state are visible to the
                        // preview without a save round-trip.
                        chart_type: chartType,
                        data_mapping: selectedConnectionId ? {
                          x_axis: xAxisColumn,
                          x_axis_label: xAxisLabel || '',
                          x_axis_format: xAxisFormat || 'auto',
                          y_axis: yAxisColumns
                            .map((column, i) => ({
                              column,
                              label: (Array.isArray(yAxisLabels) ? yAxisLabels[i] : '') || '',
                              stack: Boolean(chartOptions.chartStacked),
                              axis: i === 1 && chartOptions.multipleYAxis ? 'right' : 'left',
                              color: (Array.isArray(yAxisColors) ? yAxisColors[i] : '') || '',
                            }))
                            .filter((e) => e.column && e.column.length > 0),
                          // Dual-axis is the user's explicit choice only;
                          // line.js treats anything other than `true` as
                          // off (no 2-column auto-convention). Mirrors the
                          // formState builder and the saved-record path.
                          multiple_y_axis: chartOptions.multipleYAxis === true,
                          series: seriesColumn || '',
                          // Per-column accumulator/delta (#8) — mirror the save
                          // path (parallel array realigned to filtered y_axis)
                          // so the preview deltas exactly as a saved record.
                          accumulator_columns: (() => {
                            const keep = yAxisColumns.map((c, i) => (typeof c === 'string' && c.length > 0 ? i : -1)).filter((i) => i >= 0);
                            const aligned = keep.map((i) => (Array.isArray(yAxisAccumulate) ? yAxisAccumulate[i] === true : false));
                            return aligned.some(Boolean) ? aligned : undefined;
                          })(),
                          accumulator_reset_policy: (Array.isArray(yAxisAccumulate) && yAxisAccumulate.some(Boolean)) ? accumulatorResetPolicy : undefined,
                          // scatter reads these off data_mapping
                          y_axis_label: yAxisLabel || '',
                          size_column: chartOptions.sizeColumn || '',
                          // banded_bar reads its per-row band column map off
                          // data_mapping. Only meaningful when a mean column
                          // is picked; undefined otherwise mirrors the save
                          // path so the preview matches a saved record.
                          band_columns: chartType === 'banded_bar' && hasBandCenter(bandColumns) ? bandColumns : undefined,
                          // dataview reads its column config off data_mapping.
                          // visible_columns is the working state directly
                          // (null = show all); aliases as-is; author widths
                          // pruned so the preview matches a saved record.
                          visible_columns: Array.isArray(visibleColumns) ? visibleColumns : undefined,
                          column_aliases: columnAliases,
                          column_widths: pruneColumnWidths(columnWidths),
                          column_formats: Object.keys(columnFormats).length > 0 ? columnFormats : undefined,
                          column_rules: pruneColumnRules(columnRules),
                        } : undefined,
                        // bandedBarStyle is a sibling state var (not inside
                        // chartOptions); merge it into options for the
                        // preview the same way the save payload does, so
                        // banded_bar.buildOption sees options.bandedBarStyle.
                        options: chartType === 'banded_bar' ? { ...chartOptions, bandedBarStyle } : chartOptions,
                      }}
                      connectionId={selectedConnectionId || null}
                      queryConfig={selectedConnectionId ? {
                        raw: selectedDatasource?.type === 'tsstore'
                          ? buildTsstoreRaw(tsstoreQueryType, tsstoreSinceDuration, tsstoreRangeFrom, tsstoreRangeTo)
                          : queryRaw,
                        type: queryType,
                        params: selectedDatasource?.type === 'tsstore'
                          ? {
                              ...(tsstoreQueryType === 'since' || tsstoreQueryType === 'range' || tsstoreQueryType === 'latest' ? {} : { limit: tsstoreLimit }),
                              ...buildTsstoreLatestByParams(),
                              ...buildTsstoreFilterParams(),
                              // Resolve the filter token for the custom-code preview.
                              ...(tsstoreFilterUsesVariable ? { dashboard_variable: previewVariableValue } : {}),
                            }
                          : selectedDatasource?.type === 'prometheus'
                            ? buildPrometheusParams()
                            : selectedDatasource?.type === 'edgelake' && edgelakeDatabase
                              ? { database: edgelakeDatabase }
                              // Had been `{}`, which sent the live preview out
                              // bare while the preview + save paths preserved
                              // params — so a Synology custom-code preview
                              // failed with DSM error 120 even when Fetch Data
                              // above it succeeded.
                              : buildSurfaceParams()
                      } : null}
                      dataMapping={selectedConnectionId ? {
                        connection_id: selectedConnectionId,
                        x_axis: xAxisColumn,
                        x_axis_label: xAxisLabel || '',
                        x_axis_format: xAxisFormat || 'auto',
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
                        column_widths: pruneColumnWidths(columnWidths),
                        column_formats: Object.keys(columnFormats).length > 0 ? columnFormats : undefined,
                        visible_columns: Array.isArray(visibleColumns) && visibleColumns.length > 0 ? visibleColumns : undefined,
                        parser: parserPreset !== 'none' && (parserDataPath || parserTimestampField) ? {
                          data_path: parserDataPath || undefined,
                          timestamp_field: parserTimestampField || undefined,
                          timestamp_scale: parserTimestampScale || undefined
                        } : null
                      } : null}
                      // The author's picked preview value (from the fetch-time
                      // value picker) drives the live preview's token
                      // substitution — both the server query param and any
                      // client-side filter using the token.
                      dashboardVariableValue={previewVariableValue || null}
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

// After Stage 3 this function only generates the line/bar/area/scatter
// ECharts fallback for a `custom` chart that has a connection but no
// hand-written code (all canonical types return at the spec dispatch
// below). `_columnAliases` / `_chartId` were used by the deleted dataview
// branch — kept as positional placeholders so the call site's arg order
// is untouched.
export function getDataDrivenChartCode(chartType, connectionId, queryRaw, queryType, xAxisCol, yAxisCols, transforms = {}, chartOptions = {}, queryParams = {}, seriesCol = '', _columnAliases = {}, isStreaming = false, slidingWindow = null, parserConfig = null, _chartId = '', isTSStoreStreaming = false, useSpecCodegen = false, tsstoreFilterParams = {}) {
  const yAxisStr = yAxisCols.length > 0 ? yAxisCols.map(c => `'${c}'`).join(', ') : "'value'";
  const { filters = [], aggregation = null, sortBy = '', sortOrder = 'desc', limit = 0, xAxisFormat = 'chart', xAxisLabel = '', yAxisLabel = '', yAxisLabels = [], chartName = '' } = transforms;

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
  // Serialize the source-side filter as JS object-literal entries so it can be
  // merged into a backfill's `params`. The filter (literal or the
  // {{dashboard-variable}} token) is applied AT THE SOURCE, so ts-store returns
  // up to `limit` MATCHING records — closing the #18 sparsity even without a
  // sliding window. (#18)
  const filterEntries = Object.entries(tsstoreFilterParams || {})
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  const filterFragment = filterEntries.length ? `, ${filterEntries.join(', ')}` : '';
  if (isStreaming && slidingWindow?.duration > 0) {
    // Sliding-window backfill: pull every record from the last N
    // seconds so the chart isn't blank while waiting for the next
    // streaming push. ts-store accepts "since:30m"/"5m"/"45s"-style
    // shorthand on its REST query path.
    const dur = slidingWindow.duration;
    const sinceStr = dur >= 3600 && dur % 3600 === 0 ? `${dur / 3600}h`
      : dur >= 60 && dur % 60 === 0 ? `${dur / 60}m`
      : `${dur}s`;
    extraOptions.push(`backfill: { raw: 'since:${sinceStr}', type: '${queryType}', params: {${filterFragment ? ` ${filterEntries.join(', ')} ` : ''}} }`);
  } else if (isTSStoreStreaming) {
    // No sliding window set, but ts-store can still serve a quick
    // "latest N" backfill so the chart paints immediately instead of
    // sitting empty until the next push arrives. Single-value charts
    // (gauge, value) only need the latest record; everything else
    // gets 100 for context. The hook (useData) supplies a 100-record
    // default if no backfill is emitted at all, so this generator path
    // is mostly about the gauge/value override.
    const limit = SINGLE_VALUE_CHART_TYPES.has(chartType) ? 1 : 100;
    extraOptions.push(`backfill: { raw: 'newest', type: '${queryType}', params: { limit: ${limit}${filterFragment} } }`);
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
      // in/notIn want an array. The UI stores a comma-separated STRING; the AI
      // (and the canonical form) stores an ARRAY already. Only split a string —
      // splitting an array throws "f.value.split is not a function" and crashed
      // the editor on AI-built components. Mirrors dataTransforms.js.
      value: (f.op === 'in' || f.op === 'notIn') && typeof f.value === 'string'
        ? f.value.split(',').map(v => v.trim())
        : f.value
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

  // Spec-driven codegen dispatch.
  //
  // If the chart_type has a buildOption module under
  // chart-spec/specs/<type>.js, emit a tiny code string that mounts the
  // generic <SpecDrivenChart> shell. The shell calls buildOption with the
  // saved config + live data and renders ECharts directly — no string
  // templating beyond this one-liner emission. Every spec-driven chart
  // type now uses buildOption; the old Stage 1 string-emitter template
  // registry (chart-codegen/index.js) has been removed. Chart types
  // without a buildOption fall through to the legacy
  // getDataDrivenChartCode dispatch below.
  if (useSpecCodegen && chartHasBuildOption(chartType)) {
    return `const Component = () => {\n  return <SpecDrivenChart specName="${chartType}" />;\n};`;
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

// registryTypeIdToLegacy converts a registry adapter id ("api.synology",
// "store.tsstore") to the short connection.type string this editor and the
// connection records use ("synology", "tsstore").
//
// Mirrors legacyToRegistryTypeID in server-go/internal/handlers/registry_handler.go,
// in the other direction. The general rule — drop the category prefix — is right
// for every current type; sql.* is the one family that collapses many registry
// ids onto one legacy type, and it's spelled out rather than left to chance.
function registryTypeIdToLegacy(typeId) {
  if (!typeId) return '';
  if (typeId.startsWith('sql.') || typeId.startsWith('db.')) return 'sql';
  if (typeId === 'stream.websocket' || typeId === 'stream.websocket-bidir') return 'socket';
  if (typeId === 'api.rest') return 'api';
  if (typeId === 'file.csv') return 'csv';
  const dot = typeId.indexOf('.');
  return dot === -1 ? typeId : typeId.slice(dot + 1);
}

// findMatchingPreset locates the catalog preset a stored query_config came
// from, so re-opening a saved component selects the right entry in the picker.
//
// Matches on raw + the params the preset actually declares, ignoring extra
// stored keys. A component saved before the catalog existed, or hand-built
// against an API not in the catalog, simply matches nothing — the caller then
// falls back to passthroughQueryParams and the query round-trips untouched.
function findMatchingPreset(surface, raw, params) {
  if (!surface?.presets?.length) return null;
  const stored = params || {};
  return surface.presets.find((preset) => {
    if ((preset.raw || '') !== (raw || '')) return false;
    return Object.entries(preset.params || {}).every(
      // Loose compare: version round-trips through JSON as a number but may
      // have been stored as a string by an older hand-edited record.
      ([key, value]) => String(stored[key] ?? '') === String(value ?? '')
    );
  }) || null;
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
