// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useReducer, useCallback, useState, useEffect, useRef } from 'react';
import apiClient from '../api/client';

const NotificationContext = createContext();

let nextId = 1;

function notificationReducer(state, action) {
  switch (action.type) {
    case 'ADD': {
      // Deduplicate by server alert id — SSE may push a record we
      // already hydrated from /api/alerts at app load, and the bell
      // shouldn't show two rows for the same alert.
      const incoming = { id: nextId++, timestamp: Date.now(), ...action.payload };
      if (incoming.alertId) {
        const idx = state.findIndex((n) => n.alertId === incoming.alertId);
        if (idx >= 0) return state;
      }
      return [incoming, ...state];
    }
    case 'REMOVE':
      return state.filter(n => n.id !== action.id);
    case 'CLEAR':
      return [];
    case 'SET_PINNED':
      return state.map(n => n.id === action.id ? { ...n, pinned: action.pinned } : n);
    case 'HYDRATE':
      // Replace local server-sourced notifications with the canonical
      // list. Toast-originated local notifications without an alertId
      // are kept; they're transient and not tracked server-side.
      return [
        ...action.alerts,
        ...state.filter((n) => !n.alertId),
      ];
    default:
      return state;
  }
}

/**
 * NotificationProvider
 *
 * Provides two surfaces for telling the user something happened:
 *
 *  - `addNotification(...)` enqueues a *persistent* notification into
 *    the bell-panel queue. Use for things the user might want to look
 *    back at: completed background jobs, audit-style events.
 *  - `pushToast(...)` shows a *transient* toast in the corner without
 *    enqueueing anything. Use for things that only matter in the
 *    moment: a save failed, a value was copied. Errors stay until
 *    dismissed; success/info/warning auto-dismiss after a few seconds
 *    (the ToastStack owns the timer policy).
 *
 * The two surfaces are independent — pushToast doesn't litter the
 * bell panel with stale "your save failed 30 minutes ago" entries.
 */
export function NotificationProvider({ children }) {
  const [notifications, dispatch] = useReducer(notificationReducer, []);
  // Mirror the current notifications array in a ref so callbacks can
  // read the latest state synchronously without depending on it (and
  // thus without retriggering the callback on every notification
  // arrival). The reducer is the source of truth; the ref is just a
  // read cache.
  const notificationsRef = useRef(notifications);
  useEffect(() => { notificationsRef.current = notifications; }, [notifications]);
  // Transient toasts. Separate from `notifications` so they don't
  // pollute the bell panel after dismissal.
  const [toasts, setToasts] = useState([]);
  // Bell-panel open state. Lives in the context (rather than in
  // App-only state) so any component — e.g. the fullscreen
  // dashboard-viewer toolbar, which is outside the App header —
  // can open the panel. Keeps the "only one panel at a time" guarantee
  // because there's a single boolean.
  const [panelOpen, setPanelOpen] = useState(false);
  const openPanel = useCallback(() => setPanelOpen(true), []);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  const togglePanel = useCallback(() => setPanelOpen((v) => !v), []);

  const addNotification = useCallback((notification) => {
    // notification: { kind, title, subtitle, alertId?, pinned? }.
    // alertId, when present, ties the local row to a server-persisted
    // record so dismiss / pin can call /api/alerts/:id/{seen,pin}.
    dispatch({ type: 'ADD', payload: notification });
  }, []);

  // Hydrate the bell on app load from /api/alerts. Idempotent — the
  // ADD reducer dedupes on alertId so a follow-up SSE alert for an
  // already-hydrated record won't double-render.
  const hydrateFromServer = useCallback(async () => {
    try {
      const resp = await apiClient.listAlerts();
      const alerts = (resp?.alerts || []).map((a) => ({
        id: nextId++,
        timestamp: a.fired_at ? new Date(a.fired_at).getTime() : Date.now(),
        alertId: a.id,
        dashboardId: a.dashboard_id || '',  // decoded from external_ref; empty when producer didn't supply one
        kind: a.severity === 'error' ? 'error' : a.severity === 'info' ? 'info' : 'warning',
        title: a.title,
        subtitle: a.subtitle,
        pinned: !!a.pinned,
        seen: !!a.seen,
      }));
      dispatch({ type: 'HYDRATE', alerts });
    } catch (err) {
      // 401 during bootstrap (no creds yet) is expected; anything
      // else is worth a console line, not a UI toast.
      console.warn('Failed to hydrate notifications from server', err);
    }
  }, []);

  const removeNotification = useCallback(async (id) => {
    const found = notificationsRef.current.find((n) => n.id === id);
    dispatch({ type: 'REMOVE', id });
    if (found?.alertId) {
      try {
        await apiClient.markAlertSeen(found.alertId);
      } catch (err) {
        console.warn('Failed to mark alert seen on server', err);
      }
    }
  }, []);

  const setPinned = useCallback(async (id, pinned) => {
    const found = notificationsRef.current.find((n) => n.id === id);
    dispatch({ type: 'SET_PINNED', id, pinned });
    if (found?.alertId) {
      try {
        if (pinned) await apiClient.pinAlert(found.alertId);
        else await apiClient.unpinAlert(found.alertId);
      } catch (err) {
        console.warn('Failed to update alert pin on server', err);
      }
    }
  }, []);

  const clearAll = useCallback(async () => {
    // Mirror server behaviour: pinned entries don't drop on "clear all."
    // They remain in state and continue to render.
    const ids = notificationsRef.current
      .filter((n) => n.alertId && !n.pinned)
      .map((n) => n.alertId);
    // Drop non-pinned from local state; keep pinned visible.
    dispatch({
      type: 'HYDRATE',
      alerts: notificationsRef.current.filter((n) => n.pinned),
    });
    // Fire seen for each persisted entry (best-effort, fire-and-forget).
    for (const aid of ids) {
      apiClient.markAlertSeen(aid).catch((err) => console.warn('clearAll seen failed', err));
    }
  }, []);

  const pushToast = useCallback((toast) => {
    // toast: { kind, title, subtitle }
    setToasts((prev) => [{ id: nextId++, ...toast }, ...prev]);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Wire the apiClient up to our notification surface so it can
  // surface connection-unreachable failures detected inside its
  // central request() wrapper. Mirrors the Clerk token-provider
  // bridge pattern. Registered once per NotificationProvider mount;
  // unregistered on unmount so tests / hot-reloads don't leak.
  useEffect(() => {
    apiClient.setNotificationHandlers({ pushToast, addNotification });
    return () => apiClient.setNotificationHandlers(null);
  }, [pushToast, addNotification]);

  return (
    <NotificationContext.Provider value={{
      notifications,
      addNotification,
      removeNotification,
      setPinned,
      hydrateFromServer,
      clearAll,
      toasts,
      pushToast,
      dismissToast,
      panelOpen,
      openPanel,
      closePanel,
      togglePanel,
    }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotifications must be used within a NotificationProvider');
  }
  return context;
}
