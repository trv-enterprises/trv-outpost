// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useEffect, useRef, useState } from 'react';
import apiClient from '../api/client';

// Step 10 uses a coarse polling refetch after sending a message —
// just enough to get message-list rendering working end-to-end.
// Step 11 replaces this with SSE / WebSocket streaming for live
// token-by-token deltas.
const REFETCH_DELAY_MS = 800;
const REFETCH_INTERVAL_MS = 1500;
const REFETCH_MAX_ATTEMPTS = 12; // ~18s total

/**
 * useAssistantSession — owns the lifecycle of a single Dashboard
 * Assistant conversation. v1 keeps things browser-local: no
 * persistence beyond the session record itself (TTL-cleaned
 * server-side after 24h of inactivity), no restore from server,
 * no conversation list.
 *
 * On `open=true`, lazily creates a chat session the first time the
 * user sends a message. On `open=false`, the session ID is kept in
 * state so re-opening the sidecard resumes the same conversation
 * (since the server-side record outlives the panel-close action).
 *
 * Returns:
 *   - sessionId: current session ID, or null
 *   - messages: AIMessage[]
 *   - loading: true while fetching the session
 *   - sending: true while a send is in-flight
 *   - error: last error message, or null
 *   - sendMessage(text): create-session-if-needed + send + refetch
 *   - clearChat(): drop the current session ID, start fresh next send
 */
export default function useAssistantSession() {
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);

  // Refs hold the latest values for the async polling loop to read
  // without re-running effects each time state changes.
  const sessionIdRef = useRef(null);
  const cancelPollRef = useRef(null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const refetch = useCallback(async () => {
    const id = sessionIdRef.current;
    if (!id) return;
    try {
      const data = await apiClient.getAISession(id);
      const session = data?.session || data;
      if (session && Array.isArray(session.messages)) {
        setMessages(session.messages);
      }
    } catch (err) {
      setError(err?.message || String(err));
    }
  }, []);

  // Stop any in-flight polling loop. Called on send (to start
  // fresh) and on clear-chat.
  const stopPolling = useCallback(() => {
    if (cancelPollRef.current) {
      cancelPollRef.current();
      cancelPollRef.current = null;
    }
  }, []);

  // Poll the session for new messages until the assistant produces
  // a final text response (or we hit the cap). This is the step-10
  // stand-in for SSE streaming — coarse but works. The server-side
  // session record is the source of truth.
  const startPolling = useCallback(() => {
    stopPolling();
    let attempts = 0;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      await refetch();
      if (cancelled) return;
      // Stop polling when the most recent message is an assistant
      // turn WITHOUT pending tool_calls (i.e. the model returned
      // plain text and is done for this user turn). The simple
      // shape-test here suffices for step 10; step 11 switches to
      // streaming and this whole pattern goes away.
      const last = messagesRef.current[messagesRef.current.length - 1];
      const finishedTurn =
        last &&
        last.role === 'assistant' &&
        (!last.tool_calls || last.tool_calls.length === 0) &&
        last.content;
      if (finishedTurn || attempts >= REFETCH_MAX_ATTEMPTS) {
        return;
      }
      const handle = setTimeout(tick, REFETCH_INTERVAL_MS);
      cancelPollRef.current = () => {
        cancelled = true;
        clearTimeout(handle);
      };
    };
    cancelPollRef.current = () => { cancelled = true; };
    setTimeout(tick, REFETCH_DELAY_MS);
  }, [refetch, stopPolling]);

  // Mirror messages into a ref so the polling tick can read the
  // latest array without re-creating the closure on every render.
  const messagesRef = useRef(messages);
  useEffect(() => { messagesRef.current = messages; }, [messages]);

  const sendMessage = useCallback(async (text) => {
    const content = String(text || '').trim();
    if (!content || sending) return;
    setError(null);
    setSending(true);

    // Optimistically render the user message so the UI feels
    // responsive — the server-side record will overwrite this on
    // the first refetch.
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
      let id = sessionIdRef.current;
      if (!id) {
        setLoading(true);
        const created = await apiClient.createAssistantSession();
        id = created?.session?.id || created?.id;
        if (!id) {
          throw new Error('No session ID returned from server');
        }
        setSessionId(id);
        sessionIdRef.current = id;
        setLoading(false);
      }
      await apiClient.sendAIMessage(id, content);
      startPolling();
    } catch (err) {
      setError(err?.message || String(err));
      setLoading(false);
    } finally {
      setSending(false);
    }
  }, [sending, startPolling]);

  const clearChat = useCallback(() => {
    stopPolling();
    setSessionId(null);
    sessionIdRef.current = null;
    setMessages([]);
    setError(null);
  }, [stopPolling]);

  // Stop polling on unmount so a closed sidecard doesn't keep
  // ticking forever.
  useEffect(() => () => stopPolling(), [stopPolling]);

  return {
    sessionId,
    messages,
    loading,
    sending,
    error,
    sendMessage,
    clearChat,
    refetch,
  };
}
