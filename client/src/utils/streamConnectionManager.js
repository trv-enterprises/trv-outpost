// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Stream Connection Manager
 *
 * Provides a singleton manager for streaming socket connections. Every
 * subscriber shares a SINGLE multiplexed SSE pipe to the server
 * (`/api/streams/multiplex`) — one EventSource for the whole tab, no
 * matter how many connections are streamed. This defeats the browser's
 * 6-per-origin HTTP/1.1 connection cap (issue #187): before this, each
 * connectionId opened its own EventSource, so a dashboard spanning >5
 * streaming connections exhausted the pool and every remaining request
 * (tile queries, backfills) queued forever.
 *
 * Model:
 *  - ONE EventSource → GET /api/streams/multiplex. Its first frame is
 *    `event: session` carrying the `sid` used to mutate subscriptions.
 *  - Per-connection subscriptions are added/removed over that pipe via
 *    one-shot POST /api/streams/multiplex/:sid/subs (a fetch — pools
 *    fine, holds no persistent slot). Deltas are debounced so a mount
 *    wave produces one POST.
 *  - Server tags every frame with the streamKey (here: the connectionId).
 *    The manager routes each tagged `record` frame into the same
 *    per-connection buffer + topic-filtered fan-out it always used, so
 *    subscribers see no behavioral change.
 *
 * The per-connection state (subscribers, buffers, grace periods, combined
 * topics) is unchanged; only the transport moved from N EventSources to
 * one multiplexed pipe.
 *
 * Usage:
 * const manager = StreamConnectionManager.getInstance();
 * const unsubscribe = manager.subscribe(connectionId, callback, { topics: 'my/topic' });
 * // When done:
 * unsubscribe();
 */

import apiClient from '../api/client';
import { getStreamBufferSize } from './streamBufferConfig';

class StreamConnectionManager {
  static instance = null;

  constructor() {
    // Map of connectionId -> connection state
    this.connections = new Map();
    // Map of connectionId -> Set of subscriber objects
    this.subscribers = new Map();
    // Map of connectionId -> data buffer (for late subscribers)
    this.buffers = new Map();
    // Max buffer size per connection — read live from the shared
    // stream-buffer config (admin setting stream_buffer_size) at trim
    // time, so a deployment override applies without reconstructing the
    // singleton. Default 1000 via getStreamBufferSize().
    // Grace period: defer cleanup when last subscriber leaves
    this.gracePeriodTimeouts = new Map();
    this.gracePeriodMs = 30000; // 30 seconds
    // Debounce: coalesce rapid subscribe/unsubscribe bursts (e.g. a dashboard
    // mounting N MQTT controls) into one reconnect. Without this, every new
    // subscriber triggers a full disconnect + reconnect of the shared SSE
    // connection, producing an O(N) CORS-error storm at first paint.
    this.reconnectDebounceTimeouts = new Map();
    this.reconnectDebounceMs = 150;

    // --- Shared multiplex pipe state (issue #187) ---------------------
    // One EventSource for the whole tab. `mux.sid` is assigned from the
    // server's first `session` frame and is required to POST subscription
    // deltas. `mux.pendingSubs` accumulates add/remove deltas that are
    // flushed (debounced) once the pipe has a sid.
    this.mux = {
      eventSource: null,
      connected: false,
      sid: null,
      reconnecting: false,
      reconnectAttempts: 0,
      reconnectTimeout: null,
      heartbeatTimer: null,
      lastActivity: 0,
    };
    // connectionId -> { topics } — the intended subscription set on the
    // pipe. This is the source of truth we re-send after a pipe reconnect
    // (new sid) so every active connection is re-subscribed.
    this.muxDesired = new Map();
    // Debounce timer for flushing accumulated subscription deltas.
    this.muxFlushTimeout = null;
    // Pending deltas since the last flush: Map<connectionId, 'add'|'remove'>.
    this.muxPending = new Map();

    // The access token is baked into the pipe URL as ?st= at open time
    // and can't be updated on a live EventSource. When apiClient rotates
    // the token (proactive pre-expiry refresh, or the 401 refresh path),
    // reopen the pipe so it rides the fresh token instead of dying when
    // the old one lapses server-side. A token → null transition (session
    // ended) reopens with an empty ?st=, which the server 401s — the
    // dashboard surface re-bootstraps and remounts us, so we don't
    // special-case it here.
    this._unsubscribeTokenChange = apiClient.onTokenChange(() => {
      this._reconnectAllForTokenChange();
    });
  }

  /**
   * Reopen the shared pipe so it picks up the freshly-rotated access
   * token in its ?st= query. The reopen gets a new sid and re-sends the
   * full desired subscription set.
   */
  _reconnectAllForTokenChange() {
    if (!this.mux.eventSource && this.muxDesired.size === 0) return;
    console.log('[StreamConnectionManager] Access token rotated — reconnecting multiplex pipe');
    this._reopenMuxPipe();
  }

  static getInstance() {
    if (!StreamConnectionManager.instance) {
      StreamConnectionManager.instance = new StreamConnectionManager();
    }
    return StreamConnectionManager.instance;
  }

  /**
   * Compute the combined topic set for all subscribers of a connection.
   * Returns comma-separated sorted topics, or null if any subscriber wants all topics.
   */
  _getCombinedTopics(connectionId) {
    const subscribers = this.subscribers.get(connectionId);
    if (!subscribers || subscribers.size === 0) return null;

    const topicSet = new Set();
    for (const sub of subscribers) {
      if (!sub.topics) return null; // Wildcard subscriber — subscribe to all
      sub.topics.forEach(t => topicSet.add(t));
    }
    return [...topicSet].sort().join(',');
  }

  /**
   * Subscribe to a connection stream
   * @param {string} connectionId - The connection ID
   * @param {function} callback - Called with each matching record
   * @param {object} options - { onConnect, onDisconnect, onError, onReconnecting, topics }
   *   topics: comma-separated MQTT topic filter (e.g., "sensors/temp/#,home/+/status")
   * @returns {function} Unsubscribe function
   */
  subscribe(connectionId, callback, options = {}) {
    if (!connectionId) {
      console.error('[StreamConnectionManager] connectionId is required');
      return () => {};
    }

    // #248: a per-component store on an endpoint-scoped tsstore connection
    // gets its own client-side stream key, so two stores on one connection
    // fan out independently (mirroring the server's per-store channels).
    // This key is CLIENT-LOCAL — the server derives its own channel hash;
    // the store rides the subscription payload verbatim.
    const streamKey = options.store ? `${connectionId}|s:${options.store}` : connectionId;

    // Initialize subscribers set
    if (!this.subscribers.has(streamKey)) {
      this.subscribers.set(streamKey, new Set());
    }

    // Create subscriber entry with topic filter for client-side routing
    const subscriber = {
      callback,
      topics: options.topics ? options.topics.split(',') : null, // null = all topics
      skipBufferReplay: !!options.skipBufferReplay, // skip replaying buffered records on subscribe
      onConnect: options.onConnect || (() => {}),
      onDisconnect: options.onDisconnect || (() => {}),
      onError: options.onError || (() => {}),
      onReconnecting: options.onReconnecting || (() => {})
    };

    this.subscribers.get(streamKey).add(subscriber);

    // Cancel any pending grace period cleanup
    const pendingTimeout = this.gracePeriodTimeouts.get(streamKey);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this.gracePeriodTimeouts.delete(streamKey);
      console.log(`[StreamConnectionManager] Grace period cancelled for ${streamKey} — reusing connection`);
    }

    const connection = this.connections.get(streamKey);
    const newTopics = this._getCombinedTopics(streamKey);

    if (connection) {
      // Connection exists — check if topics changed
      if (connection.connected) {
        subscriber.onConnect();
        // Replay buffered records matching this subscriber's topics (unless opted out)
        if (!subscriber.skipBufferReplay) {
          const buffer = this.buffers.get(streamKey);
          if (buffer && buffer.length > 0) {
            buffer.forEach(record => {
              if (this._matchesTopic(record, subscriber)) {
                subscriber.callback(record);
              }
            });
          }
        }
      }

      // If topics changed, schedule a debounced reconnect so a burst of
      // new subscribers during dashboard mount produces one reconnect.
      if (newTopics !== connection.topics) {
        this._scheduleTopicReconnect(streamKey, 'Topics changed');
      }
    } else {
      // No connection yet — create one
      this._connect(streamKey, newTopics, connectionId, options.store || '');
    }

    return () => {
      this._unsubscribe(streamKey, subscriber);
    };
  }

  /**
   * Build a stable stream key for an aggregated subscription. Two charts
   * with identical (connectionId, bucketConfig) produce the same key, so
   * they share ONE server-side aggregator AND one pipe subscription —
   * this is the SSE-layer aggregation sharing (aggregation-sharing.md).
   * The order/normalization mirrors the server's BucketConfig.ConfigKey().
   */
  _aggStreamKey(connectionId, bucketConfig, store = '') {
    const cols = [...(bucketConfig.value_cols || [])].sort().join(',');
    return [
      'agg',
      connectionId,
      store, // #248: per-component store — different stores never share an aggregator
      bucketConfig.interval,
      bucketConfig.function || 'avg',
      bucketConfig.timestamp_col || '',
      bucketConfig.series_col || '',
      cols,
    ].join('|');
  }

  /**
   * Subscribe to a time-bucketed aggregated stream over the shared pipe.
   * The aggregated bucket-records arrive as tagged `record` frames keyed
   * on a synthetic agg stream key and are routed to `callback` like any
   * other subscriber. No topic filtering or client buffer replay applies
   * (aggregators emit computed buckets, not raw topic records).
   * @param {string} connectionId
   * @param {object} bucketConfig - { interval, function, value_cols, timestamp_col, series_col }
   * @param {function} callback - Called with each bucket record
   * @param {object} options - { onConnect, onDisconnect, onError, onReconnecting }
   * @returns {function} Unsubscribe function
   */
  subscribeAggregated(connectionId, bucketConfig, callback, options = {}) {
    if (!connectionId) {
      console.error('[StreamConnectionManager] connectionId is required');
      return () => {};
    }
    const streamKey = this._aggStreamKey(connectionId, bucketConfig, options.store || '');

    if (!this.subscribers.has(streamKey)) {
      this.subscribers.set(streamKey, new Set());
    }

    const subscriber = {
      callback,
      topics: null, // aggregated records carry no topic filter
      skipBufferReplay: true, // no client-side buffer for aggregated streams
      onConnect: options.onConnect || (() => {}),
      onDisconnect: options.onDisconnect || (() => {}),
      onError: options.onError || (() => {}),
      onReconnecting: options.onReconnecting || (() => {}),
    };
    this.subscribers.get(streamKey).add(subscriber);

    const pendingTimeout = this.gracePeriodTimeouts.get(streamKey);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this.gracePeriodTimeouts.delete(streamKey);
    }

    const connection = this.connections.get(streamKey);
    if (connection) {
      if (connection.connected) subscriber.onConnect();
    } else {
      this._connectAggregated(streamKey, connectionId, bucketConfig, options.store || '');
    }

    return () => {
      this._unsubscribe(streamKey, subscriber);
    };
  }

  /**
   * Check if a record matches a subscriber's topic filter.
   * Supports MQTT wildcards: + (single level) and # (multi-level).
   */
  _matchesTopic(record, subscriber) {
    if (!subscriber.topics) return true; // No filter — matches all
    if (!record.topic) return true; // No topic on record — pass through
    return subscriber.topics.some(filter => this._mqttTopicMatch(filter, record.topic));
  }

  /**
   * MQTT topic pattern matching.
   * '+' matches exactly one level, '#' matches zero or more levels (must be last).
   */
  _mqttTopicMatch(filter, topic) {
    if (filter === '#') return true;
    if (filter === topic) return true;

    const filterParts = filter.split('/');
    const topicParts = topic.split('/');

    for (let i = 0; i < filterParts.length; i++) {
      if (filterParts[i] === '#') return true; // # matches rest
      if (i >= topicParts.length) return false; // topic shorter than filter
      if (filterParts[i] !== '+' && filterParts[i] !== topicParts[i]) return false;
    }

    return filterParts.length === topicParts.length;
  }

  /**
   * Internal: Register a logical connection and subscribe it on the
   * shared multiplex pipe. The per-connection state object is retained
   * (connected/topics/reconnect bookkeeping) but no longer owns its own
   * EventSource — the transport is the single pipe.
   */
  _connect(streamKey, topics, connectionId, store) {
    if (this.connections.has(streamKey)) return;

    this.connections.set(streamKey, {
      connected: false,
      connectionId: streamKey,
      topics // Combined topics string or null
    });

    if (!this.buffers.has(streamKey)) {
      this.buffers.set(streamKey, []);
    }

    // Record the desired subscription and queue an `add` delta on the
    // shared pipe (opening the pipe lazily if this is the first stream).
    // For a store-scoped tsstore sub (#248) the streamKey is synthetic, so
    // the entry carries the real connId + store for the server payload.
    const desired = { topics };
    if (connectionId && connectionId !== streamKey) desired.connId = connectionId;
    if (store) desired.store = store;
    this.muxDesired.set(streamKey, desired);
    this._queueMuxDelta(streamKey, 'add');
    this._ensureMuxPipe();
  }

  /**
   * Internal: Register an aggregated subscription on the shared pipe. Like
   * _connect, but the desired entry carries the real connId plus the `agg`
   * bucket config, and there is no topic/buffer state. streamKey is the
   * synthetic agg key so matching charts dedupe onto one pipe subscription.
   */
  _connectAggregated(streamKey, connectionId, bucketConfig, store = '') {
    if (this.connections.has(streamKey)) return;

    this.connections.set(streamKey, {
      connected: false,
      connectionId: streamKey,
      topics: null,
    });

    const desired = {
      topics: '',
      connId: connectionId,
      agg: {
        interval: bucketConfig.interval,
        function: bucketConfig.function || 'avg',
        value_cols: bucketConfig.value_cols,
        timestamp_col: bucketConfig.timestamp_col,
        series_col: bucketConfig.series_col || '',
      },
    };
    if (store) desired.store = store;
    this.muxDesired.set(streamKey, desired);
    this._queueMuxDelta(streamKey, 'add');
    this._ensureMuxPipe();
  }

  /**
   * Internal: Debounce a topic-change re-subscribe. Successive calls
   * within reconnectDebounceMs reset the timer; only the last topic set
   * wins. This is what lets a dashboard mounting N controls produce one
   * re-subscribe instead of N. A topic change is a re-subscribe of the
   * one connectionId on the shared pipe (remove+add), NOT a reopen of
   * the pipe — unrelated streams stay live.
   */
  _scheduleTopicReconnect(connectionId, reason) {
    const existing = this.reconnectDebounceTimeouts.get(connectionId);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.reconnectDebounceTimeouts.delete(connectionId);
      const connection = this.connections.get(connectionId);
      if (!connection) return;
      const targetTopics = this._getCombinedTopics(connectionId);
      if (targetTopics === connection.topics) return; // already converged
      console.log(`[StreamConnectionManager] ${reason} for ${connectionId}, re-subscribing`);
      this._reconnectWithTopics(connectionId, targetTopics);
    }, this.reconnectDebounceMs);
    this.reconnectDebounceTimeouts.set(connectionId, timeout);
  }

  /**
   * Internal: Re-subscribe one connection with a new topic set. On the
   * shared pipe a topic change is remove+add of that streamKey (the
   * server-side subscription must be reopened to change its broker-level
   * topic filter). Other connections on the pipe are untouched.
   */
  _reconnectWithTopics(connectionId, newTopics) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const pending = this.reconnectDebounceTimeouts.get(connectionId);
    if (pending) {
      clearTimeout(pending);
      this.reconnectDebounceTimeouts.delete(connectionId);
    }

    connection.topics = newTopics;
    // Preserve connId/store on the desired entry (#248): a topic change on
    // a store-scoped key must not strip the store from the re-add payload.
    const prevDesired = this.muxDesired.get(connectionId) || {};
    this.muxDesired.set(connectionId, { ...prevDesired, topics: newTopics });
    // Remove then re-add so the server drops the old broker filter and
    // subscribes the new one. The flush sends both in one POST.
    this._queueMuxDelta(connectionId, 'remove');
    this._queueMuxDelta(connectionId, 'add');
  }

  // --- Shared multiplex pipe --------------------------------------------

  /**
   * Internal: Open the shared multiplex EventSource if it isn't already
   * open. Idempotent. The pipe's `session` frame supplies the sid needed
   * to POST subscription deltas; deltas queued before the sid arrives are
   * flushed once it does.
   */
  _ensureMuxPipe() {
    if (this.mux.eventSource) return;

    // Build URL. EventSource cannot set headers, so the access JWT rides
    // ?st= (apiClient.streamAuthQuery()). httpOriginForApi() returns the
    // configured absolute base (Electron → any instance) or the page
    // origin (browser/homelab same-origin) — same rationale as the old
    // per-connection path.
    const auth = apiClient.streamAuthQuery();
    let url = `${apiClient.httpOriginForApi()}/api/streams/multiplex`;
    if (auth) url += `?${auth}`;

    console.log('[StreamConnectionManager] Opening multiplex pipe');
    const eventSource = new EventSource(url);
    this.mux.eventSource = eventSource;
    this.mux.reconnecting = false;

    // The server's first frame carries the session id used for POSTs.
    eventSource.addEventListener('session', (event) => {
      try {
        const { sid } = JSON.parse(event.data);
        this.mux.sid = sid;
        this.mux.connected = true;
        this.mux.reconnectAttempts = 0;
        this.mux.lastActivity = Date.now();
        this._startMuxHeartbeatWatchdog();
        console.log(`[StreamConnectionManager] Multiplex pipe connected (sid=${sid})`);
        // Re-assert the full desired subscription set on the (possibly
        // new) sid, then flush.
        for (const cid of this.muxDesired.keys()) {
          this._queueMuxDelta(cid, 'add');
        }
        this._flushMuxDeltas();
        // Late-connect: fire onConnect for any already-registered
        // connections and mark them connected.
        for (const [cid, connection] of this.connections) {
          if (!connection.connected) {
            connection.connected = true;
            const subs = this.subscribers.get(cid);
            if (subs) subs.forEach(sub => sub.onConnect());
          }
        }
      } catch (err) {
        console.error('[StreamConnectionManager] Error parsing session frame:', err);
      }
    });

    eventSource.addEventListener('heartbeat', () => {
      this.mux.lastActivity = Date.now();
    });

    // Per-key subscription acknowledgment — fire the connection's
    // onConnect and mark it connected so buffer-replay on late subscribe
    // works.
    eventSource.addEventListener('subscribed', (event) => {
      this.mux.lastActivity = Date.now();
      try {
        const { key } = JSON.parse(event.data);
        const connection = this.connections.get(key);
        if (connection && !connection.connected) {
          connection.connected = true;
          const subs = this.subscribers.get(key);
          if (subs) subs.forEach(sub => sub.onConnect());
        }
      } catch (err) {
        console.error('[StreamConnectionManager] Error parsing subscribed frame:', err);
      }
    });

    // Tagged data frame: {key, record}. Route into the connectionId the
    // key names, using the same buffer + topic-filtered fan-out as before.
    eventSource.addEventListener('record', (event) => {
      this.mux.lastActivity = Date.now();
      try {
        const frame = JSON.parse(event.data);
        const streamKey = frame.key;
        const record = frame.record;
        if (!streamKey || !record) return;

        // Aggregated streams (synthetic 'agg|…' key) carry computed bucket
        // records — no client buffer, no topic filtering. Raw streams keep
        // the per-connection ring buffer for late-subscriber replay.
        const isAgg = typeof streamKey === 'string' && streamKey.startsWith('agg|');
        if (!isAgg) {
          const buffer = this.buffers.get(streamKey) || [];
          buffer.push(record);
          const maxBufferSize = getStreamBufferSize();
          if (buffer.length > maxBufferSize) buffer.shift();
          this.buffers.set(streamKey, buffer);
        }

        const subscribers = this.subscribers.get(streamKey);
        if (subscribers) {
          subscribers.forEach(sub => {
            if (isAgg || this._matchesTopic(record, sub)) {
              sub.callback(record);
            }
          });
        }
      } catch (err) {
        console.error('[StreamConnectionManager] Error parsing record frame:', err);
      }
    });

    eventSource.onerror = () => {
      this._handleMuxError();
    };
  }

  /**
   * Internal: Reopen the shared pipe from scratch (new sid), re-sending
   * the full desired subscription set. Used on token rotation and as the
   * reconnect path after a pipe error.
   */
  _reopenMuxPipe() {
    this._stopMuxHeartbeatWatchdog();
    if (this.mux.eventSource) {
      this.mux.eventSource.close();
      this.mux.eventSource = null;
    }
    if (this.mux.reconnectTimeout) {
      clearTimeout(this.mux.reconnectTimeout);
      this.mux.reconnectTimeout = null;
    }
    this.mux.connected = false;
    this.mux.sid = null;
    // Mark logical connections disconnected; they'll reconnect on the new
    // session frame.
    for (const connection of this.connections.values()) {
      connection.connected = false;
    }
    if (this.muxDesired.size > 0) {
      this._ensureMuxPipe();
    }
  }

  /**
   * Internal: Handle a pipe-level EventSource error with backoff, terminal-
   * failure detection, and a token-refresh-on-first-error attempt. Mirrors
   * the per-connection error handling the single-stream path used, but at
   * the pipe level so one reconnect covers every subscribed connection.
   */
  _handleMuxError() {
    this._stopMuxHeartbeatWatchdog();
    if (this.mux.eventSource) {
      this.mux.eventSource.close();
      this.mux.eventSource = null;
    }
    this.mux.connected = false;
    this.mux.sid = null;

    // Nothing left to stream — stay closed.
    if (this.muxDesired.size === 0) return;

    // Surface the disconnect to every subscribed connection's subscribers.
    for (const [connectionId, connection] of this.connections) {
      connection.connected = false;
      const subscribers = this.subscribers.get(connectionId);
      if (subscribers && subscribers.size > 0) {
        apiClient._reportConnectionFailure(connectionId);
        subscribers.forEach(sub => sub.onDisconnect());
      }
    }

    this.mux.reconnecting = true;
    this.mux.reconnectAttempts++;

    // On the FIRST error of an episode, the cause is often a stale/expired
    // access token frozen into the pipe URL's ?st=. Proactively refresh:
    // on success apiClient rotates the token → onTokenChange reopens the
    // pipe with a fresh ?st= (and we cancel the redundant backoff). On
    // failure (session ended) the backoff reopen still runs.
    if (this.mux.reconnectAttempts === 1 && apiClient.accessToken && typeof apiClient._refreshSession === 'function') {
      apiClient._refreshSession().then((ok) => {
        if (ok && this.mux.reconnectTimeout) {
          clearTimeout(this.mux.reconnectTimeout);
          this.mux.reconnectTimeout = null;
        }
      }).catch(() => {});
    }

    const delay = Math.min(1000 * Math.pow(2, this.mux.reconnectAttempts - 1), 30000);
    if (this.mux.reconnectAttempts <= 1) {
      console.debug(`[StreamConnectionManager] Reopening multiplex pipe in ${delay}ms`);
    } else if (this.mux.reconnectAttempts % 5 === 0) {
      console.warn(`[StreamConnectionManager] Reopening multiplex pipe (attempt ${this.mux.reconnectAttempts})`);
    }

    for (const [connectionId] of this.connections) {
      const subscribers = this.subscribers.get(connectionId);
      if (subscribers) subscribers.forEach(sub => sub.onReconnecting(this.mux.reconnectAttempts, delay));
    }

    this.mux.reconnectTimeout = setTimeout(() => {
      if (this.muxDesired.size > 0) {
        this._ensureMuxPipe();
      }
    }, delay);
  }

  /**
   * Internal: Queue an add/remove subscription delta for the shared pipe,
   * coalescing per connectionId, and schedule a debounced flush.
   *
   * Coalescing must NOT let an 'add' swallow a queued 'remove' for the
   * same key: a topic-set change (_reconnectWithTopics) queues exactly
   * remove-then-add, and the server changes a key's broker topic filter
   * ONLY via remove+add in one delta — a duplicate-key add alone is an
   * idempotent no-op there. Collapsing the pair to a bare add is how the
   * weather panel starved: the pipe stayed on the first subscriber's
   * topics forever ("connected" but no matching messages). The pair
   * coalesces to 'readd', which flushes the key into BOTH the remove and
   * add arrays of the one POST (the server processes removes first).
   */
  _queueMuxDelta(connectionId, action) {
    const prev = this.muxPending.get(connectionId);
    if (action === 'add' && (prev === 'remove' || prev === 'readd')) {
      action = 'readd';
    }
    // 'remove' supersedes anything queued: even a pending un-flushed
    // 'add'/'readd' nets out to "not subscribed" (removing a key the
    // server never saw is a no-op there).
    this.muxPending.set(connectionId, action);
    if (this.muxFlushTimeout) return;
    this.muxFlushTimeout = setTimeout(() => {
      this.muxFlushTimeout = null;
      this._flushMuxDeltas();
    }, this.reconnectDebounceMs);
  }

  /**
   * Internal: POST the accumulated subscription deltas to the pipe. No-op
   * until the pipe has a sid (deltas stay queued and are re-driven by the
   * session frame). Failures are retried on the next flush / reconnect.
   */
  _flushMuxDeltas() {
    if (this.muxFlushTimeout) {
      clearTimeout(this.muxFlushTimeout);
      this.muxFlushTimeout = null;
    }
    if (!this.mux.sid) {
      // Pipe not ready yet — the session frame will re-drive the flush.
      this._ensureMuxPipe();
      return;
    }
    if (this.muxPending.size === 0) return;

    const add = [];
    const remove = [];
    for (const [streamKey, action] of this.muxPending) {
      if (action === 'remove') {
        remove.push(streamKey);
      } else {
        const desired = this.muxDesired.get(streamKey);
        if (!desired) continue; // dropped before flush
        // 'readd' = topic change: the key must ride in BOTH arrays so the
        // server drops the old broker filter and opens the new one (a
        // duplicate-key add alone is a server-side no-op).
        if (action === 'readd') {
          remove.push(streamKey);
        }
        // connId falls back to the streamKey for raw subs (where the key
        // IS the connectionId); aggregated subs carry a distinct synthetic
        // key plus the real connId and an `agg` config.
        const entry = {
          key: streamKey,
          connection_id: desired.connId || streamKey,
          topics: desired.topics || '',
        };
        if (desired.store) entry.store = desired.store; // #248 per-component store channel
        if (desired.agg) entry.agg = desired.agg;
        add.push(entry);
      }
    }
    this.muxPending.clear();

    const sid = this.mux.sid;
    const url = `${apiClient.httpOriginForApi()}/api/streams/multiplex/${sid}/subs`;
    const headers = { 'Content-Type': 'application/json', ...apiClient.streamAuthHeaders() };
    const userGuid = apiClient.getCurrentUserGuid();
    if (userGuid) headers['X-User-ID'] = userGuid;

    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ add, remove }),
    }).then((res) => {
      if (res.status === 404) {
        // Session expired server-side — reopen the pipe, which re-sends
        // the full desired set on the new sid.
        console.warn('[StreamConnectionManager] Multiplex session gone — reopening pipe');
        this._reopenMuxPipe();
        return;
      }
      if (!res.ok) {
        console.warn(`[StreamConnectionManager] Subscription update failed (${res.status})`);
      }
    }).catch((err) => {
      console.warn('[StreamConnectionManager] Subscription update error:', err?.message || err);
    });
  }

  /**
   * Internal: Unsubscribe a subscriber
   */
  _unsubscribe(connectionId, subscriber) {
    const subscribers = this.subscribers.get(connectionId);
    if (!subscribers) return;

    subscribers.delete(subscriber);

    console.log(`[StreamConnectionManager] Subscriber removed from ${connectionId} (${subscribers.size} remaining)`);

    if (subscribers.size === 0) {
      // Last subscriber — start grace period
      if (this.gracePeriodMs > 0) {
        const existing = this.gracePeriodTimeouts.get(connectionId);
        if (existing) clearTimeout(existing);

        console.log(`[StreamConnectionManager] Grace period started for ${connectionId} (${this.gracePeriodMs}ms)`);
        const timeout = setTimeout(() => {
          this.gracePeriodTimeouts.delete(connectionId);
          const currentSubs = this.subscribers.get(connectionId);
          if (!currentSubs || currentSubs.size === 0) {
            console.log(`[StreamConnectionManager] Grace period expired for ${connectionId} — cleaning up`);
            this._cleanup(connectionId);
          }
        }, this.gracePeriodMs);
        this.gracePeriodTimeouts.set(connectionId, timeout);
      } else {
        this._cleanup(connectionId);
      }
    } else {
      // Check if topics changed (a topic may no longer be needed).
      // Debounced so rapid unmount bursts (e.g. dashboard switch) don't
      // trigger a reconnect per departing subscriber.
      const connection = this.connections.get(connectionId);
      if (connection) {
        const newTopics = this._getCombinedTopics(connectionId);
        if (newTopics !== connection.topics) {
          this._scheduleTopicReconnect(connectionId, 'Topics reduced');
        }
      }
    }
  }

  /**
   * Internal: Clean up a connection
   */
  _cleanup(connectionId) {
    console.log(`[StreamConnectionManager] Cleaning up connection for ${connectionId}`);

    const graceTimeout = this.gracePeriodTimeouts.get(connectionId);
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      this.gracePeriodTimeouts.delete(connectionId);
    }

    const debounceTimeout = this.reconnectDebounceTimeouts.get(connectionId);
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
      this.reconnectDebounceTimeouts.delete(connectionId);
    }

    // Drop the connection's subscription from the shared pipe.
    this.muxDesired.delete(connectionId);
    this._queueMuxDelta(connectionId, 'remove');

    this.connections.delete(connectionId);
    this.subscribers.delete(connectionId);
    this.buffers.delete(connectionId);

    // Last stream gone — close the shared pipe entirely so we don't hold
    // an idle SSE connection (and its pool slot) open.
    if (this.muxDesired.size === 0) {
      this._closeMuxPipe();
    }
  }

  /**
   * Internal: Start the shared-pipe heartbeat watchdog. If no record or
   * heartbeat arrives for 60s the pipe is presumed dead and reopened
   * (one reopen covers every subscribed connection).
   */
  _startMuxHeartbeatWatchdog() {
    this._stopMuxHeartbeatWatchdog();
    this.mux.heartbeatTimer = setInterval(() => {
      if (!this.mux.connected) return;
      const elapsed = Date.now() - this.mux.lastActivity;
      if (elapsed > 60000) {
        console.warn(`[StreamConnectionManager] No activity on multiplex pipe for ${Math.round(elapsed / 1000)}s — forcing reopen`);
        this._stopMuxHeartbeatWatchdog();
        // Route through the error path so subscribers see disconnect +
        // reconnecting and backoff applies.
        this._handleMuxError();
      }
    }, 15000);
  }

  /**
   * Internal: Stop the shared-pipe heartbeat watchdog.
   */
  _stopMuxHeartbeatWatchdog() {
    if (this.mux.heartbeatTimer) {
      clearInterval(this.mux.heartbeatTimer);
      this.mux.heartbeatTimer = null;
    }
  }

  /**
   * Internal: Fully close the shared pipe and clear its timers/state.
   */
  _closeMuxPipe() {
    this._stopMuxHeartbeatWatchdog();
    if (this.mux.eventSource) {
      this.mux.eventSource.close();
      this.mux.eventSource = null;
    }
    if (this.mux.reconnectTimeout) {
      clearTimeout(this.mux.reconnectTimeout);
      this.mux.reconnectTimeout = null;
    }
    if (this.muxFlushTimeout) {
      clearTimeout(this.muxFlushTimeout);
      this.muxFlushTimeout = null;
    }
    this.mux.connected = false;
    this.mux.sid = null;
    this.mux.reconnecting = false;
    this.mux.reconnectAttempts = 0;
    this.muxPending.clear();
  }

  /**
   * Get connection status for a connection
   */
  getStatus(connectionId) {
    const connection = this.connections.get(connectionId);
    const subscribers = this.subscribers.get(connectionId);
    const buffer = this.buffers.get(connectionId);

    return {
      connected: connection?.connected || false,
      reconnecting: this.mux.reconnecting || false,
      reconnectAttempts: this.mux.reconnectAttempts || 0,
      subscriberCount: subscribers?.size || 0,
      bufferSize: buffer?.length || 0,
      topics: connection?.topics || null,
      inGracePeriod: this.gracePeriodTimeouts.has(connectionId)
    };
  }

  /**
   * Get the current buffer for a connection (optionally filtered by topic)
   */
  getBuffer(connectionId, topics) {
    const buffer = this.buffers.get(connectionId) || [];
    if (!topics) return buffer;
    const topicList = topics.split(',');
    return buffer.filter(r => !r.topic || topicList.includes(r.topic));
  }

  /**
   * Close all connections immediately, bypassing grace periods. Also
   * tears down the shared multiplex pipe.
   */
  closeAll() {
    for (const [, timeout] of this.gracePeriodTimeouts) {
      clearTimeout(timeout);
    }
    this.gracePeriodTimeouts.clear();

    for (const connectionId of [...this.connections.keys()]) {
      this._cleanup(connectionId);
    }
    // Defensive: ensure the pipe is closed even if the last _cleanup
    // didn't (e.g. no connections were ever registered).
    this._closeMuxPipe();
    this.muxDesired.clear();
  }
}

export default StreamConnectionManager;
