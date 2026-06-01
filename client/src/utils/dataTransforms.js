// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Data Transform Utilities
 *
 * Applies client-side filters and aggregations to data returned from the data layer.
 * This runs AFTER data is fetched/cached, allowing one cached dataset to serve
 * multiple charts with different filter configurations.
 *
 * Usage:
 * const { data } = useData({ connectionId, query });
 * const filtered = transformData(data, {
 *   filters: [{ field: 'sensor_id', op: 'eq', value: 'sensor-001' }],
 *   aggregation: { type: 'last', sortBy: 'timestamp' }
 * });
 */

/**
 * Filter operators
 */
const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  contains: (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  startsWith: (a, b) => String(a).toLowerCase().startsWith(String(b).toLowerCase()),
  endsWith: (a, b) => String(a).toLowerCase().endsWith(String(b).toLowerCase()),
  in: (a, b) => Array.isArray(b) ? b.includes(a) : false,
  notIn: (a, b) => Array.isArray(b) ? !b.includes(a) : true,
  isNull: (a) => a === null || a === undefined,
  isNotNull: (a) => a !== null && a !== undefined,
};

/**
 * Apply a single filter to rows
 * @param {Array} rows - Array of row arrays
 * @param {Array} columns - Column names
 * @param {Object} filter - Filter config { field, op, value }
 * @returns {Array} Filtered rows
 */
function applyFilter(rows, columns, filter) {
  const { field, op, value } = filter;
  const colIndex = columns.indexOf(field);

  if (colIndex === -1) {
    console.warn(`Filter field "${field}" not found in columns`);
    return rows;
  }

  const operator = OPERATORS[op];
  if (!operator) {
    console.warn(`Unknown filter operator "${op}"`);
    return rows;
  }

  return rows.filter(row => operator(row[colIndex], value));
}

/**
 * Apply multiple filters (AND logic)
 * @param {Array} rows - Array of row arrays
 * @param {Array} columns - Column names
 * @param {Array} filters - Array of filter configs
 * @returns {Array} Filtered rows
 */
function applyFilters(rows, columns, filters) {
  if (!filters || !Array.isArray(filters) || filters.length === 0) {
    return rows;
  }

  return filters.reduce((filteredRows, filter) => {
    return applyFilter(filteredRows, columns, filter);
  }, rows);
}

/**
 * Apply sliding window filter based on timestamp column
 * Keeps only rows where timestamp is within the last N seconds
 * @param {Array} rows - Array of row arrays
 * @param {Array} columns - Column names
 * @param {Object} slidingWindow - { duration: seconds, timestampCol: columnName }
 * @returns {Array} Filtered rows within the time window
 */
function applySlidingWindow(rows, columns, slidingWindow) {
  if (!slidingWindow || !slidingWindow.duration || !slidingWindow.timestampCol) {
    return rows;
  }

  const { duration, timestampCol } = slidingWindow;
  const colIndex = columns.indexOf(timestampCol);

  if (colIndex === -1) {
    console.warn(`Sliding window timestamp column "${timestampCol}" not found`);
    return rows;
  }

  const now = Date.now();
  const windowStartMs = now - (duration * 1000);

  return rows.filter(row => {
    const tsValue = row[colIndex];
    if (tsValue === null || tsValue === undefined) return false;

    // Parse timestamp to milliseconds
    let tsMs;
    if (typeof tsValue === 'number') {
      // Detect if unix seconds or milliseconds
      if (tsValue > 946684800000 && tsValue < 4102444800000) {
        // Already in milliseconds (13+ digits, between 2000 and 2100)
        tsMs = tsValue;
      } else if (tsValue > 946684800 && tsValue < 4102444800) {
        // Unix seconds (10 digits)
        tsMs = tsValue * 1000;
      } else {
        tsMs = tsValue;
      }
    } else if (typeof tsValue === 'string') {
      // Try parsing as number first (string unix timestamp)
      const num = Number(tsValue);
      if (!isNaN(num) && num > 946684800) {
        if (num > 946684800000) {
          tsMs = num; // milliseconds
        } else {
          tsMs = num * 1000; // seconds
        }
      } else {
        // Try parsing as ISO date string
        const parsed = new Date(tsValue);
        tsMs = isNaN(parsed.getTime()) ? null : parsed.getTime();
      }
    } else {
      return false;
    }

    if (tsMs === null) return false;
    return tsMs >= windowStartMs;
  });
}

/**
 * Sort rows by a column
 * @param {Array} rows - Array of row arrays
 * @param {Array} columns - Column names
 * @param {string} sortBy - Column name to sort by
 * @param {string} order - 'asc' or 'desc'
 * @returns {Array} Sorted rows
 */
