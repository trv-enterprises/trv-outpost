// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * useData Hook
 * React hook for fetching data from datasources with caching
 * Automatically uses SSE streaming for socket datasources, polling for others
 * Supports time-bucketed aggregation for socket datasources via timeBucket option
 *
 * Usage:
 * const { data, loading, error, refetch } = useData({
 *   connectionId: 'uuid',
 *   query: {
 *     raw: '/readings',
 *     type: 'api',
 *     params: {}
 *   },
 *   refreshInterval: 5000, // Optional: auto-refresh every 5 seconds (ignored for streaming)
 *   timeBucket: {          // Optional: server-side aggregation for socket datasources
 *     interval: 60,        // Bucket size in seconds
 *     function: 'avg',     // avg, sum, min, max, count
 *     value_cols: ['temp', 'humidity'],
 *     timestamp_col: 'timestamp'
 *   }
 * });
 *
 * Returns data in format: { columns: [], rows: [] }
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { queryData, queryComponentData, queryBackfillShared } from '../api/dataClient';
import apiClient from '../api/client';
import StreamConnectionManager from '../utils/streamConnectionManager';
import { getStreamBufferSize } from '../utils/streamBufferConfig';
import { TSSTORE_MAX_POINTS, connectionTypeConsumesRange } from '../utils/rangePresets';
import { useRegisterRefreshable } from '../context/RefreshableComponentsContext';

// Backfill queries can pull up to the full stream buffer (e.g. `newest
// 1000`), which is heavier than a normal API call. Give them a longer
// timeout than the 15s client default so a slow source (or a busy one at
// dashboard mount) doesn't trip the timeout before the rows arrive.
const BACKFILL_TIMEOUT_MS = 45_000;

// A ranged REST query (a whole time window, e.g. 24h of ts-store points) is as
// heavy as a backfill and far heavier than a normal poll — a 24h ts-store pull
// measured ~5.6s. Use the same generous ceiling as backfill so a legitimate
// wide-window query isn't aborted before its rows arrive; the 15s client
// default would trip a real 24h fetch. This bounds a truly hung request; a
// superseded one is aborted immediately by the next fetch, not by this timeout.
const REST_FETCH_TIMEOUT_MS = 45_000;

/**
 * isAbortError — was this error a deliberate fetch/stream abort, across browsers?
 * Chrome throws a DOMException named 'AbortError'. Firefox, when a STREAMING
 * fetch (response.body reader) is aborted mid-read, throws a TypeError whose
 * message is "Error in input stream" or "NetworkError when attempting to fetch
 * resource" — NOT named AbortError. Keying only on the name lets Firefox aborts
 * fall through as real errors (spurious panel "Data Error", and — on the
 * aggregated SSE path — an endless reconnect→new-aggregator loop). Prefer a
 * caller-supplied signal when available; fall back to name + message sniffing.
 */
function isAbortError(err, signal = null) {
  if (signal?.aborted) return true;
  if (err?.name === 'AbortError') return true;
  const msg = String(err?.message || '');
  return /input stream|NetworkError when attempting to fetch/i.test(msg);
}

// isAuthErrorMessage — did this error come from the SOURCE rejecting our
// credentials (as opposed to a timeout, a network drop, or a bad query)?
//
// Message-matched because the data client flattens server errors to text.
// The shapes this must catch, both produced server-side:
//   "TSStore API error (status 401): {\"error\":\"API key required\"}"
//   "authentication required: this store expects an API key but none is configured"
// Deliberately does NOT match the dashboard's own session-auth failures
// ("Authentication required" alone would — hence the source-shaped
// patterns first) ... but a session failure surfacing on a panel is still
// more honest than an eternal spinner, so the broad terms stay.
function isAuthErrorMessage(err) {
  return /status 40[13]\b|api key|authentication required|unauthorized/i.test(err?.message || '');
}


/**
 * Extract a nested value from an object using dot-notation path.
 * E.g., getNestedValue({a: {b: {c: 1}}}, 'a.b.c') → 1
 */
function getNestedValue(obj, path) {
  if (!path || !obj) return obj;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Apply parser config to a streaming record.
 * Extracts nested data from envelope formats (e.g., ts-store MQTT: {type, timestamp, data: {...}})
 * and normalizes timestamps.
 */
function applyParser(record, parser) {
  if (!parser) return record;

  let result = { ...record };

  // Extract and normalize timestamp BEFORE extracting data path
  // (timestamp is often at the envelope level, not inside data)
  if (parser.timestampField) {
    let ts = getNestedValue(record, parser.timestampField);
    if (ts != null) {
      if (typeof ts === 'number') {
        const scale = parser.timestampScale;
        if (scale === 'ns') ts = ts / 1e9;
        else if (scale === 'ms') ts = ts / 1e3;
        else if (!scale) {
          // Auto-detect: >1e15 = ns, >1e12 = ms, else seconds
          if (ts > 1e15) ts = ts / 1e9;
          else if (ts > 1e12) ts = ts / 1e3;
        }
      }
      // Will be set on the result after data extraction
      var parsedTimestamp = ts;
    }
  }

  // Extract nested data at data_path
  if (parser.dataPath) {
    const nested = getNestedValue(record, parser.dataPath);
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      result = { ...nested };
    }
  }

  // Apply the extracted timestamp to the result
  if (parsedTimestamp != null) {
    result.timestamp = parsedTimestamp;
  }

  return result;
}

