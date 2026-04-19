// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef } from 'react';
import { ToastNotification } from '@carbon/react';
import { useNotifications } from '../context/NotificationContext';
import './ToastStack.scss';

// Non-error toasts auto-dismiss after this many ms.
const AUTO_DISMISS_MS = 5000;

/**
 * ToastStack
 *
 * Renders the transient toast queue (separate from the bell-panel
 * queue) as Carbon ToastNotification surfaces in the top-right.
 *
 * Behavior:
 *   - Success/info/warning auto-dismiss after 5s.
 *   - Error toasts persist until the user clicks the X. Errors
 *     report a problem the user has to react to; auto-dismissing
 *     them silently is what caused us to ship "silent failure" bugs.
 *
 * Toasts are independent from the bell-panel queue — dismissing a
 * toast doesn't litter the bell panel with the same message later.
 */
export default function ToastStack() {
  const { toasts, dismissToast } = useNotifications();
  const timersRef = useRef(new Map());

  // Schedule auto-dismiss for non-error toasts as they arrive.
  useEffect(() => {
    toasts.forEach((t) => {
      if (t.kind === 'error') return;
      if (timersRef.current.has(t.id)) return;
      const timer = setTimeout(() => {
        dismissToast(t.id);
        timersRef.current.delete(t.id);
      }, AUTO_DISMISS_MS);
      timersRef.current.set(t.id, timer);
    });
    // Drop timers for toasts that vanished (manual dismiss, etc).
    const liveIds = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!liveIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [toasts, dismissToast]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) clearTimeout(timer);
      timersRef.current.clear();
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.slice(0, 5).map((t) => (
        <ToastNotification
          key={t.id}
          kind={t.kind || 'info'}
          title={t.title || ''}
          subtitle={t.subtitle || ''}
          onClose={() => { dismissToast(t.id); return false; }}
          // Carbon's lowContrast variant washes out on g100 dark.
          // Default (high-contrast) reads correctly.
          // We own the timer policy; tell Carbon not to auto-close.
          timeout={0}
        />
      ))}
    </div>
  );
}
