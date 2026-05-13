// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect } from 'react';
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
 *
 * Args:
 *   ready          — boolean; only open the stream once true (e.g.
 *                    after identity bootstrap has resolved).
 *   addNotification — callback shaped like NotificationContext.addNotification
 *                    ({ kind, title, subtitle }).
 */
export function useEventStream({ ready, addNotification }) {
  useEffect(() => {
    if (!ready || typeof addNotification !== 'function') return undefined;

    // Build the SSE URL with whichever credential we have. API key
    // wins (it's a stronger assertion than X-User-ID); fall through
    // to the legacy GUID. If we have neither, skip — the SSE call
    // would 401 anyway.
    const url = new URL(`${apiClient.baseURL}/api/events/stream`);
    if (apiClient.apiKey) {
      url.searchParams.set('token', apiClient.apiKey);
    } else {
      const guid = apiClient.getCurrentUserGuid();
      if (!guid) return undefined;
      url.searchParams.set('user_id', guid);
    }

    const source = new EventSource(url.toString());

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
  }, [ready, addNotification]);
}
