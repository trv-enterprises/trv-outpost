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
    const response = await apiClient.request(`/api/connections/${connectionId}/query`, requestOpts);

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
