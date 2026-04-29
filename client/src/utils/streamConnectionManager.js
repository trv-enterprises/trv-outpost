// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Stream Connection Manager
 *
 * Provides a singleton manager for SSE/EventSource connections to socket datasources.
 * Multiple components share a SINGLE connection per datasource — topics from all
 * subscribers are combined into one SSE URL, and records are filtered client-side.
 *
 * Usage:
 * const manager = StreamConnectionManager.getInstance();
 * const unsubscribe = manager.subscribe(datasourceId, callback, { topics: 'my/topic' });
 * // When done:
 * unsubscribe();
 */

import { API_BASE } from '../api/client';
import apiClient from '../api/client';

class StreamConnectionManager {
  static instance = null;

  constructor() {
    // Map of datasourceId -> connection state
    this.connections = new Map();
    // Map of datasourceId -> Set of subscriber objects
    this.subscribers = new Map();
    // Map of datasourceId -> data buffer (for late subscribers)
    this.buffers = new Map();
    // Max buffer size per datasource
    this.maxBufferSize = 1000;
    // Grace period: defer cleanup when last subscriber leaves
    this.gracePeriodTimeouts = new Map();
    this.gracePeriodMs = 30000; // 30 seconds
    // Debounce: coalesce rapid subscribe/unsubscribe bursts (e.g. a dashboard
    // mounting N MQTT controls) into one reconnect. Without this, every new
    // subscriber triggers a full disconnect + reconnect of the shared SSE
    // connection, producing an O(N) CORS-error storm at first paint.
    this.reconnectDebounceTimeouts = new Map();
    this.reconnectDebounceMs = 150;
  }

  static getInstance() {
    if (!StreamConnectionManager.instance) {
      StreamConnectionManager.instance = new StreamConnectionManager();
    }
    return StreamConnectionManager.instance;
  }

  /**
   * Compute the combined topic set for all subscribers of a datasource.
   * Returns comma-separated sorted topics, or null if any subscriber wants all topics.
   */
  _getCombinedTopics(datasourceId) {
    const subscribers = this.subscribers.get(datasourceId);
    if (!subscribers || subscribers.size === 0) return null;

    const topicSet = new Set();
    for (const sub of subscribers) {
      if (!sub.topics) return null; // Wildcard subscriber — subscribe to all
      sub.topics.forEach(t => topicSet.add(t));
    }
    return [...topicSet].sort().join(',');
  }

