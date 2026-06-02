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
import { queryData } from '../api/dataClient';
import apiClient, { API_BASE } from '../api/client';
import StreamConnectionManager from '../utils/streamConnectionManager';
import { getStreamBufferSize } from '../utils/streamBufferConfig';
import { useRegisterRefreshable } from '../context/RefreshableComponentsContext';

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

export function useData({ connectionId, query, refreshInterval = null, useCache = true, maxBuffer = null, timeBucket = null, backfill = null, parser = null, refreshTick = 0 }) {
  // A per-call maxBuffer wins; otherwise use the deployment-wide default
  // (admin setting stream_buffer_size, set at bootstrap). Applies to both
  // spec-driven and eval'd custom-code charts.
  const effectiveMaxBuffer = (Number.isFinite(maxBuffer) && maxBuffer > 0) ? maxBuffer : getStreamBufferSize();
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
    // Clear streaming buffers + displayed data so the new connection starts clean.
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
  }, [connectionId]);

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
  const effectiveBackfill = useMemo(() => {
    if (backfill === false) return null;
    if (backfill) return backfill;
    if (datasourceType === 'tsstore' && datasourceTransport === 'streaming') {
      return { raw: 'newest', type: 'tsstore', params: { limit: getStreamBufferSize() } };
    }
    return null;
  }, [backfill, datasourceType, datasourceTransport]);
  const effectiveBackfillKey = useMemo(() => JSON.stringify(effectiveBackfill), [effectiveBackfill]);

  // Connect to SSE stream for socket datasources (raw or aggregated)
  useEffect(() => {
    if (typeLoading || !isStreamingType || !connectionId) {
      return;
    }

    mountedRef.current = true;
    let reconnectTimeout = null;
    let abortController = null;

    const connectAggregated = async () => {
      if (!mountedRef.current) return;

      // Use fetch with streaming for POST endpoint
      abortController = new AbortController();
      const url = `${API_BASE}/api/connections/${connectionId}/stream/aggregated`;

      try {
        // Build headers including user auth
        const headers = { 'Content-Type': 'application/json' };
        const userGuid = apiClient.getCurrentUserGuid();
        if (userGuid) {
          headers['X-User-ID'] = userGuid;
        }

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            interval: timeBucket.interval,
            function: timeBucket.function || 'avg',
            value_cols: timeBucket.value_cols,
            timestamp_col: timeBucket.timestamp_col,
            series_col: timeBucket.series_col || '' // Column for bucket partitioning (e.g., location)
          }),
          signal: abortController.signal
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        handleConnectionSuccess();
        setSource('aggregated-stream');

        // Read the streaming response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (mountedRef.current) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Parse SSE events from buffer
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // Keep incomplete line in buffer

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (line.startsWith('event: ')) {
              const eventType = line.substring(7);
              const nextLine = lines[i + 1];
              if (nextLine && nextLine.startsWith('data: ')) {
                const data = nextLine.substring(6);
                i++; // Skip the data line

                if (eventType === 'bucket' && mountedRef.current) {
                  try {
                    const bucket = JSON.parse(data);
                    // Remove internal bucket metadata before processing
                    const { _bucket_function, _bucket_interval, _bucket_timestamp, ...record } = bucket;
                    processStreamRecord(record);
                  } catch (err) {
                    console.error('[useData] Error parsing bucket:', err);
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        if (err.name === 'AbortError') return; // Normal cleanup

        console.error('[useData] Aggregated stream error:', err);
        if (mountedRef.current) {
          reconnectTimeout = handleConnectionError(connectAggregated);
        }
      }
    };

    // Reference to unsubscribe function for shared connection
    let unsubscribeFromManager = null;

    // Extract topic filter from query for MQTT datasources
    const parsedQuery = query ? (typeof query === 'string' ? null : query) : null;
    const topicFilter = (datasourceType === 'mqtt' && parsedQuery?.raw) ? parsedQuery.raw : null;

    const connectRawShared = () => {
      if (!mountedRef.current) return;

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
      if (effectiveBackfill && mountedRef.current && !backfillDoneRef.current) {
        backfillDoneRef.current = true;
        try {
          const result = await queryData(connectionId, effectiveBackfill, false);
          if (mountedRef.current && result.data?.columns && result.data?.rows) {
            // Convert columnar result to record objects for processStreamRecord
            const { columns, rows } = result.data;
            rows.forEach(row => {
              const record = {};
              columns.forEach((col, i) => { record[col] = row[i]; });
              processStreamRecord(record);
            });
          }
        } catch (err) {
          console.warn('[useData] Backfill query failed, streaming will start empty:', err.message);
        }
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

  const fetchData = useCallback(async (forceShowLoading = false) => {
    if (!connectionId || !query) {
      setError(new Error('connectionId and query are required'));
      setLoading(false);
      return;
    }

    // Prevent concurrent fetches
    if (fetchingRef.current) {
      return;
    }

    fetchingRef.current = true;

    try {
      // Only show loading spinner on initial fetch or when explicitly requested
      // This prevents the chart from going blank during auto-refresh
      if (isInitialFetchRef.current || forceShowLoading) {
        setLoading(true);
      }
      setError(null);

      const result = await queryData(connectionId, query, useCache);

      if (mountedRef.current) {
        setData(result.data);
        setSource(result.source);
        setLoading(false);
        isInitialFetchRef.current = false; // Mark initial fetch as complete
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err);
        setLoading(false);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, [connectionId, queryKey, useCache]);

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

      const result = await queryData(connectionId, query, false);

      if (mountedRef.current) {
        setData(result.data);
        setSource(result.source);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err);
        setLoading(false);
      }
    } finally {
      fetchingRef.current = false;
    }
  }, [connectionId, queryKey, datasourceType]);

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
