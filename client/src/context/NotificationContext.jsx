// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useReducer, useCallback, useState, useEffect } from 'react';
import apiClient from '../api/client';

const NotificationContext = createContext();

let nextId = 1;

function notificationReducer(state, action) {
  switch (action.type) {
    case 'ADD':
      return [{ id: nextId++, timestamp: Date.now(), ...action.payload }, ...state];
    case 'REMOVE':
      return state.filter(n => n.id !== action.id);
    case 'CLEAR':
      return [];
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
    // notification: { kind: 'success'|'error'|'info'|'warning', title, subtitle }
    dispatch({ type: 'ADD', payload: notification });
  }, []);

  const removeNotification = useCallback((id) => {
    dispatch({ type: 'REMOVE', id });
  }, []);

  const clearAll = useCallback(() => {
    dispatch({ type: 'CLEAR' });
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
