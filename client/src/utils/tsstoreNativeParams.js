// ts-store-native query params a component can author (#202), stored verbatim
// in query_config.params and forwarded by the Go adapter (nativeParams in
// connection/substitution.go). ts-store does the work; these helpers only
// hold, validate, and serialize the values. Blank = not sent = ts-store's own
// default.
//
//   agg_window   bucket size; wins over a range picker's step (ts-store rejects both)
//   agg_default  function for every numeric field ("avg", or "avg,max")
//   agg_fields   per-field functions ("temperature:avg,events:sum")
//   window       /newest lookback when filtering or aggregating with no since
//   scan_limit   record budget for latest_by (no filter/since) and filtered /oldest

// ts-store's aggregation functions (internal/aggregation/aggregation.go).
export const TSSTORE_AGG_FUNCTIONS = ['avg', 'sum', 'min', 'max', 'first', 'last', 'count', 'stddev'];

export const EMPTY_TSSTORE_NATIVE = { aggWindow: '', aggDefault: '', aggFields: '', window: '', scanLimit: '' };

// Which editor query types each param reaches in ts-store. 'since' sends an
// explicit since (window ignored); 'range' hits /data/range (no scan bounds);
// 'latest' is latest_by (no aggregation); 'oldest' has no aggregation.
const APPLIES = {
  agg: ['since', 'range', 'newest'],
  window: ['newest', 'latest'],
  scanLimit: ['latest', 'oldest'],
};

export const tsstoreNativeApplies = (group, queryType) => APPLIES[group].includes(queryType);

export function tsstoreNativeFromParams(params) {
  const str = (k) => (typeof params?.[k] === 'string' ? params[k].trim() : '');
  const scan = params?.scan_limit;
  return {
    aggWindow: str('agg_window'),
    aggDefault: str('agg_default'),
    aggFields: str('agg_fields'),
    window: str('window'),
    scanLimit: typeof scan === 'number' ? String(scan) : (typeof scan === 'string' ? scan.trim() : ''),
  };
}

// Serialize for query_config.params, keeping only non-blank values that apply
// to the query type — a stale value from another type isn't persisted.
export function tsstoreNativeToParams(native, queryType) {
  if (!native) return {};
  const out = {};
  const put = (key, value) => {
    const v = (value || '').trim();
    if (v) out[key] = v;
  };
  if (tsstoreNativeApplies('agg', queryType)) {
    put('agg_window', native.aggWindow);
    put('agg_default', native.aggDefault);
    put('agg_fields', native.aggFields);
  }
  if (tsstoreNativeApplies('window', queryType)) put('window', native.window);
  if (tsstoreNativeApplies('scanLimit', queryType) && (native.scanLimit || '').trim() !== '') {
    out.scan_limit = Number(native.scanLimit);
  }
  return out;
}

export const tsstoreNativeHasValues = (native) =>
  Object.values(native || {}).some((v) => (v || '').trim() !== '');

// Durations ts-store accepts: Go durations (5m, 1h30m, 90s) plus d/w/mo/y.
const GO_DURATION = /^(\d+(\.\d+)?(ns|us|ms|s|m|h))+$/;
const LONG_DURATION = /^\d+(\.\d+)?(d|w|mo|y)$/;
const isDuration = (v) => GO_DURATION.test(v) || LONG_DURATION.test(v);

// Each validator returns an error message, or null when valid. Blank is valid.
export function validateTsstoreDuration(value, { allowZero = false } = {}) {
  const v = (value || '').trim();
  if (!v || (allowZero && v === '0')) return null;
  return isDuration(v) ? null : `Use a duration like 30s, 5m, 1h, or 1d${allowZero ? ' (0 = whole store)' : ''}`;
}

export function validateAggFields(value) {
  const v = (value || '').trim();
  if (!v) return null;
  for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [field, fns, extra] = part.split(':').map((p) => p.trim());
    if (!field || !fns || extra !== undefined) return `"${part}" — expected field:function`;
    for (const fn of fns.split('+').map((f) => f.trim())) {
      if (!TSSTORE_AGG_FUNCTIONS.includes(fn)) {
        return `"${fn}" isn't a ts-store function (${TSSTORE_AGG_FUNCTIONS.join(', ')})`;
      }
    }
  }
  return null;
}

export function validateScanLimit(value) {
  const v = (value || '').trim();
  if (!v) return null;
  return /^\d+$/.test(v) ? null : 'A whole number (0 = unbounded)';
}
