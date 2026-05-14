// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Stream Connection Manager
 *
 * Provides a singleton manager for SSE/EventSource connections to socket connections.
 * Multiple components share a SINGLE connection per connection — topics from all
 * subscribers are combined into one SSE URL, and records are filtered client-side.
 *
 * Usage:
 * const manager = StreamConnectionManager.getInstance();
 * const unsubscribe = manager.subscribe(connectionId, callback, { topics: 'my/topic' });
 * // When done:
 * unsubscribe();
 */

import { API_BASE } from '../api/client';
import apiClient from '../api/client';

class StreamConnectionManager {
  static instance = null;

  constructor() {
    // Map of connectionId -> connection state
    this.connections = new Map();
    // Map of connectionId -> Set of subscriber objects
    this.subscribers = new Map();
    // Map of connectionId -> data buffer (for late subscribers)
    this.buffers = new Map();
    // Max buffer size per connection
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

    // Initialize subscribers set
    if (!this.subscribers.has(connectionId)) {
      this.subscribers.set(connectionId, new Set());
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

    this.subscribers.get(connectionId).add(subscriber);

    // Cancel any pending grace period cleanup
    const pendingTimeout = this.gracePeriodTimeouts.get(connectionId);
    if (pendingTimeout) {
      clearTimeout(pendingTimeout);
      this.gracePeriodTimeouts.delete(connectionId);
      console.log(`[StreamConnectionManager] Grace period cancelled for ${connectionId} — reusing connection`);
    }

    const connection = this.connections.get(connectionId);
    const newTopics = this._getCombinedTopics(connectionId);

    if (connection) {
      // Connection exists — check if topics changed
      if (connection.connected) {
        subscriber.onConnect();
        // Replay buffered records matching this subscriber's topics (unless opted out)
        if (!subscriber.skipBufferReplay) {
          const buffer = this.buffers.get(connectionId);
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
        this._scheduleTopicReconnect(connectionId, 'Topics changed');
      }
    } else {
      // No connection yet — create one
      this._connect(connectionId, newTopics);
    }

    return () => {
      this._unsubscribe(connectionId, subscriber);
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
   * Internal: Connect to a connection
   */
  _connect(connectionId, topics) {
    if (this.connections.has(connectionId)) return;

    this.connections.set(connectionId, {
      eventSource: null,
      connected: false,
      reconnecting: false,
      reconnectTimeout: null,
      reconnectAttempts: 0,
      heartbeatTimer: null,
      lastActivity: 0,
      connectionId,
      topics // Combined topics string or null
    });

    if (!this.buffers.has(connectionId)) {
      this.buffers.set(connectionId, []);
    }

    this._createEventSource(connectionId);
  }

  /**
   * Internal: Debounce a topic-change reconnect. Successive calls within
   * reconnectDebounceMs reset the timer; only the last topic set wins.
   * This is what lets a dashboard mounting N controls produce one
   * reconnect instead of N.
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
      console.log(`[StreamConnectionManager] ${reason} for ${connectionId}, reconnecting`);
      this._reconnectWithTopics(connectionId, targetTopics);
    }, this.reconnectDebounceMs);
    this.reconnectDebounceTimeouts.set(connectionId, timeout);
  }

  /**
   * Internal: Reconnect with new topic set (topics added/removed)
   */
  _reconnectWithTopics(connectionId, newTopics) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    // A concrete reconnect is happening — drop any still-pending debounce
    // timer so it doesn't fire again immediately after.
    const pending = this.reconnectDebounceTimeouts.get(connectionId);
    if (pending) {
      clearTimeout(pending);
      this.reconnectDebounceTimeouts.delete(connectionId);
    }

    // Close existing EventSource
    this._stopHeartbeatWatchdog(connectionId);
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

    this._createEventSource(connectionId);
  }

  /**
   * Internal: Create EventSource connection
   */
  _createEventSource(connectionId) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const { topics } = connection;

    // Build URL. EventSource cannot set headers, so credentials must
    // ride the query string. We prefer ?token=<apiKey> when an API
    // key is set (kiosk / agent / electron auth path); otherwise fall
    // back to ?user_id=<guid> (legacy header-equivalent). At least
    // one must be present under the auth-required-by-default policy
    // — without it the SSE 401s, leaving downstream widgets (weather,
    // control-state readers, etc.) stuck in their "Connecting…" state.
    const apiKey = apiClient.apiKey;
    const userGuid = apiClient.getCurrentUserGuid();
    const params = new URLSearchParams();
    if (apiKey) params.set('token', apiKey);
    else if (userGuid) params.set('user_id', userGuid);
    if (topics) params.set('topics', topics);
    const queryString = params.toString();
    let url = `${API_BASE}/api/connections/${connectionId}/stream`;
    if (queryString) url += `?${queryString}`;

    console.log(`[StreamConnectionManager] Connecting to ${connectionId}${topics ? ` (topics: ${topics})` : ''}`);

    const eventSource = new EventSource(url);
    connection.eventSource = eventSource;

    eventSource.onopen = () => {
      console.log(`[StreamConnectionManager] Connected to ${connectionId}`);
      connection.connected = true;
      connection.reconnecting = false;
      connection.reconnectAttempts = 0;
      connection.lastActivity = Date.now();

      this._startHeartbeatWatchdog(connectionId);

      const subscribers = this.subscribers.get(connectionId);
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
        const buffer = this.buffers.get(connectionId) || [];
        buffer.push(record);
        if (buffer.length > this.maxBufferSize) buffer.shift();
        this.buffers.set(connectionId, buffer);

        // Distribute to matching subscribers only
        const subscribers = this.subscribers.get(connectionId);
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
      this._stopHeartbeatWatchdog(connectionId);
      eventSource.close();
      connection.eventSource = null;
      connection.connected = false;

      const subscribers = this.subscribers.get(connectionId);
      if (!subscribers || subscribers.size === 0) {
        this._cleanup(connectionId);
        return;
      }

      // Surface the disconnect to the user. Same debounced helper
      // the HTTP path uses, so a dashboard with multiple panels
      // streaming from the same broken connection still produces
      // exactly one toast per 30s window.
      apiClient._reportConnectionFailure(connectionId);

      subscribers.forEach(sub => sub.onDisconnect());

      connection.reconnecting = true;
      connection.reconnectAttempts++;

      const delay = Math.min(1000 * Math.pow(2, connection.reconnectAttempts - 1), 30000);

      if (connection.reconnectAttempts <= 1) {
        console.debug(`[StreamConnectionManager] Reconnecting to ${connectionId} in ${delay}ms`);
      } else if (connection.reconnectAttempts % 5 === 0) {
        console.warn(`[StreamConnectionManager] Reconnecting to ${connectionId} (attempt ${connection.reconnectAttempts})`);
      }

      subscribers.forEach(sub => sub.onReconnecting(connection.reconnectAttempts, delay));

      connection.reconnectTimeout = setTimeout(() => {
        if (this.connections.has(connectionId)) {
          this._createEventSource(connectionId);
        }
      }, delay);
    };
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

    const connection = this.connections.get(connectionId);
    if (connection) {
      this._stopHeartbeatWatchdog(connectionId);
      if (connection.eventSource) connection.eventSource.close();
      if (connection.reconnectTimeout) clearTimeout(connection.reconnectTimeout);
    }

    this.connections.delete(connectionId);
    this.subscribers.delete(connectionId);
    this.buffers.delete(connectionId);
  }

  /**
   * Internal: Start heartbeat watchdog
   */
  _startHeartbeatWatchdog(connectionId) {
    this._stopHeartbeatWatchdog(connectionId);
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    connection.heartbeatTimer = setInterval(() => {
      const conn = this.connections.get(connectionId);
      if (!conn || !conn.connected) return;

      const elapsed = Date.now() - conn.lastActivity;
      if (elapsed > 60000) {
        console.warn(`[StreamConnectionManager] No activity on ${connectionId} for ${Math.round(elapsed / 1000)}s — forcing reconnect`);
        this._stopHeartbeatWatchdog(connectionId);

        if (conn.eventSource) {
          conn.eventSource.close();
          conn.eventSource = null;
        }
        conn.connected = false;

        const subscribers = this.subscribers.get(connectionId);
        if (subscribers && subscribers.size > 0) {
          subscribers.forEach(sub => sub.onDisconnect());
          conn.reconnecting = true;
          conn.reconnectAttempts = 0;
          subscribers.forEach(sub => sub.onReconnecting(1, 0));
          this._createEventSource(connectionId);
        } else {
          this._cleanup(connectionId);
        }
      }
    }, 15000);
  }

  /**
   * Internal: Stop heartbeat watchdog
   */
  _stopHeartbeatWatchdog(connectionId) {
    const connection = this.connections.get(connectionId);
    if (connection?.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
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
      reconnecting: connection?.reconnecting || false,
      reconnectAttempts: connection?.reconnectAttempts || 0,
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
   * Close all connections immediately, bypassing grace periods.
   */
  closeAll() {
    for (const [, timeout] of this.gracePeriodTimeouts) {
      clearTimeout(timeout);
    }
    this.gracePeriodTimeouts.clear();

    for (const connectionId of [...this.connections.keys()]) {
      this._cleanup(connectionId);
    }
  }
}

export default StreamConnectionManager;
