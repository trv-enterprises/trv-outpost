// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { ToastNotification } from '@carbon/react';
import { useNotifications } from '../context/NotificationContext';
import './KioskNotifications.scss';

// On an unattended board, toasts age out automatically — there's no one to
// dismiss them. Unlike the interactive ToastStack, even errors auto-dismiss
// (they'd otherwise pile up forever), just after a longer dwell.
const TOAST_DISMISS_MS = 8000;
const ERROR_DISMISS_MS = 20000;
const MAX_TOASTS = 4;

/**
 * KioskNotifications — passive ambient notification layer for the kiosk board.
 *
 * Two orthogonal, display-only renders (neither ever navigates):
 *   - Toasts (showNotifications): each NEW incoming alert pops as a transient
 *     toast that ages out on its own. Driven off the shared notifications array
 *     (SSE-fed at the app root), tracking which alert ids we've already shown.
 *   - Pinned (showPinned): globally-pinned alerts render as a persistent corner
 *     stack until unpinned (no local dismiss).
 *
 * Reads the headless NotificationContext; renders no bell/panel and wires no
 * click-to-navigate handlers.
 */
function KioskNotifications({ showNotifications = false, showPinned = false }) {
  const { notifications } = useNotifications();

  // Transient toast queue we own (separate from the context's toasts channel).
  const [toasts, setToasts] = useState([]);
  const seenRef = useRef(new Set());
  const timersRef = useRef(new Map());
  const initializedRef = useRef(false);

  // Detect new arrivals in the notifications array → enqueue as toasts.
  // On first render, seed `seen` with whatever is already present so we don't
  // toast the full backlog when the board loads.
  useEffect(() => {
    if (!showNotifications) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      notifications.forEach((n) => seenRef.current.add(n.id));
      return;
    }
    const fresh = notifications.filter((n) => !seenRef.current.has(n.id));
    if (fresh.length === 0) return;
    fresh.forEach((n) => seenRef.current.add(n.id));
    setToasts((prev) => [...fresh, ...prev].slice(0, MAX_TOASTS));
  }, [notifications, showNotifications]);

  // Auto-dismiss timers (longer dwell for errors). Always age out — no human.
  useEffect(() => {
    toasts.forEach((t) => {
      if (timersRef.current.has(t.id)) return;
      const ms = t.kind === 'error' ? ERROR_DISMISS_MS : TOAST_DISMISS_MS;
      const timer = setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
        timersRef.current.delete(t.id);
      }, ms);
      timersRef.current.set(t.id, timer);
    });
    const live = new Set(toasts.map((t) => t.id));
    for (const [id, timer] of timersRef.current) {
      if (!live.has(id)) { clearTimeout(timer); timersRef.current.delete(id); }
    }
  }, [toasts]);

  useEffect(() => () => {
    for (const timer of timersRef.current.values()) clearTimeout(timer);
    timersRef.current.clear();
  }, []);

  const pinned = showPinned ? notifications.filter((n) => n.pinned) : [];

  if (toasts.length === 0 && pinned.length === 0) return null;

  return (
    <div className="kiosk-notifications" aria-live="polite">
      {showPinned && pinned.length > 0 && (
        <div className="kiosk-pinned-stack">
          {pinned.map((n) => (
            <ToastNotification
              key={`pin-${n.id}`}
              kind={n.kind || 'warning'}
              title={n.title || ''}
              subtitle={n.subtitle || ''}
              lowContrast={false}
              hideCloseButton
              timeout={0}
            />
          ))}
        </div>
      )}
      {showNotifications && toasts.length > 0 && (
        <div className="kiosk-toast-stack">
          {toasts.map((t) => (
            <ToastNotification
              key={`toast-${t.id}`}
              kind={t.kind || 'info'}
              title={t.title || ''}
              subtitle={t.subtitle || ''}
              lowContrast={false}
              hideCloseButton
              timeout={0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

KioskNotifications.propTypes = {
  showNotifications: PropTypes.bool,
  showPinned: PropTypes.bool,
};

export default KioskNotifications;
