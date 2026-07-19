// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Data Client
 * API wrapper for data layer queries
 */

import apiClient from './client';

/**
 * Query data from a connection
 * @param {string} connectionId - ID of the connection
 * @param {object} query - Query parameters (raw, type, params)
 * @param {boolean} useCache - Whether to use cache (default: true). Currently informational only — the server doesn't implement a cache layer for /api/connections/:id/query.
 * @param {object} [opts] - { timeout?: number } per-call request timeout in ms (forwarded to apiClient.request).
 * @returns {Promise<object>} Query result with data and source
 */
export async function queryData(connectionId, query, useCache = true, opts = {}) {
  try {
    const requestOpts = {
      method: 'POST',
      body: JSON.stringify({ query: query }),
    };
    if (typeof opts.timeout === 'number') requestOpts.timeout = opts.timeout;
    // A caller-supplied abort signal lets useData cancel a superseded query
    // (e.g. a range switch before the slow prior fetch returns) so the browser
    // frees the connection instead of holding it open on an abandoned request.
    if (opts.signal) requestOpts.signal = opts.signal;
    const response = await apiClient.request(`/api/connections/${connectionId}/query`, requestOpts);

    // Adapter failures come back as HTTP 200 with {success:false, error}
    // — throw so useData's error state (and the panel's inline error
    // notification) fires instead of rendering an empty chart.
    if (response && response.success === false) {
      throw new Error(response.error || 'Query failed');
    }

    // The backend returns result_set with columns and rows
    return {
      data: response.result_set,
      source: useCache ? 'cache' : 'connection',
      cached: useCache
    };
  } catch (error) {
    console.error('Data query error:', error);
    throw new Error(error.message || 'Failed to query data');
  }
}

/**
 * Execute a component's STORED query by reference (#23). View mode uses
 * this instead of queryData so the query text never crosses the wire —
 * the server loads the component's query_config and merges only the
 * runtime values below.
 * @param {string} componentId - ID of the (post-override effective) component
 * @param {object} runtime - { connection_id?, dashboard_variable?, range? }
 *   connection_id: effective connection when a connection-swap variable is active
 *   dashboard_variable: active filter-variable value (send '' for token-present/no-value)
 *   range: structured range intent ({type:'relative',token} | {type:'absolute',from,to})
 * @param {boolean} useCache - Same informational flag as queryData
 * @param {object} [opts] - { timeout?: number }
 * @returns {Promise<object>} same shape as queryData()
 */
export async function queryComponentData(componentId, runtime = {}, useCache = true, opts = {}) {
  try {
    const body = {};
    if (runtime.connection_id) body.connection_id = runtime.connection_id;
    if (runtime.dashboard_variable !== undefined && runtime.dashboard_variable !== null) {
      body.dashboard_variable = runtime.dashboard_variable;
    }
    if (runtime.range) body.range = runtime.range;

    const requestOpts = {
      method: 'POST',
      body: JSON.stringify(body),
    };
    if (typeof opts.timeout === 'number') requestOpts.timeout = opts.timeout;
    // See queryData: a caller signal cancels a superseded fetch browser-side.
    if (opts.signal) requestOpts.signal = opts.signal;
    const response = await apiClient.request(`/api/components/${componentId}/data`, requestOpts);

    // Same 200-with-{success:false} contract as queryData — surface it.
    if (response && response.success === false) {
      throw new Error(response.error || 'Query failed');
    }

    return {
      data: response.result_set,
      source: useCache ? 'cache' : 'connection',
      cached: useCache
    };
  } catch (error) {
    console.error('Component data query error:', error);
    throw new Error(error.message || 'Failed to query data');
  }
}

// ── Shared backfill dedup ──────────────────────────────────────────────
// Streaming charts share ONE websocket per connection (StreamConnection-
// Manager), but each panel historically ran its OWN backfill REST query.
// N identical panels on the same connection → N redundant identical
// `newest <limit>` fetches at mount, which overloads the source and trips
// the request timeout (only the first few win the race). This dedups
// IDENTICAL backfills (same connection + same query) into a single
// in-flight request, then briefly caches the result so a panel that
// mounts a moment later reuses it instead of re-fetching. Panels that
// backfill a DIFFERENT window (distinct query) get their own request —
// the key includes the full query, so correctness is preserved.

const inflight = new Map();   // key -> Promise<result>
const recent = new Map();     // key -> { result, at }
const RECENT_TTL_MS = 10_000; // late subscribers within 10s reuse the result

function backfillKey(connectionId, query) {
  return `${connectionId}::${JSON.stringify(query)}`;
}

// perfNow avoids Date.now() coupling and works in tests/SSR.
function perfNow() {
  return typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : 0;
}

/**
 * Deduped backfill query. Concurrent or near-concurrent identical calls
 * (same connectionId + query) share a single underlying request/result.
 * Use ONLY for idempotent read backfills where sharing a snapshot across
 * panels is correct — not for per-panel live data.
 *
 * @param {string} connectionId
 * @param {object} query
 * @param {object} [opts] - { timeout?: number }
 * @returns {Promise<object>} the same shape as queryData()
 */
export function queryBackfillShared(connectionId, query, opts = {}) {
  const key = backfillKey(connectionId, query);

  // Fresh recent result → reuse without a new request.
  const cached = recent.get(key);
  if (cached && (perfNow() - cached.at) < RECENT_TTL_MS) {
    return Promise.resolve(cached.result);
  }

  // Identical request already in flight → join it.
  const pending = inflight.get(key);
  if (pending) return pending;

  const p = queryData(connectionId, query, false, opts)
    .then((result) => {
      recent.set(key, { result, at: perfNow() });
      return result;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, p);
  return p;
}
