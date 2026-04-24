// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loading,
  Tag,
  Search,
  OverflowMenu,
  OverflowMenuItem
} from '@carbon/react';
import {
  Dashboard,
  Time,
  DataBase,
  StarFilled
} from '@carbon/icons-react';
import apiClient from '../api/client';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import TagFilter from '../components/shared/TagFilter';
import './DashboardTileViewPage.scss';

/**
 * DashboardTileViewPage Component
 *
 * Landing page for View Mode showing all dashboards as tiles in a grid.
 * Each tile shows:
 * - Thumbnail image (if available)
 * - Dashboard name
 * - Description (truncated)
 * - Auto-refresh indicator
 * - Data sources used
 */
function DashboardTileViewPage() {
  const navigate = useNavigate();
  const [dashboards, setDashboards] = useState([]);
  const [charts, setCharts] = useState({});
  const [datasources, setDatasources] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  // Multi-select filters mirroring the design-mode dashboard list
  // (DashboardsListPage). Empty arrays = "show all"; selecting any
  // value narrows the visible tiles. View mode keeps these in
  // component state only — no session/user-config persistence yet.
  const [namespaceFilter, setNamespaceFilter] = useState([]);
  const [tagFilter, setTagFilter] = useState([]);
  const [defaultDashboardId, setDefaultDashboardId] = useState(null);

  useEffect(() => {
    fetchData();
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
      // User may not have config yet
    }
  };

  const handleSetDefault = async (e, dashboardId) => {
    e.stopPropagation();
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

  const fetchData = async () => {
    try {
      // Fetch dashboards, charts, and datasources in parallel
      const [dashboardsRes, chartsRes, datasourcesRes] = await Promise.all([
        apiClient.getDashboards({ page: 1, page_size: 100 }),
        apiClient.getCharts(),
        apiClient.getDatasources()
      ]);

      if (dashboardsRes.dashboards) {
        setDashboards(dashboardsRes.dashboards);
      }

      // Build chart lookup (chart_id -> chart)
      if (chartsRes.charts) {
        const chartMap = {};
        chartsRes.charts.forEach(chart => {
          chartMap[chart.id] = chart;
        });
        setCharts(chartMap);
      }

      // Build datasource lookup (datasource_id -> name)
      if (datasourcesRes.datasources) {
        const dsMap = {};
        datasourcesRes.datasources.forEach(ds => {
          dsMap[ds.id] = ds.name;
        });
        setDatasources(dsMap);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Get unique data source names for a dashboard
  const getDatasourceNames = (dashboard) => {
    if (!dashboard.panels || dashboard.panels.length === 0) return [];

    const dsNames = new Set();
    dashboard.panels.forEach(panel => {
      if (panel.chart_id) {
        const chart = charts[panel.chart_id];
        if (chart?.datasource_id && datasources[chart.datasource_id]) {
          dsNames.add(datasources[chart.datasource_id]);
        }
      }
    });
    return Array.from(dsNames);
  };

  const handleTileClick = (dashboardId) => {
    navigate(`/view/dashboards/${dashboardId}`);
  };

  // Apply namespace, tag, and search filters. Same semantics as the
  // design-mode list (DashboardsListPage): namespace is OR within the
  // selection, tags are OR (any tag matches), search is substring on
  // name or description.
  const filteredDashboards = useMemo(() => {
    let result = [...dashboards];

    if (namespaceFilter.length > 0) {
      const wanted = new Set(namespaceFilter);
      // Records missing a namespace stay visible — defensive against
      // any pre-namespace records that survived the migration.
      result = result.filter(d => !d.namespace || wanted.has(d.namespace));
    }

    if (tagFilter.length > 0) {
      result = result.filter(d => {
        const dTags = d.tags || [];
        return tagFilter.some(t => dTags.includes(t));
      });
    }

    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(d =>
        d.name.toLowerCase().includes(term) ||
        (d.description && d.description.toLowerCase().includes(term))
      );
    }

    return result;
  }, [dashboards, namespaceFilter, tagFilter, searchTerm]);

  if (loading) {
    return (
      <div className="dashboard-tile-view-page">
        <Loading description="Loading dashboards..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-tile-view-page">
        <div className="error-message">Error: {error}</div>
      </div>
    );
  }

  return (
    <div className="dashboard-tile-view-page">
      <div className="tile-view-header">
        <div className="header-title">
          <Dashboard size={24} />
          <h1>Dashboards</h1>
        </div>
      </div>
      <div className="header-toolbar">
        <div className="header-search">
          <Search
            size="lg"
            placeholder="Search dashboards..."
            labelText="Search"
            closeButtonLabelText="Clear search"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <NamespaceFilter
          id="namespace-filter-view-dashboards"
          selected={namespaceFilter}
          onChange={setNamespaceFilter}
        />
        <TagFilter
          entityType="dashboards"
          selected={tagFilter}
          onChange={setTagFilter}
        />
      </div>

      {filteredDashboards.length === 0 ? (
        <div className="no-dashboards">
          {(searchTerm || namespaceFilter.length > 0 || tagFilter.length > 0) ? (
            <p>No dashboards match your filters.</p>
          ) : (
            <p>No dashboards available. Create one in Design mode.</p>
          )}
        </div>
      ) : (
        <div className="dashboard-tiles-grid">
          {filteredDashboards.map((dashboard) => (
            <div
              key={dashboard.id}
              className={`dashboard-tile ${defaultDashboardId === dashboard.id ? 'dashboard-tile--default' : ''}`}
              onClick={() => handleTileClick(dashboard.id)}
            >
              <div className="tile-thumbnail">
                {dashboard.thumbnail ? (
                  <img src={dashboard.thumbnail} alt={dashboard.name} />
                ) : (
                  <div className="thumbnail-placeholder">
                    <Dashboard size={48} />
                  </div>
                )}
              </div>
              <div className="tile-content">
                <h3 className="tile-name">{dashboard.name}</h3>
                {dashboard.description && (
                  <p className="tile-description">{dashboard.description}</p>
                )}
                <div className="tile-footer">
                  <div className="tile-tags">
                    {dashboard.settings?.refresh_interval > 0 && (
                      <Tag type="green" size="sm">
                        <Time size={12} />
                        {dashboard.settings.refresh_interval}s
                      </Tag>
                    )}
                    {dashboard.panels?.length > 0 && (
                      <Tag type="gray" size="sm">
                        {dashboard.panels.length} panel{dashboard.panels.length !== 1 ? 's' : ''}
                      </Tag>
                    )}
                    {getDatasourceNames(dashboard).map(dsName => (
                      <Tag key={dsName} type="blue" size="sm">
                        <DataBase size={12} />
                        {dsName}
                      </Tag>
                    ))}
                  </div>
                  <div className="tile-actions">
                    {defaultDashboardId === dashboard.id ? (
                      <StarFilled size={16} className="default-star" />
                    ) : (
                      <OverflowMenu
                        flipped
                        size="sm"
                        className="tile-menu"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <OverflowMenuItem
                          itemText="Set as Default"
                          onClick={(e) => handleSetDefault(e, dashboard.id)}
                        />
                      </OverflowMenu>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default DashboardTileViewPage;