// componentId (optional) switches polling to execute-by-reference (#23):
// the fetch POSTs only runtime values to /api/components/:id/data and the
// SERVER runs the component's stored query — no query text on the wire.
// Only view surfaces pass it (PanelContent, ComponentExpandModal); editor/AI
// previews must NOT, since their query is dirty/unsaved and needs the raw
// /query path. The `query` prop is still required either way — token
// presence and value identity (what triggers refetches) are derived from it.
export function useData({ connectionId, query, componentId = null, refreshInterval = null, useCache = true, maxBuffer = null, timeBucket = null, backfill = null, parser = null, refreshTick = 0, rangeValue = null, seriesCol = '' }) {
  // A per-call maxBuffer wins; otherwise use the deployment-wide default
  // (admin setting stream_buffer_size, set at bootstrap). Applies to both
  // spec-driven and eval'd custom-code charts.
  //
  // When a dashboard RANGE is active, the buffer must hold the whole windowed
  // backfill — the live-tail default (1000) would re-clip a wide window to its
  // most-recent 1000 points (e.g. 24h@1m = 1442 rows trimmed to ~16.6h), the
  // client-side twin of the server buffer-limit trap. The server already caps a
  // ranged pull at the step point budget, so that budget is the natural ceiling
  // — the window can never return more. Take the larger of it and the live
  // buffer so a bigger admin buffer isn't shrunk, and an explicit maxBuffer
  // still wins. TSSTORE_MAX_POINTS is the right (and only) budget here: the
  // ranged streaming-backfill path below is ts-store-only. If another step-aware
  // type ever gains one, switch to maxPointsForType(datasourceType).
  const rangeActive = !!(rangeValue && rangeValue.type);
  const baseBuffer = (Number.isFinite(maxBuffer) && maxBuffer > 0) ? maxBuffer : getStreamBufferSize();
  const effectiveMaxBuffer = rangeActive ? Math.max(baseBuffer, TSSTORE_MAX_POINTS) : baseBuffer;
  // Common state
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [source, setSource] = useState(null);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [disconnectedSince, setDisconnectedSince] = useState(null);

  // Datasource type detection
  const [datasourceType, setDatasourceType] = useState(null);
  const [datasourceTransport, setDatasourceTransport] = useState(null); // e.g., "rest" or "streaming" for tsstore
  const [typeLoading, setTypeLoading] = useState(true);

  // Refs for cleanup
  const mountedRef = useRef(true);
  const fetchingRef = useRef(false);
  // Monotonic fetch generation. Bumped whenever the query identity changes so a
  // slow in-flight fetch (a) doesn't block the new one and (b) can't apply its
  // stale result over the newer query's data. Without this, rapidly switching a
  // range (e.g. 24h → 6h before the slow 24h fetch returns) either dropped the
  // new fetch — the fetchingRef "prevent concurrent" guard early-returned it —
  // or let the late 24h response clobber the 6h data.
  const fetchGenRef = useRef(0);
  // AbortController for the in-flight REST fetch. A new fetch (query change or
  // interval tick) aborts the previous one so the browser frees the connection
  // instead of hanging on an abandoned slow request (e.g. a 24h ts-store pull
  // superseded by a 6h switch). We can't stop the upstream ts-store work — that
  // runs to completion or times out — but the browser stops waiting on it.
  const fetchAbortRef = useRef(null);
  const intervalRef = useRef(null);
  const eventSourceRef = useRef(null);
  const columnsRef = useRef([]);
  const disconnectedSinceRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);

  // Serialize query for stable dependency comparison
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  // Serialize parser for stable dependency — parser is an object that may be recreated each render
  const parserKey = useMemo(() => JSON.stringify(parser), [parser]);
  // Stable parser reference — only changes when content changes
  const stableParser = useMemo(() => parser, [parserKey]);

  // Fetch datasource type on mount
  useEffect(() => {
    if (!connectionId) {
      setTypeLoading(false);
      return;
    }

    let cancelled = false;

    const fetchType = async () => {
      try {
        const ds = await apiClient.getConnection(connectionId);
        if (!cancelled && mountedRef.current) {
          setDatasourceType(ds.type);
          // Extract transport for tsstore (determines REST vs streaming)
          if (ds.type === 'tsstore') {
            setDatasourceTransport(ds.config?.tsstore?.transport || 'rest');
          }
          setTypeLoading(false);
        }
      } catch (err) {
        console.error('[useData] Failed to fetch datasource type:', err);
        if (!cancelled && mountedRef.current) {
          // Default to non-streaming on error
          setDatasourceType('unknown');
          setTypeLoading(false);
        }
      }
    };

    fetchType();

    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  // Streaming datasource types use SSE instead of polling
  // TSStore only streams when transport is explicitly set to "streaming"
  const isStreamingType = datasourceType === 'socket' || datasourceType === 'mqtt'
    || (datasourceType === 'tsstore' && datasourceTransport === 'streaming');

  // Register this useData consumer with the RefreshableComponents
  // context once we KNOW it's polling (not streaming). The dashboard
  // toolbar reads the count and shows/hides the manual refresh
  // button — there's nothing useful for the user to click if the
  // dashboard has only streaming components. No-ops outside a
  // provider (e.g. Design preview, AI builder).
  useRegisterRefreshable(!!connectionId && !typeLoading && !isStreamingType);

  // === STREAMING LOGIC (for streaming datasources) ===
  // Batch incoming records and flush once per animation frame to avoid
  // partial-batch re-renders that cause x-axis flicker on line charts.
  const pendingRecordsRef = useRef([]);
  const flushRAFRef = useRef(null);
  const backfillDoneRef = useRef(false); // Backfill once per useData lifecycle, not per reconnect

  // Clear streaming buffers + displayed data and re-arm the backfill so the
  // next load starts from a clean slate. Shared by the connection-change reset
  // and the range-change reset (stage 2 of #162) so their behavior can't drift.
  const resetForFreshLoad = useCallback(() => {
    pendingRecordsRef.current = [];
    if (flushRAFRef.current) {
      cancelAnimationFrame(flushRAFRef.current);
      flushRAFRef.current = null;
    }
    columnsRef.current = [];
    backfillDoneRef.current = false;
    setData(null);
    setError(null);
    setLoading(true);
  }, []);

  // Reset accumulated data when the connection changes (e.g. a dashboard
  // connection-swap repoints this panel to a different connection). Without
  // this, the old connection's rows linger, the new connection never
  // re-backfills (backfillDoneRef stays true), and the panel only updates on a
  // full page reload. Skip the very first mount — there's nothing to clear and
  // the normal load path handles it.
  const prevConnIdRef = useRef(connectionId);
  useEffect(() => {
    if (prevConnIdRef.current === connectionId) return;
    prevConnIdRef.current = connectionId;
    resetForFreshLoad();
  }, [connectionId, resetForFreshLoad]);

  const flushPendingRecords = useCallback(() => {
    flushRAFRef.current = null;
    if (!mountedRef.current || pendingRecordsRef.current.length === 0) return;

    const batch = pendingRecordsRef.current;
    pendingRecordsRef.current = [];

    setData((prev) => {
      const prevData = prev || { columns: [], rows: [] };

      // Union the column set across all records seen so far. New keys
      // appearing in this batch (e.g., after a parser config change, or
      // because a late-arriving topic has additional fields) get
      // appended; existing rows that didn't have those keys get `null`
      // appended in the rebuild below. This replaces the old
      // "lock-columns-on-first-record" behavior, which silently dropped
      // any field that wasn't in the very first record received.
      const colSet = new Set(prevData.columns);
      let columnsChanged = false;
      for (const rec of batch) {
        for (const key of Object.keys(rec)) {
          if (!colSet.has(key)) {
            colSet.add(key);
            columnsChanged = true;
          }
        }
      }
      const columns = columnsChanged ? Array.from(colSet) : prevData.columns;
      columnsRef.current = columns;

      // Existing rows need null-padding if the column set grew. Cheap
      // when columns didn't change (most of the time): reuse prev rows
      // as-is. When columns did grow, append nulls per existing row to
      // keep length == columns.length.
      const padCount = columns.length - prevData.columns.length;
      const paddedPrevRows = padCount > 0 && prevData.rows.length > 0
        ? prevData.rows.map(r => {
            if (r.length >= columns.length) return r;
            const out = r.slice();
            while (out.length < columns.length) out.push(null);
            return out;
          })
        : prevData.rows;

      // Convert this batch to rows using the unioned column order.
      const newRows = batch.map(record => columns.map(col => record[col] ?? null));

      let allRows = [...paddedPrevRows, ...newRows];
      if (allRows.length > effectiveMaxBuffer) {
        allRows = allRows.slice(allRows.length - effectiveMaxBuffer);
      }

      return { columns, rows: allRows };
    });
  }, [effectiveMaxBuffer]);

  const processStreamRecord = useCallback((record) => {
    if (!mountedRef.current) return;

    // Apply parser to extract data from envelope formats (e.g., ts-store MQTT)
    const parsed = applyParser(record, stableParser);
    pendingRecordsRef.current.push(parsed);

    // Schedule a single flush per animation frame
    if (!flushRAFRef.current) {
      flushRAFRef.current = requestAnimationFrame(flushPendingRecords);
    }
  }, [flushPendingRecords, stableParser]);

  // Serialize timeBucket for stable dependency comparison
  const timeBucketKey = useMemo(() => JSON.stringify(timeBucket), [timeBucket]);

  // Check if we should use aggregated streaming
  const useAggregated = useMemo(() => {
    return timeBucket && timeBucket.interval > 0 && timeBucket.timestamp_col && timeBucket.value_cols?.length > 0;
  }, [timeBucket]);

  // Grace period before showing error (30 seconds)
  const ERROR_GRACE_PERIOD = 30000;
  // Retry interval after grace period (keep trying every 30 seconds)
  const RETRY_INTERVAL = 30000;

  // Helper to format disconnection time
  const formatDisconnectTime = (timestamp) => {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleTimeString();
  };

  // Handle connection error with grace period
  const handleConnectionError = useCallback((reconnectFn) => {
    if (!mountedRef.current) return;

    // Track first disconnection time
    if (!disconnectedSinceRef.current) {
      disconnectedSinceRef.current = Date.now();
      setDisconnectedSince(disconnectedSinceRef.current);
    }

    reconnectAttemptsRef.current += 1;
    setConnected(false);
    setReconnecting(true);

    const timeSinceDisconnect = Date.now() - disconnectedSinceRef.current;

    // Only show error after grace period
    if (timeSinceDisconnect >= ERROR_GRACE_PERIOD) {
      const disconnectTime = formatDisconnectTime(disconnectedSinceRef.current);
      setError(new Error(`Connection lost since ${disconnectTime}, retrying...`));
    }

    // Always retry at regular intervals (don't give up)
    const delay = timeSinceDisconnect < ERROR_GRACE_PERIOD
      ? Math.min(1000 * Math.pow(2, reconnectAttemptsRef.current - 1), ERROR_GRACE_PERIOD - timeSinceDisconnect)
      : RETRY_INTERVAL;

    return setTimeout(reconnectFn, delay);
  }, []);

  // Handle successful connection
  const handleConnectionSuccess = useCallback(() => {
    if (!mountedRef.current) return;

    setConnected(true);
    setReconnecting(false);
    setError(null);
    setLoading(false);
    disconnectedSinceRef.current = null;
    setDisconnectedSince(null);
    reconnectAttemptsRef.current = 0;
  }, []);

  // Resolve effective backfill. Caller semantics:
  //   - undefined / null → use the type-default (only ts-store streaming
  //     gets one today; everything else stays empty).
  //   - false → explicit opt-out.
  //   - object → use as-is.
  // Default: pull the latest 1000 records so an unwindowed streaming
  // chart paints meaningful history immediately instead of sitting blank
  // (or showing just a handful of points) until new pushes arrive. 1000
  // matches maxBuffer — the live in-memory cap — so the initial paint and
  // the steady-state buffer hold the same depth. A chart WITH a sliding
  // window supersedes this with a since:<window> backfill (set by the
  // editor codegen). Single-value charts (gauge, number) should pass an
  // explicit backfill with `params: { limit: 1 }` to avoid the wasted fetch.
  // The component query's latest_by, as a stable primitive for the memo dep
  // (the query object's identity churns per render).
  const queryLatestBy = query?.params?.latest_by || '';
  const effectiveBackfill = useMemo(() => {
    if (backfill === false) return null;
    if (backfill) return backfill;
    if (datasourceType === 'tsstore' && datasourceTransport === 'streaming') {
      // Current State (latest per series): when the component's own query
      // carries latest_by, the seed IS the source-side reduction — one row
      // per series — not a raw history slice for the client to throw away.
      // Takes precedence over an active range: current state is a
      // point-in-time view, and ts-store rejects latest_by combined with a
      // stepped window anyway (the adapter suppresses step, but not the
      // range intent itself). No limit param — the result is one row per
      // series by construction. No group_by — it only partitions stepped
      // downsamples, and latest_by never combines with a step.
      // Live records then arrive per-series and the client-side dedupe
      // (the streaming twin in DynamicComponentLoader) keeps each series'
      // row current.
      if (queryLatestBy) {
        // BOUNDED with since:1h, for two reasons that happen to agree:
        //  1. ts-store's latest_by without a time bound does a FULL-STORE
        //     fetch+decode before deduping (the filter path got a default
        //     1h lookback in the same handler; latest_by never did) — it
        //     hangs 30s+ on ~24k-block stores and the server kills the
        //     connection (ts-store#140). Bounded: 0.13s on the same store.
        //  2. "Current state" semantics: a series silent for over an hour
        //     isn't current — stale series aging out of the seed is right,
        //     and the live stream keeps genuinely-current series fresh.
        return { raw: 'since:1h', type: 'tsstore', params: { latest_by: queryLatestBy } };
      }
      // When a dashboard range is active, the backfill should paint that WINDOW
      // rather than the latest N. Pass the range INTENT through unchanged — the
      // server's resolveRange/tsstoreRangeFromSpec translates it to since:/range:
      // + a clamped step (the same merged path the polling /query side uses), so
      // we must NOT build since:/range: strings here or the step clamp would
      // diverge. The row cap (not the buffer limit) applies server-side, so a
      // wide window isn't truncated. No range → the latest-N default.
      if (rangeValue && rangeValue.type) {
        // Pivot charts forward their series column as group_by so ts-store
        // partitions a stepped downsample per series (v0.18.0). Only meaningful
        // WITH a step; the adapter's setGroupByParam no-ops it without one.
        const params = { range: rangeValue };
        if (seriesCol) params.group_by = seriesCol;
        return { raw: 'newest', type: 'tsstore', params };
      }
      return { raw: 'newest', type: 'tsstore', params: { limit: getStreamBufferSize() } };
    }
    return null;
  }, [backfill, datasourceType, datasourceTransport, rangeValue, seriesCol, queryLatestBy]);
  const effectiveBackfillKey = useMemo(() => JSON.stringify(effectiveBackfill), [effectiveBackfill]);

  // Re-init on a backfill-query change (stage 2 of #162): a dashboard range
  // change alters effectiveBackfill (its params.range), so the streaming chart
  // must re-backfill the NEW window over clean state. Without this reset,
  // backfillDoneRef stays true from the first mount, the SSE effect re-runs (it
  // depends on effectiveBackfillKey) but SKIPS the backfill, and the old
  // window's rows stay in `data` while the new live subscription appends on top
  // — stale history glued to new-window live data. Resetting re-arms the
  // backfill so the re-run paints the new window fresh. Skip the first mount.
  //
  // "Skip the first mount" has to mean the first REAL key, not the first
  // render's key. datasourceType / datasourceTransport are populated by an
  // async getConnection() call, so on mount effectiveBackfill is null and
  // the key is the literal string "null"; it flips to the real query only
  // once that fetch resolves. Seeding the ref with the mount-time value
  // therefore guaranteed a spurious null->real "change" on every initial
  // load, which called resetForFreshLoad() and blew away the state the
  // backfill had just populated — a reset storm on first paint rather than
  // the range-change re-init this is for.
  //
  // Track only transitions between two RESOLVED keys.
  const prevBackfillKeyRef = useRef(null);
  useEffect(() => {
    // Not resolved yet — nothing to compare against, and nothing to reset.
    if (typeLoading) return;
    const prev = prevBackfillKeyRef.current;
    prevBackfillKeyRef.current = effectiveBackfillKey;
    // First resolved key: record it, don't treat it as a change.
    if (prev === null) return;
    if (prev === effectiveBackfillKey) return;
    resetForFreshLoad();
  }, [effectiveBackfillKey, typeLoading, resetForFreshLoad]);

  // Connect to SSE stream for socket datasources (raw or aggregated)
  useEffect(() => {
    if (typeLoading || !isStreamingType || !connectionId) {
      return;
    }


    mountedRef.current = true;
    // Per-RUN liveness. mountedRef CANNOT express "this effect run was
    // superseded": it's one ref shared by every run, and the replacement run
    // re-arms it to true — so an async continuation from a superseded run
    // (a slow backfill resolving after a connection-swap repointed the panel)
    // passes the mountedRef check, appends the OLD connection's rows into the
    // freshly reset buffer, and then subscribes a ZOMBIE live stream whose
    // cleanup already ran (nothing ever unsubscribes it). `cancelled` is
    // closed over per-run: its cleanup — and only its cleanup — sets it.
    let cancelled = false;
    let reconnectTimeout = null;
    let abortController = null;

    // Reference to unsubscribe function for shared connection
    let unsubscribeFromManager = null;

    const connectAggregated = () => {
      if (cancelled || !mountedRef.current) return;

      // Aggregated streams now ride the shared multiplex pipe (issue #187
      // stage 2) instead of a dedicated fetch-stream per chart. Two charts
      // with matching bucket params share one server-side aggregator AND
      // one pipe subscription. The manager routes bucket records here; we
      // strip the internal _bucket_* metadata before processing.
      const manager = StreamConnectionManager.getInstance();
      unsubscribeFromManager = manager.subscribeAggregated(
        connectionId,
        {
          interval: timeBucket.interval,
          function: timeBucket.function || 'avg',
          value_cols: timeBucket.value_cols,
          timestamp_col: timeBucket.timestamp_col,
          series_col: timeBucket.series_col || '', // Column for bucket partitioning (e.g., location)
        },
        (bucket) => {
          if (!mountedRef.current) return;
          const { _bucket_function, _bucket_interval, _bucket_timestamp, ...record } = bucket;
          processStreamRecord(record);
        },
        {
          onConnect: () => {
            if (mountedRef.current) {
              handleConnectionSuccess();
              setSource('aggregated-stream');
            }
          },
          onDisconnect: () => {
            if (mountedRef.current) {
              handleConnectionError(() => {}); // manager handles reconnect
            }
          },
          onReconnecting: () => {
            if (mountedRef.current) setReconnecting(true);
          },
          onError: (info) => {
            if (mountedRef.current) {
              setReconnecting(false);
              setError(new Error(info?.message || 'Aggregated stream failed'));
            }
          },
        }
      );

      const status = manager.getStatus(connectionId);
      if (status.connected) {
        handleConnectionSuccess();
        setSource('aggregated-stream');
      }
    };

    // Extract topic filter from query for MQTT datasources
    const parsedQuery = query ? (typeof query === 'string' ? null : query) : null;
    const topicFilter = (datasourceType === 'mqtt' && parsedQuery?.raw) ? parsedQuery.raw : null;

    const connectRawShared = () => {
      if (cancelled || !mountedRef.current) return;

      // Use shared connection manager for raw streams
      const manager = StreamConnectionManager.getInstance();

      // First, load any buffered data from the manager.
      // Skip buffer replay when backfill is configured — the REST backfill query is
      // the authoritative source for historical data within the sliding window.
      if (!effectiveBackfill) {
        const bufferedRecords = manager.getBuffer(connectionId, topicFilter);
        if (bufferedRecords.length > 0) {
          bufferedRecords.forEach(record => {
            if (mountedRef.current) {
              processStreamRecord(record);
            }
          });
        }
      }

      // Subscribe to the shared connection (with optional topic filter for MQTT)
      unsubscribeFromManager = manager.subscribe(
        connectionId,
        (record) => {
          if (mountedRef.current) {
            processStreamRecord(record);
          }
        },
        {
          topics: topicFilter,
          skipBufferReplay: !!effectiveBackfill,
          onConnect: () => {
            if (mountedRef.current) {
              handleConnectionSuccess();
              setSource('stream');
            }
          },
          onDisconnect: () => {
            if (mountedRef.current) {
              handleConnectionError(() => {}); // Will be handled by manager's reconnect
            }
          },
          onReconnecting: (_attempts, _delay) => {
            if (mountedRef.current) {
              setReconnecting(true);
            }
          },
          // Terminal stream failure (e.g. a rejected ts-store api-key): the
          // manager has stopped reconnecting. Show the actionable message
          // immediately (bypass the reconnect grace period) so the panel
          // doesn't spin forever on a config that can't recover on its own.
          onError: (info) => {
            if (mountedRef.current) {
              setReconnecting(false);
              setError(new Error(info?.message || 'Stream connection failed'));
            }
          }
        }
      );

      // Check if already connected
      const status = manager.getStatus(connectionId, topicFilter);
      if (status.connected) {
        handleConnectionSuccess();
        setSource('stream');
      }
    };

    // Backfill: fire a one-shot REST query to pre-populate the buffer before streaming.
    // Only on first mount, NOT on every effect re-run/reconnect (would duplicate data).
    const runBackfillThenConnect = async () => {
      // Stage 5 (#162): an absolute range is a closed PAST window — there is
      // no live edge to tail, so the panel renders the backfill statically
      // and never subscribes to the stream. The range is folded into
      // effectiveBackfillKey, so switching back to a relative range (or
      // clearing it) re-runs this effect and restores the live tail.
      const historicalMode = effectiveBackfill?.params?.range?.type === 'absolute';
      let backfillError = null;
      if (effectiveBackfill && mountedRef.current && !backfillDoneRef.current) {
        try {
          // Deduped across panels on the same connection: N identical
          // panels share ONE backfill fetch instead of each issuing the
          // same `newest <limit>` query (which overloaded the source and
          // tripped the 15s default timeout — only the first few won the
          // race). Backfills can be large, so give them a longer timeout
          // than the default API call.
          //
          // A latest_by seed (Current State per Series) gets ONE fallback:
          // if the source-side reduction fails — ts-store's latest_by can
          // exceed the timeout on large stores (ts-store#140) — retry as a
          // plain `newest <buffer>` pull. The client-side dedupe reduces it
          // to one row per series anyway, so the fallback costs transfer,
          // not correctness; without it the panel sat blank for the whole
          // timeout and then started from an empty buffer.
          // The reduced seed gets a SHORT leash when a fallback exists: a
          // healthy store answers latest_by in ~3s, so 10s is generous —
          // and on a store where it hangs, waiting the full 45s just holds
          // the panel blank before the inevitable fallback.
          const seedTimeout = effectiveBackfill?.params?.latest_by ? 10_000 : BACKFILL_TIMEOUT_MS;
          let result;
          try {
            result = await queryBackfillShared(connectionId, effectiveBackfill, { timeout: seedTimeout });
          } catch (seedErr) {
            if (cancelled) return;
            if (!effectiveBackfill?.params?.latest_by || isAbortError(seedErr)) throw seedErr;
            console.warn('[useData] latest_by backfill failed, falling back to plain newest:', seedErr.message);
            result = await queryBackfillShared(
              connectionId,
              { raw: 'newest', type: 'tsstore', params: { limit: getStreamBufferSize() } },
              { timeout: BACKFILL_TIMEOUT_MS },
            );
          }
          // Superseded while awaiting (connection swap, range change,
          // unmount): drop the stale rows and stop — the replacement run
          // owns this panel now, and falling through would also subscribe
          // the OLD connection's stream (the zombie).
          if (cancelled) return;
          // Latch AFTER the await, not before: a run cancelled mid-fetch must
          // leave the latch open so its replacement re-fetches (latching
          // up-front left StrictMode's remount — and any superseded run —
          // with no backfill at all once the stale result was dropped).
          // Concurrent duplicate fetches aren't a risk: only the newest run
          // is uncancelled, and queryBackfillShared dedups the wire call.
          backfillDoneRef.current = true;
          if (mountedRef.current && result.data?.columns && result.data?.rows) {
            // Convert columnar result to record objects for processStreamRecord.
            // The chart trusts row order and never sorts (line.js builds a category
            // x-axis straight from arrival order), so backfill rows must be fed
            // OLDEST-FIRST to paint left→right, newest data on the right (the
            // industry-standard time-series direction).
            //
            // Order is DETECTED from the data, not assumed from the connection
            // type: ts-store's endpoints disagree — a plain `newest` pull returns
            // NEWEST-first (descending), but a `since:`/`range:` + step pull
            // returns OLDEST-first (ascending). Keying the reversal on type alone
            // (the old `datasourceType === 'tsstore'` heuristic) flipped the
            // stepped range path to newest-first → older data on the RIGHT.
            // Raw socket / websocket / mqtt arrive in arrival order (oldest-first)
            // and must not be reversed. Detecting from the timestamps handles all
            // of these without a per-endpoint table.
            const { columns, rows } = result.data;
            const tsColIdx = columns.indexOf(
              parser?.timestampField || 'timestamp'
            );
            const toMs = (v) => {
              if (v == null) return null;
              if (v instanceof Date) return v.getTime();
              const n = Number(v);
              // ts-store timestamps can be epoch ns/us/ms/s; magnitude-normalize
              // only enough to compare ORDER (absolute scale is irrelevant here).
              return Number.isFinite(n) ? n : Date.parse(v);
            };
            let descending = false;
            if (tsColIdx >= 0 && rows.length >= 2) {
              const firstTs = toMs(rows[0][tsColIdx]);
              const lastTs = toMs(rows[rows.length - 1][tsColIdx]);
              if (firstTs != null && lastTs != null) descending = firstTs > lastTs;
            } else if (tsColIdx < 0) {
              // No detectable timestamp column → fall back to the historical
              // type heuristic so non-timestamped ts-store pulls still order.
              descending = datasourceType === 'tsstore';
            }
            let ordered = descending ? [...rows].reverse() : rows;
            // Stage 3/4 seam (#162): when live data arrives via the AGGREGATED
            // stream, drop the backfill's trailing bucket. The REST backfill
            // Flushes its last window even when PARTIAL (batch.go), but the live
            // aggregator emits only CLOSED buckets (aggregator.go, "don't emit
            // current bucket"). So the newest backfill bucket is a partial avg,
            // and live will later emit that same bucket boundary as a COMPLETE
            // avg — appending both yields two rows at one timestamp (a doubled
            // x-tick + a small kink at the handoff). Dropping the partial lets
            // live own the leading edge cleanly. `ordered` is oldest-first, so
            // the trailing bucket is the last element. Only when aggregated (a
            // raw backfill has no live re-emit to defer to).
            // In historical mode there is no live re-emit — keep the partial
            // trailing bucket rather than losing the window's last bucket.
            if (useAggregated && !historicalMode && ordered.length > 0) {
              ordered = ordered.slice(0, -1);
            }
            ordered.forEach(row => {
              // A ts-store range/step pull emits a leading empty bucket with
              // timestamp 0 (epoch 1970). Left in, it drags the x-axis origin to
              // 1970 and crushes the real data into a sliver on the right. Drop
              // rows whose timestamp is missing/non-positive — only when we HAVE
              // a timestamp column to judge by (tsColIdx>=0), so non-timestamped
              // sources are unaffected.
              if (tsColIdx >= 0) {
                const t = toMs(row[tsColIdx]);
                if (t == null || t <= 0) return;
              }
              const record = {};
              columns.forEach((col, i) => { record[col] = row[i]; });
              processStreamRecord(record);
            });
          }
        } catch (err) {
          if (cancelled) return;
          // A real failure still latches: retrying on every reconnect would
          // hammer a source that's already struggling.
          backfillDoneRef.current = true;
          // AbortError here is a deliberate cancel; anything else means the
          // backfill couldn't paint history — the live stream still starts.
          if (!isAbortError(err)) {
            console.warn('[useData] Backfill query failed, streaming will start empty:', err.message);
            backfillError = err instanceof Error ? err : new Error(String(err));
          }
        }
      }

      if (cancelled) return;
      if (historicalMode) {
        if (mountedRef.current) {
          handleConnectionSuccess();
          // With no live stream to fall back on, a failed backfill would
          // otherwise leave a silently empty panel — surface it.
          if (backfillError) setError(backfillError);
        }
        return;
      }

      // AUTH failures are terminal for the whole connection, not just the
      // backfill: the live stream authenticates with the SAME credential,
      // so the "streaming will start empty" rationale for swallowing other
      // backfill errors is false here — nothing will ever paint and the
      // panel spins forever (how four un-keyed ts-store connections
      // presented: legend, no data, no error). Surface it and skip the
      // doomed subscribe.
      if (backfillError && isAuthErrorMessage(backfillError)) {
        if (mountedRef.current) {
          handleConnectionSuccess();
          setError(backfillError);
        }
        return;
      }

      // Now connect to the stream
      if (useAggregated) {
        connectAggregated();
      } else {
        connectRawShared();
      }
    };

    runBackfillThenConnect();

    // Cleanup on unmount or type change
    return () => {
      cancelled = true;
      mountedRef.current = false;
      if (flushRAFRef.current) {
        cancelAnimationFrame(flushRAFRef.current);
        flushRAFRef.current = null;
      }
      pendingRecordsRef.current = [];
      if (reconnectTimeout) {
        clearTimeout(reconnectTimeout);
      }
      if (abortController) {
        abortController.abort();
      }
      // Unsubscribe from shared connection manager
      if (unsubscribeFromManager) {
        unsubscribeFromManager();
        unsubscribeFromManager = null;
      }
      // Legacy cleanup (for aggregated streams which still use direct EventSource)
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [connectionId, datasourceType, datasourceTransport, typeLoading, processStreamRecord, useAggregated, timeBucketKey, effectiveBackfillKey, handleConnectionError, handleConnectionSuccess]);

  // === POLLING LOGIC (for non-socket datasources) ===
  // isInitialFetch tracks whether this is the first load (shows loading state)
  // vs a background refresh (keeps showing current data)
  const isInitialFetchRef = useRef(true);

  // Single fetch dispatcher for the polling paths. With a componentId we
  // execute by reference — runtime values only, extracted from the same
  // effectiveQuery params the raw path would have sent (so refetch
  // triggers and value semantics are identical). Without one (design/AI
  // previews, legacy code-supplied queries) the raw query body goes out
  // as before.
  const runQuery = useCallback(async (useCacheArg, opts = {}) => {
    // The dashboard range is a TIME WINDOW — only inject it for connection
    // types that actually handle one (sql/edgelake/tsstore/prometheus).
    // Non-time sources like `api` have no range handling; sending the range
    // makes the upstream reject the request (e.g. Proxmox → "400 Parameter
    // verification failed"). Gate on the RESOLVED connection type here (not
    // query_config.type, which isn't reliably the connection type — many
    // tsstore charts carry query_config.type:"api"). A time-window design
    // for API connections is future work; until then APIs get no range.
    const rangeOk = connectionTypeConsumesRange(datasourceType);
    if (componentId) {
      const params = query?.params || {};
      const runtime = { connection_id: connectionId };
      // Preserve an explicit '' — token present with no value set must
      // still reach the server so it can answer "variable not set".
      if ('dashboard_variable' in params) runtime.dashboard_variable = params.dashboard_variable;
      if (params.range && rangeOk) runtime.range = params.range;
      return queryComponentData(componentId, runtime, useCacheArg, opts);
    }
    // Raw path: strip params.range when the connection can't consume it so
    // the range never reaches an API adapter's request builder.
    if (!rangeOk && query?.params?.range) {
      const { range: _range, ...restParams } = query.params;
      return queryData(connectionId, { ...query, params: restParams }, useCacheArg, opts);
    }
    return queryData(connectionId, query, useCacheArg, opts);
  }, [componentId, connectionId, queryKey, datasourceType]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchData = useCallback(async (forceShowLoading = false) => {
    if (!connectionId || !query) {
      setError(new Error('connectionId and query are required'));
      setLoading(false);
      return;
    }

    // This fetch's generation. runQuery closes over the current query (via the
    // useCallback deps), so when queryKey changes a NEW fetchData is created
    // with a bumped generation; a stale in-flight fetch is detectable by
    // comparing its captured gen against the ref on return.
    fetchGenRef.current += 1;
    const myGen = fetchGenRef.current;
    fetchingRef.current = true;

    // Abort the previous in-flight fetch so the browser stops waiting on a
    // superseded request. Then arm this fetch's own controller with a timeout
    // (the abort path below classifies as a normal failure, not applied data).
    if (fetchAbortRef.current) fetchAbortRef.current.abort();
    const abortController = new AbortController();
    fetchAbortRef.current = abortController;
    const timeoutHandle = setTimeout(() => abortController.abort(), REST_FETCH_TIMEOUT_MS);

    try {
      // Only show loading spinner on initial fetch or when explicitly requested
      // This prevents the chart from going blank during auto-refresh
      if (isInitialFetchRef.current || forceShowLoading) {
        setLoading(true);
      }
      setError(null);

      const result = await runQuery(useCache, { signal: abortController.signal });

      // Drop a stale result: a newer fetch (newer query) superseded this one
      // while it was in flight. Applying it would clobber the current query's
      // data with the old query's rows.
      if (mountedRef.current && myGen === fetchGenRef.current) {
        setData(result.data);
        setSource(result.source);
        setLoading(false);
        isInitialFetchRef.current = false; // Mark initial fetch as complete
      }
    } catch (err) {
      // An AbortError is NEVER a user-facing error — it's always one of our own
      // deliberate aborts: a superseded fetch (query/range/connection change), a
      // timeout, or the unmount/cleanup abort. Surfacing it renders a spurious
      // "Data Error: The operation was aborted" on the panel even though the data
      // is fine (or a newer fetch is already replacing it). This is broader than
      // the old myGen-only guard, which missed the case where the current fetch
      // is aborted by the SSE/connection-swap cleanup without a newer fetch in
      // THIS hook bumping the generation.
      const aborted = isAbortError(err, abortController.signal);
      if (mountedRef.current && myGen === fetchGenRef.current) {
        // This is the LATEST fetch (no newer one superseded it), so nobody else
        // will clear the loading state — we must, whether it errored or was
        // aborted. A non-abort error surfaces to the panel; an abort of the
        // latest fetch (e.g. the effect-cleanup abort with no successor, or a
        // timeout) is NOT a user error but still ends "loading" — otherwise the
        // panel hangs on the spinner forever with no error (the stuck-Loading
        // bug). A SUPERSEDED abort (older gen) is skipped: its successor owns
        // the state and will clear it.
        if (!aborted) setError(err);
        setLoading(false);
      }
    } finally {
      clearTimeout(timeoutHandle);
      // ALWAYS release the in-flight flag — every fetch that set it must clear
      // it, or a superseded fetch that never becomes "latest" leaves it stuck
      // true forever, permanently blocking refetch() (which early-returns on
      // fetchingRef) → the panel hangs on "Loading…". The generation guard is
      // for APPLYING results (above), not for releasing this flag.
      fetchingRef.current = false;
    }
  }, [connectionId, queryKey, useCache, runQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset initial fetch flag when datasource or query changes
  useEffect(() => {
    isInitialFetchRef.current = true;
  }, [connectionId, queryKey]);

  // Initial fetch for non-socket datasources
  useEffect(() => {
    if (typeLoading || isStreamingType || !connectionId) {
      return;
    }

    mountedRef.current = true;
    fetchData();

    return () => {
      mountedRef.current = false;
      // Abort any in-flight fetch on unmount / query change so a slow request
      // doesn't hold the browser connection open past the panel's life.
      if (fetchAbortRef.current) fetchAbortRef.current.abort();
    };
  }, [connectionId, queryKey, datasourceType, datasourceTransport, typeLoading, fetchData]);

  // Out-of-band refetch on `refreshTick` bump (polling charts only).
  // The dashboard viewer increments refreshTick when the user presses
  // the toolbar Refresh button or navigates between dashboards. Since
  // streaming charts already have live data and a rolling buffer, we
  // skip them — a forced refetch would only blip the chart and serve
  // no purpose. The first-render guard prevents this from double-
  // triggering the initial fetch above.
  const firstTickRef = useRef(true);
  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    if (typeLoading || isStreamingType || !connectionId) return;
    fetchData();
  }, [refreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh interval for non-socket datasources, gated on
  // document visibility. When the browser tab is hidden (user
  // switched tabs, screen locked, kiosk dormant), the polling timer
  // is paused so backgrounded dashboards don't keep hitting the
  // server. When visibility returns we kick off an immediate
  // refetch and re-arm the timer so the user sees fresh data the
  // moment they return.
  useEffect(() => {
    if (typeLoading || isStreamingType) {
      return; // Streaming handles its own updates
    }
    if (!refreshInterval || refreshInterval <= 0) {
      return; // Polling disabled
    }

    let intervalId = null;

    const startTimer = () => {
      if (intervalId != null) return;
      intervalId = setInterval(() => {
        fetchData();
      }, refreshInterval);
      intervalRef.current = intervalId;
    };

    const stopTimer = () => {
      if (intervalId != null) {
        clearInterval(intervalId);
        intervalId = null;
        intervalRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stopTimer();
      } else {
        // Returning to a visible tab — refetch immediately so the
        // user sees fresh data without waiting for the next tick,
        // then resume polling on the configured cadence.
        fetchData();
        startTimer();
      }
    };

    if (!document.hidden) {
      startTimer();
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopTimer();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [refreshInterval, fetchData, datasourceType, datasourceTransport, typeLoading, isStreamingType]);

  // Refetch function (bypasses cache for polling, clears buffer for streaming)
  // showLoading: if true, shows loading spinner during refetch (default: false for seamless updates)
  const refetch = useCallback(async (showLoading = false) => {
    if (isStreamingType) {
      // For streaming, clear the buffer
      setData({ columns: columnsRef.current, rows: [] });
      return;
    }

    if (fetchingRef.current) return;
    fetchingRef.current = true;

    try {
      // Only show loading if explicitly requested
      if (showLoading) {
        setLoading(true);
      }
      setError(null);

      const result = await runQuery(false);

      if (mountedRef.current) {
        setData(result.data);
        setSource(result.source);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        // AbortError is a deliberate cancel, not a data error — don't surface it.
        // But ALWAYS end the loading state, or an aborted refetch leaves the
        // spinner stuck (the same stuck-Loading bug as the main fetch path).
        if (!isAbortError(err)) setError(err);
        setLoading(false);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, [connectionId, queryKey, datasourceType, runQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear buffer function (for streaming)
  const clearBuffer = useCallback(() => {
    setData({ columns: columnsRef.current, rows: [] });
  }, []);

  return {
    data,
    loading: typeLoading || loading,
    error,
    refetch,
    source: isStreamingType ? (useAggregated ? 'aggregated-stream' : 'stream') : source,
    cached: source === 'cache' || source === 'partial-cache',
    // Streaming-specific properties
    connected: isStreamingType ? connected : null,
    isStreaming: isStreamingType,
    isAggregated: isStreamingType && useAggregated,
    clearBuffer: isStreamingType ? clearBuffer : null,
    // Reconnection state (for overlay errors)
    reconnecting: isStreamingType ? reconnecting : false,
    disconnectedSince: isStreamingType ? disconnectedSince : null,
  };
}