function sortRows(rows, columns, sortBy, order = 'desc') {
  const colIndex = columns.indexOf(sortBy);

  if (colIndex === -1) {
    console.warn(`Sort column "${sortBy}" not found`);
    return rows;
  }

  return [...rows].sort((a, b) => {
    const valA = a[colIndex];
    const valB = b[colIndex];

    // Handle null/undefined
    if (valA == null && valB == null) return 0;
    if (valA == null) return order === 'asc' ? -1 : 1;
    if (valB == null) return order === 'asc' ? 1 : -1;

    // Compare
    if (valA < valB) return order === 'asc' ? -1 : 1;
    if (valA > valB) return order === 'asc' ? 1 : -1;
    return 0;
  });
}

/**
 * Apply aggregation to get a single value or reduced dataset
 * @param {Array} rows - Array of row arrays
 * @param {Array} columns - Column names
 * @param {Object} aggregation - Aggregation config
 * @returns {Object} { rows, value } - Aggregated result
 */
function applyAggregation(rows, columns, aggregation) {
  if (!aggregation || !aggregation.type) {
    return { rows, value: null };
  }

  const { type, sortBy, field } = aggregation;

  // Sort if needed for first/last
  let sortedRows = rows;
  if (sortBy && (type === 'first' || type === 'last')) {
    const order = type === 'last' ? 'desc' : 'asc';
    sortedRows = sortRows(rows, columns, sortBy, order);
  }

  // Get field index for value extraction
  const fieldIndex = field ? columns.indexOf(field) : -1;

  switch (type) {
    case 'first':
      return {
        rows: sortedRows.slice(0, 1),
        value: fieldIndex >= 0 && sortedRows.length > 0 ? sortedRows[0][fieldIndex] : null
      };

    case 'last':
      return {
        rows: sortedRows.slice(0, 1),
        value: fieldIndex >= 0 && sortedRows.length > 0 ? sortedRows[0][fieldIndex] : null
      };

    case 'min': {
      if (fieldIndex < 0) return { rows, value: null };
      const minVal = Math.min(...rows.map(r => Number(r[fieldIndex]) || 0));
      return { rows, value: minVal };
    }

    case 'max': {
      if (fieldIndex < 0) return { rows, value: null };
      const maxVal = Math.max(...rows.map(r => Number(r[fieldIndex]) || 0));
      return { rows, value: maxVal };
    }

    case 'sum': {
      if (fieldIndex < 0) return { rows, value: null };
      const sumVal = rows.reduce((acc, r) => acc + (Number(r[fieldIndex]) || 0), 0);
      return { rows, value: sumVal };
    }

    case 'avg': {
      if (fieldIndex < 0 || rows.length === 0) return { rows, value: null };
      const avgVal = rows.reduce((acc, r) => acc + (Number(r[fieldIndex]) || 0), 0) / rows.length;
      return { rows, value: avgVal };
    }

    case 'count':
      return { rows, value: rows.length };

    case 'limit': {
      const limit = aggregation.count || 10;
      return { rows: sortedRows.slice(0, limit), value: null };
    }

    default:
      console.warn(`Unknown aggregation type "${type}"`);
      return { rows, value: null };
  }
}

/**
 * Main transform function
 * Applies filters, sliding window, and aggregations to data from the data layer
 *
 * @param {Object} data - Data from useData hook { columns, rows, metadata }
 * @param {Object} transforms - Transform configuration
 * @param {Object} transforms.slidingWindow - { duration: seconds, timestampCol: columnName } - time-based window
 * @param {Array} transforms.filters - Array of { field, op, value }
 * @param {Object} transforms.aggregation - { type, sortBy, field }
 * @param {string} transforms.sortBy - Column to sort by
 * @param {string} transforms.sortOrder - 'asc' or 'desc'
 * @param {number} transforms.limit - Max rows to return
 * @returns {Object} Transformed data { columns, rows, metadata, aggregatedValue }
 */
