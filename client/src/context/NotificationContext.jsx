// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { createContext, useContext, useReducer, useCallback, useState } from 'react';

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

  return (
    <NotificationContext.Provider value={{
      notifications,
      addNotification,
      removeNotification,
      clearAll,
      toasts,
      pushToast,
      dismissToast,
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
