// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useRef, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Close, Pin, PinFilled, Launch } from '@carbon/icons-react';
import {
  CheckmarkFilled,
  ErrorFilled,
  WarningFilled,
  InformationFilled
} from '@carbon/icons-react';
import { useNotifications } from '../context/NotificationContext';
import './NotificationPanel.scss';

const KIND_ICONS = {
  success: CheckmarkFilled,
  error: ErrorFilled,
  warning: WarningFilled,
  info: InformationFilled
};

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/**
 * NotificationPanel
 *
 * Dropdown panel anchored below the header notification bell icon.
 * Shows a scrollable list of notifications with dismiss (X) per item.
 */
function NotificationPanel({ open, onClose }) {
  const { notifications, removeNotification, setPinned, clearAll } = useNotifications();
  const navigate = useNavigate();
  const panelRef = useRef(null);
  // Track browser-fullscreen state so the panel can re-anchor + raise
  // its z-index when the App header is hidden and the dashboard's own
  // header (with its in-toolbar bell) is the trigger instead. The
  // dashboard-viewer page creates a z-index:9999 stacking context in
  // fullscreen; the panel needs to sit above that AND under the
  // dashboard toolbar (56px) rather than the App header (48px).
  const [isFullscreen, setIsFullscreen] = useState(
    typeof document !== 'undefined' && !!document.fullscreenElement
  );
  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // Open the dashboard the alert deep-links to. Closes the panel
  // (the dashboard is the user's new context), but does NOT mark
  // the alert seen — dismiss stays explicit per the Phase 2 design.
  // The user opening the dashboard is "I'm investigating," not
  // "I'm done with this alert."
  const handleOpenDashboard = (dashboardId) => {
    if (!dashboardId) return;
    onClose();
    navigate(`/view/dashboards/${dashboardId}`);
  };

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) {
        onClose();
      }
    };
    // Delay listener to avoid catching the click that opened the panel
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClick);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={`notification-panel ${isFullscreen ? 'notification-panel--fullscreen' : ''}`} ref={panelRef}>
      <div className="notification-panel__header">
        <span className="notification-panel__title">Notifications</span>
        {notifications.length > 0 && (
          <button className="notification-panel__clear" onClick={clearAll}>
            Clear all
          </button>
        )}
      </div>
      <div className="notification-panel__list">
        {notifications.length === 0 ? (
          <div className="notification-panel__empty">No notifications</div>
        ) : (
          notifications.map((n) => {
            const Icon = KIND_ICONS[n.kind] || KIND_ICONS.info;
            const PinIcon = n.pinned ? PinFilled : Pin;
            return (
              <div
                key={n.id}
                className={`notification-panel__item notification-panel__item--${n.kind || 'info'}${n.pinned ? ' notification-panel__item--pinned' : ''}`}
              >
                <Icon size={16} className="notification-panel__item-icon" />
                <div className="notification-panel__item-content">
                  <span className="notification-panel__item-title">{n.title}</span>
                  {n.subtitle && (
                    <span className="notification-panel__item-subtitle">{n.subtitle}</span>
                  )}
                  <span className="notification-panel__item-time">{formatTime(n.timestamp)}</span>
                </div>
                {n.dashboardId && (
                  <button
                    className="notification-panel__item-open"
                    onClick={() => handleOpenDashboard(n.dashboardId)}
                    aria-label="Open dashboard"
                    title="Open the dashboard this alert points at"
                  >
                    <Launch size={14} />
                  </button>
                )}
                {n.alertId && (
                  <button
                    className="notification-panel__item-pin"
                    onClick={() => setPinned(n.id, !n.pinned)}
                    aria-label={n.pinned ? 'Unpin notification' : 'Pin notification (keep visible for other users)'}
                    title={n.pinned ? 'Pinned — click to unpin' : 'Pin to keep visible for other users'}
                  >
                    <PinIcon size={14} />
                  </button>
                )}
                <button
                  className="notification-panel__item-close"
                  onClick={() => removeNotification(n.id)}
                  aria-label="Dismiss notification"
                >
                  <Close size={14} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export default NotificationPanel;