export function transformData(data, transforms = {}) {
  if (!data || !data.rows || !data.columns) {
    return { columns: [], rows: [], metadata: {}, aggregatedValue: null };
  }

  // Handle null transforms (default param only works for undefined, not null)
  const safeTransforms = transforms || {};
  const { filters, aggregation, sortBy, sortOrder, limit, slidingWindow } = safeTransforms;

  let rows = [...data.rows];
  const columns = data.columns;

  // 1. Apply sliding window (time-based filter) - do this first to reduce data volume
  rows = applySlidingWindow(rows, columns, slidingWindow);

  // 2. Apply filters
  rows = applyFilters(rows, columns, filters);

  // 3. Apply sorting (if not part of aggregation)
  if (sortBy && (!aggregation || !aggregation.sortBy)) {
    rows = sortRows(rows, columns, sortBy, sortOrder || 'desc');
  }

  // 4. Apply limit (if not part of aggregation)
  if (limit && (!aggregation || aggregation.type !== 'limit')) {
    rows = rows.slice(0, limit);
  }

  // 4. Apply aggregation
  const { rows: aggRows, value: aggregatedValue } = applyAggregation(rows, columns, aggregation);
  rows = aggRows;

  return {
    columns,
    rows,
    metadata: {
      ...data.metadata,
      originalRowCount: data.rows.length,
      filteredRowCount: rows.length,
      transformed: true
    },
    aggregatedValue
  };
}

/**
 * Helper to convert columnar data to objects for easier access
 * @param {Object} data - { columns, rows }
 * @returns {Array} Array of objects
 */
export function toObjects(data) {
  if (!data || !data.rows || !data.columns) return [];

  return data.rows.map(row => {
    const obj = {};
    data.columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

/**
 * Helper to get a single value from first row
 * @param {Object} data - { columns, rows }
 * @param {string} field - Column name
 * @returns {any} The value
 */
export function getValue(data, field) {
  if (!data || !data.rows || !data.rows.length || !data.columns) return null;

  const colIndex = data.columns.indexOf(field);
  if (colIndex === -1) return null;

  return data.rows[0][colIndex];
}

/**
 * Timestamp formatting utilities
 */

/**
 * Detect if a value is likely a timestamp
 * @param {any} value - The value to check
 * @returns {string|null} - 'unix_seconds', 'unix_ms', 'iso', or null
 */
export function detectTimestampType(value) {
  if (value === null || value === undefined) return null;

  // ISO string format
  if (typeof value === 'string') {
    // Check for ISO format: 2024-01-15T10:30:00Z or 2024-01-15T10:30:00.000Z
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
      return 'iso';
    }
    // Check for date format: 2024-01-15
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return 'iso';
    }
  }

  // Unix timestamp
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) {
    const num = Number(value);
    // Unix seconds (10 digits, roughly 1970-2100)
    if (num > 946684800 && num < 4102444800) {
      return 'unix_seconds';
    }
    // Unix milliseconds (13 digits)
    if (num > 946684800000 && num < 4102444800000) {
      return 'unix_ms';
    }
  }

  return null;
}

/**
 * Parse a timestamp value into a Date object
 * @param {any} value - The timestamp value
 * @param {string} type - Optional type hint ('unix_seconds', 'unix_ms', 'iso')
 * @returns {Date|null} - Parsed Date or null
 */
export function parseTimestamp(value, type = null) {
  if (value === null || value === undefined) return null;

  const detectedType = type || detectTimestampType(value);

  switch (detectedType) {
    case 'unix_seconds':
      return new Date(Number(value) * 1000);
    case 'unix_ms':
      return new Date(Number(value));
    case 'iso':
      return new Date(value);
    default: {
      // Try parsing as-is
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date;
    }
  }
}

