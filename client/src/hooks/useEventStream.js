// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useState } from 'react';
import apiClient from '../api/client';

/**
 * useEventStream
 *
 * Opens a persistent SSE connection to /api/events/stream once the
 * caller is authenticated and dispatches incoming events onto the
 * provided notification surface. One stream per browser tab; the
 * server fans every server-side event (alerts today) out to every
 * open subscriber.
 *
 * Auth: EventSource can't set headers, so we pass the credential
 * via the `?token=` or `?user_id=` query params (auth middleware
 * already supports both — same path EventSource uses for streaming
 * data subscriptions).
 *
 * Reconnect: EventSource auto-reconnects on transport-level errors.
 * The server emits a `connected` event on (re)open so we can spot
 * reconnects in the console without surfacing them to the user.
 * The ?st= access token is baked into the URL at open time and can't
 * be updated in flight, so we also re-open the stream whenever
 * apiClient rotates the token (a `tokenVersion` bump re-runs the
 * effect) — otherwise the stream would silently stop once the
 * baked-in token expires server-side.
 *
 * Args:
 *   ready          — boolean; only open the stream once true (e.g.
 *                    after identity bootstrap has resolved).
 *   addNotification — callback shaped like NotificationContext.addNotification
 *                    ({ kind, title, subtitle }).
 */
export function useEventStream({ ready, addNotification }) {
  // Bumped whenever the access token rotates so the effect below tears
  // down and reopens the EventSource with a fresh ?st=.
  const [tokenVersion, setTokenVersion] = useState(0);
  useEffect(() => {
    const unsubscribe = apiClient.onTokenChange(() => {
      setTokenVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!ready || typeof addNotification !== 'function') return undefined;

    // SSE auth: access JWT in the ?st= query (EventSource can't
    // set headers). Skip when no token is available — the request
    // would 401 anyway.
    const auth = apiClient.streamAuthQuery();
    if (!auth) return undefined;
    const url = `${apiClient.baseURL}/api/events/stream?${auth}`;
    const source = new EventSource(url);

    source.addEventListener('connected', () => {
      // Quiet — don't surface every reconnect as a UI event.
      // eslint-disable-next-line no-console
      console.log('[events] SSE connected');
    });

    source.addEventListener('alert', (msg) => {
      let payload;
      try {
        payload = JSON.parse(msg.data);
      } catch (err) {
        console.warn('[events] failed to parse alert payload', err);
        return;
      }
      addNotification({
        alertId: payload.id,                       // ties the bell row to the persisted record for seen / pin actions
        dashboardId: payload.dashboard_id || '',   // decoded from external_ref; empty when producer didn't supply one
        kind: payload.severity === 'error' ? 'error' : 'warning',
        title: payload.title || 'Alert',
        subtitle: payload.subtitle || '',
        timestamp: payload.fired_at ? new Date(payload.fired_at).getTime() : Date.now(),
      });
    });

    source.onerror = (err) => {
      // EventSource auto-reconnects; just log. If the failure is
      // permanent (e.g. server denies 4xx), `readyState` will be
      // CLOSED — log it so we can spot it in dev.
      console.warn('[events] SSE error', err, 'readyState:', source.readyState);
    };

    return () => {
      source.close();
    };
  }, [ready, addNotification, tokenVersion]);
}
