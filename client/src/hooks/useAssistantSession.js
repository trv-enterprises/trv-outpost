// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';
import { useAssistantSurfaceValue } from '../context/AssistantSurfaceContext';

// Reconnect tuning — same shape as the Component AI agent's
// useAISession. Stop trying after this many failures so a server
// outage doesn't burn battery forever.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 3000;

/**
 * useAssistantSession — owns the lifecycle of a single Dashboard
 * Assistant conversation, talking to the server over the existing
 * WebSocket channel that the Component AI agent already uses.
 *
 * On first send, lazily creates a kind="chat" session, opens a WS,
 * and listens for events:
 *   - `message`: a persisted message (user OR assistant). Replaces
 *     the optimistic user-message entry if one exists.
 *   - `streaming`: partial text content from the model mid-turn.
 *     Rendered as the assistant's "in-progress" content until the
 *     paired `message` event lands.
 *   - `thinking`: bool toggle for the spinner state.
 *   - `error` / `budget_warn`: surfaced through error state /
 *     warning state respectively.
 *
 * Session ID persists across panel close/reopen so reopening
 * resumes the same conversation (the server-side record outlives
 * the panel by up to 24h). clearChat() drops state for a fresh
 * conversation.
 */
export default function useAssistantSession() {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [thinking, setThinking] = useState(false);
  const [warning, setWarning] = useState(null);
  const [error, setError] = useState(null);
  const [sending, setSending] = useState(false);

  const sessionIdRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const messagesRef = useRef(messages);

  // Surface context: the current page registers this via
  // useAssistantSurface(). We attach it to every outgoing message so
  // the agent's prompt sees "user is viewing X" without a tool round
  // trip. Read latest via ref so sendMessage's stable callback doesn't
  // need a dep on every surface change.
  const surface = useAssistantSurfaceValue();
  const surfaceRef = useRef(surface);
  useEffect(() => { surfaceRef.current = surface; }, [surface]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // mergeMessage — append a new message OR replace an existing one
  // by ID. Also drops local optimistic user-message entries (id
  // prefix "local-") when the canonical version arrives.
  const mergeMessage = useCallback((next) => {
    if (!next || !next.id) return;
    setMessages((prev) => {
      // Replace by ID if present.
      const existingIdx = prev.findIndex((m) => m.id === next.id);
      if (existingIdx !== -1) {
        const updated = prev.slice();
        updated[existingIdx] = next;
        return updated;
      }
      // If it's a user message, drop any matching local-optimistic
      // copy (same content, same role). User typed → optimistic
      // entry pushed → server broadcast arrives → we want one row.
      if (next.role === 'user') {
        const withoutLocal = prev.filter(
          (m) => !(m.id?.startsWith('local-') && m.role === 'user' && m.content === next.content)
        );
        return [...withoutLocal, next];
      }
      return [...prev, next];
    });
  }, []);

  const handleWSEvent = useCallback((event) => {
    if (!event || !event.type) return;
    const data = event.data || {};
    switch (event.type) {
      case 'connected':
        // First event after WS handshake. Nothing to do — UI
        // doesn't surface a "connected" indicator.
        break;
      case 'message':
        if (data.message) {
          mergeMessage(data.message);
          // Clear any in-progress streaming text when the canonical
          // message arrives; the persisted content supersedes it.
          if (data.message.role === 'assistant') {
            setStreamingContent('');
          }
        }
        break;
      case 'streaming':
        // Server sends partial content; for the chat agent today
        // this is the full turn's text at once rather than
        // token-by-token, but the rendering treats it the same:
        // a single transient string that the next `message` event
        // overwrites.
        if (typeof data.content === 'string') {
          setStreamingContent(data.content);
        }
        if (data.done) {
          // 'done' just means "this is the last streaming chunk."
          // The `message` event right after carries the persisted
          // record; we leave streamingContent alone until that
          // event clears it.
        }
        break;
      case 'thinking':
        setThinking(!!data.thinking);
        break;
      case 'budget_warn':
        if (data.reason) setWarning(String(data.reason));
        break;
      case 'error':
        if (data.error) setError(String(data.error));
        setThinking(false);
        break;
      default:
        // Unknown event types are non-fatal; the Component AI
        // agent emits some events the chat agent doesn't and
        // vice versa. Silently ignore.
        break;
    }
  }, [mergeMessage]);

  const openWebSocket = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;

    // Close any existing connection before opening a new one.
    if (wsRef.current) {
      try { wsRef.current.close(); } catch { /* ignore */ }
      wsRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    const url = apiClient.getAISessionWebSocketURL(id);
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        handleWSEvent(parsed);
      } catch {
        // ignore unparseable frames
      }
    };

    ws.onerror = () => {
      // Suppress noisy logs — onclose handles reconnect.
    };

    ws.onclose = (closeEvent) => {
      // Clean close, no reconnect.
      if (closeEvent.code === 1000) return;
      // No session ID anymore (user cleared) — no reconnect.
      if (!sessionIdRef.current) return;
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setError('Lost connection to assistant. Send a new message to retry.');
        return;
      }
      reconnectAttemptsRef.current += 1;
      reconnectTimeoutRef.current = setTimeout(openWebSocket, RECONNECT_DELAY_MS);
    };
  }, [handleWSEvent]);

  const closeWebSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      try { wsRef.current.close(1000); } catch { /* ignore */ }
      wsRef.current = null;
    }
  }, []);

  const ensureSession = useCallback(async () => {
    if (sessionIdRef.current) return sessionIdRef.current;
    const created = await apiClient.createAssistantSession();
    const id = created?.session?.id || created?.id;
    if (!id) throw new Error('No session ID returned from server');
    setSessionId(id);
    sessionIdRef.current = id;
    // Open the WS as soon as the session exists so we don't miss
    // any events the agent emits before we'd otherwise be listening.
    openWebSocket();
    return id;
  }, [openWebSocket]);

  const sendMessage = useCallback(async (text) => {
    const content = String(text || '').trim();
    if (!content || sending) return;
    setError(null);
    setWarning(null);
    setSending(true);

    // Optimistic render so the input feels responsive — the
    // server-side broadcast will dedup this via mergeMessage when
    // its `message` event arrives.
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: 'user',
        content,
        timestamp: new Date().toISOString(),
      },
    ]);

    try {
      const id = await ensureSession();
      await apiClient.sendAIMessage(id, content, { surfaceContext: surfaceRef.current });
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSending(false);
    }
  }, [sending, ensureSession]);

  const clearChat = useCallback(() => {
    closeWebSocket();
    setSessionId(null);
    sessionIdRef.current = null;
    setMessages([]);
    setStreamingContent('');
    setThinking(false);
    setError(null);
    setWarning(null);
  }, [closeWebSocket]);

  // Tear down the WS on unmount so a closed sidecard doesn't leak.
  useEffect(() => () => closeWebSocket(), [closeWebSocket]);

  return {
    sessionId,
    messages,
    streamingContent,
    thinking,
    sending,
    warning,
    error,
    sendMessage,
    clearChat,
  };
}