// Option sets for each named preset. Pulled out of the switch body
// so we can build one Intl.DateTimeFormat per (preset, locale,
// timezone) and reuse it across calls — `date.toLocaleString(opts)`
// internally constructs a new formatter on every invocation, which
// shows up dominant in CPU profiles when a chart formats thousands
// of timestamps (~8s out of a 15s trace on the Pi sense-hat
// dashboard's 10K-sample line chart). Memoizing collapses that cost
// to ~one formatter per chart axis.
//
// Output is byte-identical to the prior toLocaleString /
// toLocaleTimeString / toLocaleDateString calls — explicit options
// dominate the underlying ICU behavior regardless of method name.
const PRESET_OPTIONS = {
  short:                  { month: 'numeric', day: 'numeric', year: '2-digit', hour: 'numeric', minute: '2-digit' },
  long:                   { month: 'long',    day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' },
  time:                   { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  time_short:             { hour: 'numeric', minute: '2-digit' },
  date:                   { month: 'long',  day: 'numeric', year: 'numeric' },
  date_short:             { month: 'numeric', day: 'numeric', year: '2-digit' },
  chart:                  { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  chart_time:             { hour: 'numeric', minute: '2-digit' },
  chart_time_seconds:     { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  chart_date:             { month: 'short', day: 'numeric' },
  chart_datetime:         { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
  chart_datetime_seconds: { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' },
  // chart_auto picks time-vs-date inline based on data age.
  __chart_auto_time:      { hour: 'numeric', minute: '2-digit' },
  __chart_auto_date:      { month: 'short', day: 'numeric' },
};

// Cache of Intl.DateTimeFormat instances keyed on
// preset|locale|timezone. Module-scope so it persists across all
// chart renders and panel re-mounts. Bounded growth: presets are
// a fixed list, locales rarely vary, and timezones are typically
// one per deployment — practical max cache size <100.
const FORMATTER_CACHE = new Map();

function getFormatter(preset, locale, timezone) {
  const opts = PRESET_OPTIONS[preset];
  if (!opts) return null;
  const key = `${preset}|${locale || ''}|${timezone || ''}`;
  let f = FORMATTER_CACHE.get(key);
  if (!f) {
    const finalOpts = timezone ? { ...opts, timeZone: timezone } : opts;
    f = new Intl.DateTimeFormat(locale, finalOpts);
    FORMATTER_CACHE.set(key, f);
  }
  return f;
}

/**
 * Format a timestamp for display
 * @param {any} value - The timestamp value (unix, iso string, or Date)
 * @param {string} format - Format type: 'short', 'long', 'time', 'date', 'relative', 'iso', 'chart_*'
 * @param {Object} options - Additional options
 * @param {string} options.locale - Locale string (default: 'en-US')
 * @param {string} options.timezone - Timezone (default: local)
 * @returns {string} - Formatted timestamp string
 */
export function formatTimestamp(value, format = 'short', options = {}) {
  const { locale = 'en-US', timezone } = options;

  const date = value instanceof Date ? value : parseTimestamp(value);
  if (!date || isNaN(date.getTime())) {
    return String(value); // Return original if can't parse
  }

  // relative + iso don't go through Intl.DateTimeFormat
  if (format === 'relative') return formatRelativeTime(date);
  if (format === 'iso') return date.toISOString();

  // chart_auto (and the bare 'auto' alias) picks time-vs-date based on
  // the age of the value. The line/area/bar specs resolve 'auto' to a
  // concrete preset at the series level (resolveAutoXFormat) before
  // calling here; this branch is the graceful fallback for any other
  // path that passes 'auto' straight through (legacy codegen, custom
  // code) — it degrades to a sensible single-value format rather than
  // hitting the unknown-preset warning.
  if (format === 'chart_auto' || format === 'auto') {
    const now = Date.now();
    const diffHours = Math.abs(now - date.getTime()) / (1000 * 60 * 60);
    const sub = diffHours < 24 ? '__chart_auto_time' : '__chart_auto_date';
    return getFormatter(sub, locale, timezone).format(date);
  }

  const formatter = getFormatter(format, locale, timezone);
  if (formatter) return formatter.format(date);

  // Unknown format string. The most common cause is AI-generated
  // chart code inventing a preset name like 'time_12_seconds' or
  // 'HH:MM:SS'. The legacy fallback was toLocaleString which
  // silently renders date + time — the opposite of what most
  // chart-axis callers wanted, and impossible to debug from the
  // rendered chart. Emit a one-time console warning naming the
  // bad preset so it's visible in dev, then fall back to
  // chart_time (time only) which is the safer default for a
  // charting context.
  if (typeof window !== 'undefined') {
    const seen = (window.__formatTimestampUnknownPresets ||= new Set());
    if (!seen.has(format)) {
      seen.add(format);
      // eslint-disable-next-line no-console
      console.warn(
        `[formatTimestamp] Unknown format preset ${JSON.stringify(format)} — falling back to 'chart_time' (time only). Valid presets: chart, chart_time, chart_time_seconds, chart_date, chart_datetime, chart_datetime_seconds, iso.`
      );
    }
  }
  return getFormatter('chart_time', locale, timezone).format(date);
}

/**
 * Format relative time (e.g., "5 minutes ago")
 * @param {Date} date - The date to format
 * @returns {string} - Relative time string
 */
function formatRelativeTime(date) {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  const isFuture = diffMs < 0;
  const abs = Math.abs;

  if (abs(diffSeconds) < 60) {
    return isFuture ? 'in a moment' : 'just now';
  } else if (abs(diffMinutes) < 60) {
    const mins = abs(diffMinutes);
    return isFuture
      ? `in ${mins} minute${mins === 1 ? '' : 's'}`
      : `${mins} minute${mins === 1 ? '' : 's'} ago`;
  } else if (abs(diffHours) < 24) {
    const hrs = abs(diffHours);
    return isFuture
      ? `in ${hrs} hour${hrs === 1 ? '' : 's'}`
      : `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  } else if (abs(diffDays) < 30) {
    const days = abs(diffDays);
    return isFuture
      ? `in ${days} day${days === 1 ? '' : 's'}`
      : `${days} day${days === 1 ? '' : 's'} ago`;
  } else {
    // Fall back to date format for longer periods
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
  }
}

/**
 * Format a value for display in a data table cell
 * Automatically detects and formats timestamps
 * @param {any} value - The value to format
 * @param {string} columnName - Column name (hints at type)
 * @param {Object} options - Format options
 * @returns {string} - Formatted value
 */
export function formatCellValue(value, columnName = '', options = {}) {
  if (value === null || value === undefined) return '';

  // Check if column name suggests it's a timestamp. Match the time-ish
  // word only as a WHOLE SEGMENT (bounded by start/end or a . _ -
  // delimiter), not as any substring — otherwise `uptime.sec`,
  // `downtime`, `update_count`, etc. falsely match "time"/"update" and
  // get rendered as dates. `timestamp` and real time columns
  // (start_time, event.timestamp, created_at, ts, date, …) still match.
  const isTimestampColumn = /(^|[._-])(timestamp|datetime|time|date|created|updated|ts)([._-]|$)/i.test(columnName);

  // Check if value looks like a timestamp
  const timestampType = detectTimestampType(value);

  if (isTimestampColumn || timestampType) {
    const format = options.timestampFormat || 'short';
    return formatTimestamp(value, format, options);
  }

  // For numbers, apply basic formatting
  if (typeof value === 'number') {
    // Check if it's a float
    if (!Number.isInteger(value)) {
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
    }
    return value.toLocaleString('en-US');
  }

  return String(value);
}

/**
 * Transform a dataset with formatted timestamps
 * @param {Object} data - { columns, rows }
 * @param {Object} options - Format options
 * @param {string} options.timestampFormat - Format for timestamps
 * @param {Array} options.timestampColumns - Specific columns to format as timestamps
 * @returns {Object} - Transformed data with formatted values
 */
export function formatDataForDisplay(data, options = {}) {
  if (!data || !data.rows || !data.columns) {
    return { columns: [], rows: [], formattedRows: [] };
  }

  const { timestampFormat = 'short', timestampColumns = [] } = options;

  // Detect which columns are timestamps
  const timestampColIndices = data.columns.map((col, i) => {
    if (timestampColumns.includes(col)) return true;
    if (/timestamp|time|date|created|updated|ts$/i.test(col)) return true;
    // Check first non-null value in column
    const sampleValue = data.rows.find(row => row[i] != null)?.[i];
    return detectTimestampType(sampleValue) !== null;
  });

  // Create formatted rows
  const formattedRows = data.rows.map(row =>
    row.map((value, colIndex) => {
      if (timestampColIndices[colIndex]) {
        return formatTimestamp(value, timestampFormat, options);
      }
      return formatCellValue(value, data.columns[colIndex], options);
    })
  );

  return {
    columns: data.columns,
    rows: data.rows, // Original rows
    formattedRows, // Formatted for display
    metadata: data.metadata
  };
}

/**
 * Build transforms configuration from chart data_mapping
 * This converts the database data_mapping format to the transforms format
 * used by transformData()
 *
 * @param {Object} dataMapping - Chart data_mapping object
 * @returns {Object|null} - Transforms config or null if no transforms needed
 */
export function buildTransformsFromMapping(dataMapping) {
  if (!dataMapping) return null;

  const { filters, aggregation, sort_by, sort_order, limit, sliding_window } = dataMapping;
  const hasSlidingWindow = sliding_window?.duration > 0 && sliding_window?.timestamp_col;
  const hasTransforms = (filters?.length > 0) || aggregation?.type || sort_by || (limit > 0) || hasSlidingWindow;

  if (!hasTransforms) return null;

  return {
    slidingWindow: hasSlidingWindow ? {
      duration: sliding_window.duration,
      timestampCol: sliding_window.timestamp_col
    } : null,
    filters: (filters || []).map(f => ({
      field: f.field,
      op: f.op,
      value: (f.op === 'in' || f.op === 'notIn') && typeof f.value === 'string'
        ? f.value.split(',').map(v => v.trim())
        : f.value
    })),
    aggregation: aggregation?.type ? aggregation : null,
    sortBy: sort_by || null,
    sortOrder: sort_order || 'desc',
    limit: limit || 0
  };
}

export default transformData;