  /**
   * Subscribe to a datasource stream
   * @param {string} datasourceId - The datasource ID
   * @param {function} callback - Called with each matching record
   * @param {object} options - { onConnect, onDisconnect, onError, onReconnecting, topics }
   *   topics: comma-separated MQTT topic filter (e.g., "sensors/temp/#,home/+/status")
   * @returns {function} Unsubscribe function
   */
  subscribe(datasourceId, callback, options = {}) {
    if (!datasourceId) {
      console.error('[StreamConnectionManager] datasourceId is required');
      return () => {};
    }

    // Initialize subscribers set
    if (!this.subscribers.has(datasourceId)) {
      this.subscribers.set(datasourceId, new Set());
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

    this.subscribers.get(datasourceId).add(subscriber);

    // Cancel any pending grace period cleanup
    const pendingTimeout = this.gracePeriodTimeouts.get(datasourceId);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this.gracePeriodTimeouts.delete(datasourceId);
      console.log(`[StreamConnectionManager] Grace period cancelled for ${datasourceId} — reusing connection`);
    }

    const connection = this.connections.get(datasourceId);
    const newTopics = this._getCombinedTopics(datasourceId);

    if (connection) {
      // Connection exists — check if topics changed
      if (connection.connected) {
        subscriber.onConnect();
        // Replay buffered records matching this subscriber's topics (unless opted out)
        if (!subscriber.skipBufferReplay) {
          const buffer = this.buffers.get(datasourceId);
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
        this._scheduleTopicReconnect(datasourceId, 'Topics changed');
      }
    } else {
      // No connection yet — create one
      this._connect(datasourceId, newTopics);
    }

    return () => {
      this._unsubscribe(datasourceId, subscriber);
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
   * Internal: Connect to a datasource
   */
  _connect(datasourceId, topics) {
    if (this.connections.has(datasourceId)) return;

    this.connections.set(datasourceId, {
      eventSource: null,
      connected: false,
      reconnecting: false,
      reconnectTimeout: null,
      reconnectAttempts: 0,
      heartbeatTimer: null,
      lastActivity: 0,
      datasourceId,
      topics // Combined topics string or null
    });

    if (!this.buffers.has(datasourceId)) {
      this.buffers.set(datasourceId, []);
    }

    this._createEventSource(datasourceId);
  }

  /**
   * Internal: Debounce a topic-change reconnect. Successive calls within
   * reconnectDebounceMs reset the timer; only the last topic set wins.
   * This is what lets a dashboard mounting N controls produce one
   * reconnect instead of N.
   */
  _scheduleTopicReconnect(datasourceId, reason) {
    const existing = this.reconnectDebounceTimeouts.get(datasourceId);
    if (existing) clearTimeout(existing);
    const timeout = setTimeout(() => {
      this.reconnectDebounceTimeouts.delete(datasourceId);
      const connection = this.connections.get(datasourceId);
      if (!connection) return;
      const targetTopics = this._getCombinedTopics(datasourceId);
      if (targetTopics === connection.topics) return; // already converged
      console.log(`[StreamConnectionManager] ${reason} for ${datasourceId}, reconnecting`);
      this._reconnectWithTopics(datasourceId, targetTopics);
    }, this.reconnectDebounceMs);
    this.reconnectDebounceTimeouts.set(datasourceId, timeout);
  }

  /**
   * Internal: Reconnect with new topic set (topics added/removed)
   */
  _reconnectWithTopics(datasourceId, newTopics) {
    const connection = this.connections.get(datasourceId);
    if (!connection) return;

    // A concrete reconnect is happening — drop any still-pending debounce
    // timer so it doesn't fire again immediately after.
    const pending = this.reconnectDebounceTimeouts.get(datasourceId);
    if (pending) {
      clearTimeout(pending);
      this.reconnectDebounceTimeouts.delete(datasourceId);
    }

    // Close existing EventSource
    this._stopHeartbeatWatchdog(datasourceId);
    if (connection.eventSource) {
      connection.eventSource.close();
      connection.eventSource = null;
    }
    if (connection.reconnectTimeout) {
      clearTimeout(connection.reconnectTimeout);
      connection.reconnectTimeout = null;
    }

    // Update topics and reconnect
    connection.connected = false;
    connection.reconnecting = false;
    connection.reconnectAttempts = 0;
    connection.topics = newTopics;

    this._createEventSource(datasourceId);
  }

  /**
   * Internal: Create EventSource connection
   */
  _createEventSource(datasourceId) {
    const connection = this.connections.get(datasourceId);
    if (!connection) return;

    const { topics } = connection;

    // Build URL
    const userGuid = apiClient.getCurrentUserGuid();
    const params = new URLSearchParams();
    if (userGuid) params.set('user_id', userGuid);
    if (topics) params.set('topics', topics);
    const queryString = params.toString();
    let url = `${API_BASE}/api/connections/${datasourceId}/stream`;
    if (queryString) url += `?${queryString}`;

    console.log(`[StreamConnectionManager] Connecting to ${datasourceId}${topics ? ` (topics: ${topics})` : ''}`);

    const eventSource = new EventSource(url);
    connection.eventSource = eventSource;

    eventSource.onopen = () => {
      console.log(`[StreamConnectionManager] Connected to ${datasourceId}`);
      connection.connected = true;
      connection.reconnecting = false;
      connection.reconnectAttempts = 0;
      connection.lastActivity = Date.now();

      this._startHeartbeatWatchdog(datasourceId);

      const subscribers = this.subscribers.get(datasourceId);
      if (subscribers) {
        subscribers.forEach(sub => sub.onConnect());
      }
    };

    eventSource.addEventListener('heartbeat', () => {
      connection.lastActivity = Date.now();
    });

    eventSource.addEventListener('record', (event) => {
      connection.lastActivity = Date.now();
      try {
        const record = JSON.parse(event.data);

        // Buffer the record (unfiltered — all topics)
        const buffer = this.buffers.get(datasourceId) || [];
        buffer.push(record);
        if (buffer.length > this.maxBufferSize) buffer.shift();
        this.buffers.set(datasourceId, buffer);

        // Distribute to matching subscribers only
        const subscribers = this.subscribers.get(datasourceId);
        if (subscribers) {
          subscribers.forEach(sub => {
            if (this._matchesTopic(record, sub)) {
              sub.callback(record);
            }
          });
        }
      } catch (err) {
        console.error('[StreamConnectionManager] Error parsing record:', err);
      }
    });

    eventSource.onerror = () => {
      this._stopHeartbeatWatchdog(datasourceId);
      eventSource.close();
      connection.eventSource = null;
      connection.connected = false;

      const subscribers = this.subscribers.get(datasourceId);
      if (!subscribers || subscribers.size === 0) {
        this._cleanup(datasourceId);
        return;
      }

      // Surface the disconnect to the user. Same debounced helper
      // the HTTP path uses, so a dashboard with multiple panels
      // streaming from the same broken connection still produces
      // exactly one toast per 30s window.
      apiClient._reportConnectionFailure(datasourceId);

      subscribers.forEach(sub => sub.onDisconnect());

      connection.reconnecting = true;
      connection.reconnectAttempts++;

      const delay = Math.min(1000 * Math.pow(2, connection.reconnectAttempts - 1), 30000);

      if (connection.reconnectAttempts <= 1) {
        console.debug(`[StreamConnectionManager] Reconnecting to ${datasourceId} in ${delay}ms`);
      } else if (connection.reconnectAttempts % 5 === 0) {
        console.warn(`[StreamConnectionManager] Reconnecting to ${datasourceId} (attempt ${connection.reconnectAttempts})`);
      }

      subscribers.forEach(sub => sub.onReconnecting(connection.reconnectAttempts, delay));

      connection.reconnectTimeout = setTimeout(() => {
        if (this.connections.has(datasourceId)) {
          this._createEventSource(datasourceId);
        }
      }, delay);
    };
  }

  /**
   * Internal: Unsubscribe a subscriber
   */
  _unsubscribe(datasourceId, subscriber) {
    const subscribers = this.subscribers.get(datasourceId);
    if (!subscribers) return;

    subscribers.delete(subscriber);

    console.log(`[StreamConnectionManager] Subscriber removed from ${datasourceId} (${subscribers.size} remaining)`);

    if (subscribers.size === 0) {
      // Last subscriber — start grace period
      if (this.gracePeriodMs > 0) {
        const existing = this.gracePeriodTimeouts.get(datasourceId);
        if (existing) clearTimeout(existing);

        console.log(`[StreamConnectionManager] Grace period started for ${datasourceId} (${this.gracePeriodMs}ms)`);
        const timeout = setTimeout(() => {
          this.gracePeriodTimeouts.delete(datasourceId);
          const currentSubs = this.subscribers.get(datasourceId);
          if (!currentSubs || currentSubs.size === 0) {
            console.log(`[StreamConnectionManager] Grace period expired for ${datasourceId} — cleaning up`);
            this._cleanup(datasourceId);
          }
        }, this.gracePeriodMs);
        this.gracePeriodTimeouts.set(datasourceId, timeout);
      } else {
        this._cleanup(datasourceId);
      }
    } else {
      // Check if topics changed (a topic may no longer be needed).
      // Debounced so rapid unmount bursts (e.g. dashboard switch) don't
      // trigger a reconnect per departing subscriber.
      const connection = this.connections.get(datasourceId);
      if (connection) {
        const newTopics = this._getCombinedTopics(datasourceId);
        if (newTopics !== connection.topics) {
          this._scheduleTopicReconnect(datasourceId, 'Topics reduced');
        }
      }
    }
  }

  /**
   * Internal: Clean up a connection
   */
  _cleanup(datasourceId) {
    console.log(`[StreamConnectionManager] Cleaning up connection for ${datasourceId}`);

    const graceTimeout = this.gracePeriodTimeouts.get(datasourceId);
    if (graceTimeout) {
      clearTimeout(graceTimeout);
      this.gracePeriodTimeouts.delete(datasourceId);
    }

    const debounceTimeout = this.reconnectDebounceTimeouts.get(datasourceId);
    if (debounceTimeout) {
      clearTimeout(debounceTimeout);
      this.reconnectDebounceTimeouts.delete(datasourceId);
    }

    const connection = this.connections.get(datasourceId);
    if (connection) {
      this._stopHeartbeatWatchdog(datasourceId);
      if (connection.eventSource) connection.eventSource.close();
      if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout);
    }

    this.connections.delete(datasourceId);
    this.subscribers.delete(datasourceId);
    this.buffers.delete(datasourceId);
  }

  /**
   * Internal: Start heartbeat watchdog
   */
  _startHeartbeatWatchdog(datasourceId) {
    this._stopHeartbeatWatchdog(datasourceId);
    const connection = this.connections.get(datasourceId);
    if (!connection) return;

    connection.heartbeatTimer = setInterval(() => {
      const conn = this.connections.get(datasourceId);
      if (!conn || !conn.connected) return;

      const elapsed = Date.now() - conn.lastActivity;
      if (elapsed > 60000) {
        console.warn(`[StreamConnectionManager] No activity on ${datasourceId} for ${Math.round(elapsed / 1000)}s — forcing reconnect`);
        this._stopHeartbeatWatchdog(datasourceId);

        if (conn.eventSource) {
          conn.eventSource.close();
          conn.eventSource = null;
        }
        conn.connected = false;

        const subscribers = this.subscribers.get(datasourceId);
        if (subscribers && subscribers.size > 0) {
          subscribers.forEach(sub => sub.onDisconnect());
          conn.reconnecting = true;
          conn.reconnectAttempts = 0;
          subscribers.forEach(sub => sub.onReconnecting(1, 0));
          this._createEventSource(datasourceId);
        } else {
          this._cleanup(datasourceId);
        }
      }
    }, 15000);
  }

  /**
   * Internal: Stop heartbeat watchdog
   */
  _stopHeartbeatWatchdog(datasourceId) {
    const connection = this.connections.get(datasourceId);
    if (connection?.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
  }

  /**
   * Get connection status for a datasource
   */
  getStatus(datasourceId) {
    const connection = this.connections.get(datasourceId);
    const subscribers = this.subscribers.get(datasourceId);
    const buffer = this.buffers.get(datasourceId);

    return {
      connected: connection?.connected || false,
      reconnecting: connection?.reconnecting || false,
      reconnectAttempts: connection?.reconnectAttempts || 0,
      subscriberCount: subscribers?.size || 0,
      bufferSize: buffer?.length || 0,
      topics: connection?.topics || null,
      inGracePeriod: this.gracePeriodTimeouts.has(datasourceId)
    };
  }

  /**
   * Get the current buffer for a datasource (optionally filtered by topic)
   */
  getBuffer(datasourceId, topics) {
    const buffer = this.buffers.get(datasourceId) || [];
    if (!topics) return buffer;
    const topicList = topics.split(',');
    return buffer.filter(r => !r.topic || topicList.includes(r.topic));
  }

  /**
   * Close all connections immediately, bypassing grace periods.
   */
  closeAll() {
    for (const [, timeout] of this.gracePeriodTimeouts) {
      clearTimeout(timeout);
    }
    this.gracePeriodTimeouts.clear();

    for (const datasourceId of [...this.connections.keys()]) {
      this._cleanup(datasourceId);
    }
  }
}

export default StreamConnectionManager;
