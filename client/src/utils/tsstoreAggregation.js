// Component-authored ts-store server-side aggregation (#202): agg_window /
// agg_default / agg_fields in query_config.params. Pure helpers shared by the
// component editor's state, save, and preview paths.
//
// Server semantics (see setAggregationParams in the Go ts-store adapter):
//   - agg_window is a FLOOR on the bucket size — on a dashboard with a range
//     picker, the picker's step is used instead when it's coarser.
//   - With no agg_window, the function(s) apply at the range picker's step.
//   - Suppressed under latest_by (ts-store rejects the combination).

// ts-store's aggregation functions (internal/aggregation/aggregation.go).
export const TSSTORE_AGG_FUNCTIONS = ['avg', 'sum', 'min', 'max', 'first', 'last', 'count', 'stddev'];

export const EMPTY_TSSTORE_AGG = { enabled: false, window: '', func: 'avg', fields: '' };

// Query types that can carry aggregation. 'oldest' has no aggregation in
// ts-store; 'latest' (latest_by) is mutually exclusive with it.
export const tsstoreQueryTypeSupportsAgg = (queryType) =>
  queryType === 'since' || queryType === 'range' || queryType === 'newest';

// Restore editor state from saved params. Any of the three keys marks the
// section enabled. A saved agg_default that isn't a single known function
// (e.g. an API-authored "avg,max") is kept verbatim rather than silently
// rewritten on the next save.
export function tsstoreAggFromParams(params) {
  const str = (k) => (typeof params?.[k] === 'string' ? params[k].trim() : '');
  const window = str('agg_window');
  const func = str('agg_default');
  const fields = str('agg_fields');
  if (!window && !func && !fields) return { ...EMPTY_TSSTORE_AGG };
  return { enabled: true, window, func: func || 'avg', fields };
}

// Serialize editor state to query_config.params entries. The function is
// always sent when enabled so the result doesn't depend on which window
// param reaches ts-store (a bare agg_window defaults to "last", a step to
// "avg").
export function tsstoreAggToParams(agg) {
  if (!agg?.enabled) return {};
  const params = { agg_default: agg.func || 'avg' };
  const window = (agg.window || '').trim();
  const fields = (agg.fields || '').trim();
  if (window) params.agg_window = window;
  if (fields) params.agg_fields = fields;
  return params;
}

// Durations ts-store accepts: Go durations (5m, 1h30m, 90s) plus whole d/w.
const GO_DURATION = /^(\d+(\.\d+)?(ms|s|m|h))+$/;
const DAY_WEEK = /^\d+[dw]$/;

// Returns an error message, or null when valid. Blank is valid (no window).
export function validateAggWindow(value) {
  const v = (value || '').trim();
  if (!v) return null;
  if (!GO_DURATION.test(v) && !DAY_WEEK.test(v)) {
    return 'Use a duration like 30s, 5m, 1h, or 1d';
  }
  return null;
}

// Validates "field:func,field:func". One function per field: ts-store's
// multi-function form ("cpu:avg+max") renames the output columns (cpu_avg,
// cpu_max), which the component's column mapping can't follow. Blank is valid.
export function validateAggFields(value) {
  const v = (value || '').trim();
  if (!v) return null;
  for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [field, fn, extra] = part.split(':').map((p) => p.trim());
    if (!field || !fn || extra !== undefined) {
      return `"${part}" — expected field:function`;
    }
    if (fn.includes('+')) {
      return `"${part}" — one function per field (multiple functions rename the columns)`;
    }
    if (!TSSTORE_AGG_FUNCTIONS.includes(fn)) {
      return `"${fn}" isn't a ts-store function (${TSSTORE_AGG_FUNCTIONS.join(', ')})`;
    }
  }
  return null;
}
