// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { Tag, Tooltip } from '@carbon/react';
import { Dashboard } from '@carbon/icons-react';
import apiClient from '../api/client';
import './DashboardTilesPicker.scss';

/**
 * Selectable list of dashboard tiles. Originally lived inside
 * ViewModeNav (sidebar dashboard switcher); extracted so the alerts
 * UI (rule wizard "target dashboard" picker) and status component
 * can reuse the same affordance without duplicating fetch + styling.
 *
 * Owns its own data fetch — every caller wants the same dashboard
 * list, so centralising the call keeps cache + auth behaviour
 * consistent. Filtering is the caller's responsibility (via the
 * optional `filter` predicate).
 */
function DashboardTilesPicker({
  selectedId = null,
  onSelect,
  filter,
  showHeader = false,
  emptyMessage = 'No dashboards available',
}) {
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Must go through apiClient — raw fetch() sends no auth
        // headers and 401s for any visitor whose credential isn't a
        // cookie (kiosks on ?user_id=, API-key bookmarks, etc.).
        const data = await apiClient.getDashboards({
          page: 1,
          page_size: 100,
          include_connections: true,
        });
        if (cancelled) return;
        if (data?.dashboards) {
          setDashboards(data.dashboards);
        }
      } catch (err) {
        console.error('Failed to fetch dashboards:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visible = filter ? dashboards.filter(filter) : dashboards;

  return (
    <div className="dashboard-tiles-picker">
      {showHeader && (
        <div className="picker-header">
          <Dashboard size={16} />
          <span>Dashboards</span>
        </div>
      )}

      {loading ? (
        <div className="picker-loading">Loading...</div>
      ) : visible.length === 0 ? (
        <div className="picker-empty">{emptyMessage}</div>
      ) : (
        <div className="dashboard-tiles">
          {visible.map((dashboard) => (
            <Tooltip
              key={dashboard.id}
              label={dashboard.description || dashboard.name}
              align="right"
              enterDelayMs={100}
            >
              <div
                className={`dashboard-tile ${selectedId === dashboard.id ? 'selected' : ''}`}
                onClick={() => onSelect?.(dashboard)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect?.(dashboard);
                  }
                }}
              >
                <div className="tile-name">{dashboard.name}</div>
                <div className="tile-description">
                  {dashboard.description || 'No description'}
                </div>
                <div className="tile-tags">
                  {dashboard.settings?.refresh_interval > 0 && (
                    <Tag type="green" size="sm">{dashboard.settings.refresh_interval}s</Tag>
                  )}
                </div>
              </div>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  );
}

export default DashboardTilesPicker;
