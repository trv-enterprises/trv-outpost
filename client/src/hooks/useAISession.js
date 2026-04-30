// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useCallback, useRef } from 'react';
import apiClient from '../api/client';

/**
 * useAISession Hook
 *
 * Manages AI session state including:
 * - Session creation and lifecycle
 * - WebSocket subscription for real-time updates
 * - Message history
 * - Component preview state
 */
export function useAISession(chartId = null, preflightContext = {}) {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [component, setComponent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [thinking, setThinking] = useState(false);
  const [connected, setConnected] = useState(false);

  const wsRef = useRef(null);
  const sessionIdRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const startingRef = useRef(false); // Guard against duplicate startSession calls
  const MAX_RECONNECT_ATTEMPTS = 5;

  // Start a new AI session
  const startSession = useCallback(async () => {
    // Prevent duplicate calls (React StrictMode double-mounts in dev)
    if (startingRef.current || sessionIdRef.current) {
      console.log('[AI Session] Ignoring duplicate startSession call');
      return null;
    }
    startingRef.current = true;

    setLoading(true);
    setError(null);

    try {
      const response = await apiClient.createAISession(chartId, preflightContext);
      // API returns {session: {...}, component: {...}}
      // (renamed from `chart` in the v0.11.0 Component umbrella rename)
      setSession(response.session);
      sessionIdRef.current = response.session.id;

      // Set initial component state if provided
      if (response.component) {
        setComponent(response.component);
      }

      // Set initial messages if any
      if (response.session?.messages && response.session.messages.length > 0) {
        setMessages(response.session.messages);
      }

      return response.session;
    } catch (err) {
      setError(err.message);
      startingRef.current = false; // Reset guard on error so user can retry
      throw err;
    } finally {
      setLoading(false);
    }
  }, [chartId, preflightContext]);

  // Connect to WebSocket
  const connectWebSocket = useCallback(() => {
    if (!sessionIdRef.current) return;

    // Clear any pending reconnect
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection if any
    if (wsRef.current) {
      wsRef.current.close();
    }

    const url = apiClient.getAISessionWebSocketURL(sessionIdRef.current);
    console.log('[WS] Connecting to:', url);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[WS] Connected');
      setConnected(true);
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWSEvent(data);
      } catch (err) {
        console.error('[WS] Failed to parse event:', err);
      }
    };

    ws.onerror = () => {
      // Suppress WS error logs — reconnect logic handles failures
    };

    ws.onclose = (event) => {
      if (event.code !== 1000 && event.code !== 1006) {
        console.log('[WS] Closed:', event.code, event.reason);
      }
      setConnected(false);

      // Only reconnect if session is still active, not a normal close, and under retry limit
      if (sessionIdRef.current && event.code !== 1000) {
        if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
          console.log(`[WS] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached, giving up`);
          setError('Lost connection to AI session. Please start a new session.');
          return;
        }
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(() => {
          if (sessionIdRef.current) {
            console.log(`[WS] Attempting reconnect (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);
            connectWebSocket();
          }
        }, 3000);
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  // Handle WebSocket events
  // Backend sends: { type: "...", data: {...}, timestamp: "..." }
  const handleWSEvent = useCallback((event) => {
    // Early return for ping events - no state changes needed
    if (event.type === 'ping') {
      return;
    }

    const eventData = event.data || {}; // The nested data field

    switch (event.type) {
      case 'connected':
        console.log('[WS] Session connected:', eventData.session_id);
        break;

      case 'message':
        // New message added to conversation
        if (eventData.message) {
          console.log('[WS] Message event:', eventData.message.role, eventData.message.content?.substring(0, 100));
          setMessages(prev => {
            // Check if message already exists
            // For user messages: check by content and role (handles optimistic updates with temp IDs)
            // For other messages: check by server ID
            const msg = eventData.message;
            const exists = prev.some(m => {
              if (!m) return false;
              // Match by server ID first
              if (m.id === msg.id) return true;
              // For user messages, also match by content+role (handles temp ID mismatch)
              if (msg.role === 'user' && m.role === 'user' && m.content === msg.content) {
                return true;
              }
              return false;
            });
            if (exists) {
              // Replace temp message with server message (to get proper ID)
              return prev.map(m => {
                if (m?.role === 'user' && msg.role === 'user' && m.content === msg.content && m.id?.startsWith('temp-')) {
                  return msg; // Replace with server version
                }
                return m;
              });
            }
            return [...prev, msg];
          });
        }
        setThinking(false);
        break;

      case 'component_update':
        // Component was modified by AI
        console.log('[WS] Component update received:', eventData.component?.id, 'type:', eventData.component?.chart_type);
        if (eventData.component) {
          setComponent(eventData.component);
        }
        break;

      case 'thinking':
        // AI is processing
        setThinking(eventData.thinking !== false);
        break;

      case 'streaming':
        // Partial text content during streaming (future use)
        break;

      case 'status':
        // Session status changed
        if (eventData.status) {
          setSession(prev => prev ? { ...prev, status: eventData.status } : prev);
        }
        break;

      case 'error':
        setError(eventData.error || 'An error occurred');
        setThinking(false);
        break;

      default:
        console.log('[WS] Unknown event type:', event.type, event);
    }
  }, []);

  // Send a message to the AI
  const sendMessage = useCallback(async (content) => {
    if (!sessionIdRef.current || !content.trim()) return;

    setSending(true);
    setError(null);

    // Optimistically add user message to the list
    const userMessage = {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString()
    };
    setMessages(prev => [...prev, userMessage]);

    try {
      await apiClient.sendAIMessage(sessionIdRef.current, content.trim());
      setThinking(true);
    } catch (err) {
      setError(err.message);
      // Remove optimistic message on error
      setMessages(prev => prev.filter(m => m.id !== userMessage.id));
    } finally {
      setSending(false);
    }
  }, []);

  // Save the session (publish draft as final)
  const saveSession = useCallback(async (componentName) => {
    if (!sessionIdRef.current) return;

    setLoading(true);
    setError(null);

    try {
      const result = await apiClient.saveAISession(sessionIdRef.current, componentName);
      return result;
    } catch (err) {
      setError(err.message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Cancel the session (delete draft)
  const cancelSession = useCallback(async () => {
    if (!sessionIdRef.current) return;

    try {
      await apiClient.cancelAISession(sessionIdRef.current);
    } catch (err) {
      console.error('Failed to cancel session:', err);
    } finally {
      // Clean up regardless of success
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Session cancelled');
      }
      setSession(null);
      setMessages([]);
      setComponent(null);
      sessionIdRef.current = null;
      // Keep startingRef.current = true to prevent useEffect from restarting session
      // after cancel. The component will unmount/navigate away, and a fresh mount
      // will have a fresh ref. This prevents the race condition where:
      // 1. cancelSession sets session=null
      // 2. useEffect sees !session and calls startSession
      // 3. startSession creates a NEW draft after we just deleted one
    }
  }, []);

  // Connect WebSocket when session is created
  useEffect(() => {
    if (session?.id) {
      connectWebSocket();
    }

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
      }
    };
  }, [session?.id, connectWebSocket]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close(1000, 'Component unmounted');
      }
    };
  }, []);

  return {
    // State
    session,
    messages,
    component,
    loading,
    sending,
    error,
    thinking,
    connected,

    // Actions
    startSession,
    sendMessage,
    saveSession,
    cancelSession,

    // Utilities
    clearError: () => setError(null)
  };
}

export default useAISession;
