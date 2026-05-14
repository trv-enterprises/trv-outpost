// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { SideNavItems, Tag, Tooltip } from '@carbon/react';
import { Dashboard } from '@carbon/icons-react';
import apiClient from '../../api/client';
import './ViewModeNav.scss';

/**
 * ViewModeNav Component
 *
 * Navigation for View Mode - displays dashboard tiles in the sidebar.
 * Each tile shows: Name, Description (truncated with hover for full), Tags
 * Clicking a tile navigates to view that dashboard.
 */
function ViewModeNav({ location, navigate }) {
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchDashboards();
  }, []);

  const fetchDashboards = async () => {
    try {
      // Must go through apiClient — raw fetch() sends no auth
      // headers and 401s for any visitor whose credential isn't a
      // cookie (kiosks on ?user_id=, API-key bookmarks, etc.).
      const data = await apiClient.getDashboards({
        page: 1,
        page_size: 100,
        include_connections: true,
      });
      if (data?.dashboards) {
        setDashboards(data.dashboards);
      }
    } catch (err) {
      console.error('Failed to fetch dashboards:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = (dashboardId) => {
    navigate(`/view/dashboards/${dashboardId}`);
  };

  // Extract dashboard ID from current path
  const currentDashboardId = location.pathname.startsWith('/view/dashboards/')
    ? location.pathname.replace('/view/dashboards/', '')
    : null;

  return (
    <SideNavItems>
      <div className="view-mode-nav">
        <div className="nav-header">
          <Dashboard size={16} />
          <span>Dashboards</span>
        </div>

        {loading ? (
          <div className="nav-loading">Loading...</div>
        ) : dashboards.length === 0 ? (
          <div className="nav-empty">No dashboards available</div>
        ) : (
          <div className="dashboard-tiles">
            {dashboards.map((dashboard) => (
              <Tooltip
                key={dashboard.id}
                label={dashboard.description || dashboard.name}
                align="right"
                enterDelayMs={100}
              >
                <div
                  className={`dashboard-tile ${currentDashboardId === dashboard.id ? 'selected' : ''}`}
                  onClick={() => handleSelect(dashboard.id)}
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
    </SideNavItems>
  );
}

export default ViewModeNav;
