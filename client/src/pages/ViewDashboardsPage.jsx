// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Tile,
  Loading,
  Search,
  Tooltip,
  OverflowMenu,
  OverflowMenuItem
} from '@carbon/react';
import { Dashboard, View, ChartMultitype, DataBase, Information, StarFilled } from '@carbon/icons-react';
import apiClient from '../api/client';
import './ViewDashboardsPage.scss';

/**
 * ViewDashboardsPage Component
 *
 * Displays available dashboards in a tile/card format for View Mode.
 * Users can select a dashboard to view it in full-screen mode.
 */
function ViewDashboardsPage() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [defaultDashboardId, setDefaultDashboardId] = useState(null);

  useEffect(() => {
    fetchDashboards();
    fetchUserConfig();
  }, []);

  const fetchUserConfig = async () => {
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;

    try {
      const config = await apiClient.getUserConfig(userGuid);
      if (config.settings?.default_dashboard_id) {
        setDefaultDashboardId(config.settings.default_dashboard_id);
      }
    } catch {
      // Ignore errors - user may not have config yet
      console.log('No user config found');
    }
  };

  const handleSetDefault = async (e, dashboardId) => {
    e.stopPropagation(); // Prevent tile click
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;

    try {
      await apiClient.updateUserConfig(userGuid, {
        default_dashboard_id: dashboardId
      });
      setDefaultDashboardId(dashboardId);
    } catch (err) {
      console.error('Failed to set default dashboard:', err);
    }
  };

  const fetchDashboards = async () => {
    try {
      setLoading(true);
      // Must go through apiClient — raw fetch() sends no auth
      // headers, which 401s under the auth-required-by-default
      // policy and silently empties the list for any visitor whose
      // credential isn't a cookie (kiosks on ?user_id=, API-key
      // bookmarks, X-User-ID dev mode, etc.). apiClient attaches the
      // right channel automatically.
      const data = await apiClient.getDashboards({
        page: 1,
        page_size: 100,
        include_connections: true,
      });
      if (data.dashboards) {
        setDashboards(data.dashboards);
      } else if (data.error) {
        setError(data.error);
      } else {
        setDashboards([]);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleViewDashboard = (dashboard) => {
    navigate(`/view/dashboards/${dashboard.id}`);
  };

  const getDatasourceNames = (dashboard) => {
    return dashboard.connection_names || [];
  };

  const filteredDashboards = dashboards.filter(dashboard => {
    const term = searchTerm.toLowerCase();
    // Check name and description
    if (dashboard.name.toLowerCase().includes(term)) return true;
    if (dashboard.description && dashboard.description.toLowerCase().includes(term)) return true;
    // Check datasource names
    const dsNames = getDatasourceNames(dashboard);
    if (dsNames.some(name => name.toLowerCase().includes(term))) return true;
    return false;
  });

  if (loading) {
    return (
      <div className="view-dashboards-page">
        <Loading description="Loading dashboards..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="view-dashboards-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="view-dashboards-page">
      <div className="page-header">
        <div className="header-content">
          <Dashboard size={32} className="header-icon" />
          <div className="header-text">
            <h1>Dashboards</h1>
            <p>Select a dashboard to view</p>
          </div>
        </div>
        <div className="header-search">
          <Search
            id="dashboard-search"
            labelText="Search dashboards"
            placeholder="Search by name or description..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            size="lg"
          />
        </div>
      </div>

      {filteredDashboards.length === 0 ? (
        <div className="no-dashboards">
          <ChartMultitype size={64} />
          <h3>No dashboards found</h3>
          <p>
            {searchTerm
              ? 'No dashboards match your search. Try a different term.'
              : 'Create dashboards in Design Mode to view them here.'}
          </p>
        </div>
      ) : (
        <div className="dashboards-grid">
          {filteredDashboards.map((dashboard) => (
            <Tile
              key={dashboard.id}
              className={`dashboard-tile ${defaultDashboardId === dashboard.id ? 'dashboard-tile--default' : ''}`}
              onClick={() => handleViewDashboard(dashboard)}
            >
              <div className="tile-header">
                <ChartMultitype size={24} className="tile-icon" />
                <h3>{dashboard.name}</h3>
                {defaultDashboardId === dashboard.id && (
                  <StarFilled size={16} className="default-star" />
                )}
                {dashboard.description && (
                  <Tooltip label={dashboard.description} align="bottom">
                    <button type="button" className="info-button" onClick={(e) => e.stopPropagation()}>
                      <Information size={16} />
                    </button>
                  </Tooltip>
                )}
                <OverflowMenu
                  flipped
                  size="sm"
                  className="tile-menu"
                  onClick={(e) => e.stopPropagation()}
                >
                  <OverflowMenuItem
                    itemText={defaultDashboardId === dashboard.id ? 'Default Dashboard' : 'Set as Default'}
                    disabled={defaultDashboardId === dashboard.id}
                    onClick={(e) => handleSetDefault(e, dashboard.id)}
                  />
                </OverflowMenu>
              </div>

              {getDatasourceNames(dashboard).length > 0 && (
                <div className="tile-stats">
                  <div className="stat">
                    <DataBase size={16} />
                    <span>{getDatasourceNames(dashboard).join(', ')}</span>
                  </div>
                </div>
              )}

              <div className="tile-action">
                <span>Click to view</span>
                <View size={20} />
              </div>
            </Tile>
          ))}
        </div>
      )}
    </div>
  );
}

export default ViewDashboardsPage;
