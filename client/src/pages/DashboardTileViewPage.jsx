// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loading,
  Tag,
  Search,
  OverflowMenu,
  OverflowMenuItem,
  Button
} from '@carbon/react';
import {
  Dashboard,
  Time,
  DataBase,
  StarFilled,
  Reset
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
  // User-authored tile order: array of dashboard IDs the user has
  // explicitly placed via drag-and-drop. Partial coverage is fine —
  // dashboards not present here fall through to the default
  // most-recently-updated sort. Stored at
  // app_config.settings.dashboard_tile_order.
  //   null  → not yet loaded from server (treat like empty)
  //   []    → user has no manual ordering yet
  //   [...] → user's pinned order, partial allowed
  const [tileOrder, setTileOrder] = useState(null);
  // Drag state — null when no drag is in progress. Held in a ref so
  // we don't re-render the tile grid on every dragover.
  const dragSrcIdRef = useRef(null);
  // {id, side: 'left' | 'right'} — which tile we're hovering over and
  // which half. Drop inserts the dragged tile before (left) or after
  // (right) the target. Tracked together so the indicator can render
  // on the correct edge.
  const [dragOver, setDragOver] = useState(null);
  // Used to suppress the synthetic click some browsers fire on a
  // tile right after it's been dropped. Stores {id, expiresAt}: the
  // dropped tile's ID and a millisecond timestamp after which the
  // suppression no longer applies. A bare boolean was too sticky
  // (intentional clicks on the dropped tile minutes later got
  // swallowed); a tile-scoped + time-bounded gate lets every other
  // click — including later intentional clicks on the same tile —
  // through.
  const droppedRef = useRef({ id: null, expiresAt: 0 });

  useEffect(() => {
    fetchData();
    fetchUserConfig();
  }, []);

  const fetchUserConfig = async () => {
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;

    try {
      const config = await apiClient.getUserConfig(userGuid);
      const settings = config?.settings || {};
      if (settings.default_dashboard_id) {
        setDefaultDashboardId(settings.default_dashboard_id);
      }
      const stored = settings.dashboard_tile_order;
      setTileOrder(Array.isArray(stored) ? stored : []);
    } catch {
      // User may not have config yet — treat as empty manual order.
      setTileOrder([]);
    }
  };

  // Persist the user's tile order. Caller passes the new order array;
  // we save and update local state. GC: drop entries pointing at
  // dashboards the user no longer has access to (parallel to the
  // fit-mode map's GC pattern in DashboardViewerPage.selectFitMode).
  const persistTileOrder = useCallback((nextOrder) => {
    setTileOrder(nextOrder);
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    apiClient.updateUserConfig(userGuid, {
      dashboard_tile_order: nextOrder,
    }).catch(() => {});
  }, []);

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
    // Swallow the synthetic click that fires on the dropped tile
    // immediately after a drop. Scope is tight: only THIS tile, only
    // for ~250ms after the drop. Clicks on other tiles, and later
    // intentional clicks on this tile, navigate normally.
    const dropped = droppedRef.current;
    if (dropped.id === dashboardId && Date.now() < dropped.expiresAt) {
      droppedRef.current = { id: null, expiresAt: 0 };
      return;
    }
    navigate(`/view/dashboards/${dashboardId}`);
  };

  // --- Drag-and-drop tile reorder ---
  // Native HTML5 dnd. Whole-tile drag with a small grab cursor; the
  // drop target is the tile being dragged-over, and the dropped tile
  // is inserted immediately before it. Touch devices won't get
  // reorder; that's intentional (mobile users can use a desktop).
  const handleDragStart = (e, dashboardId) => {
    dragSrcIdRef.current = dashboardId;
    // Required by Firefox to actually initiate the drag
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dashboardId); } catch { /* no-op */ }
  };

  const handleDragOver = (e, overId) => {
    if (!dragSrcIdRef.current) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Decide which half of the target tile the cursor is on. Insert
    // before if the pointer is left-of-center, after if right-of-
    // center. This is the pattern Trello / Notion / GitHub Projects
    // use for grid reorder, and it gives us a clear visual indicator
    // (a vertical bar on the left or right edge).
    const rect = e.currentTarget.getBoundingClientRect();
    const side = (e.clientX - rect.left) < (rect.width / 2) ? 'left' : 'right';
    if (!dragOver || dragOver.id !== overId || dragOver.side !== side) {
      setDragOver({ id: overId, side });
    }
  };

  const handleDragLeave = () => {
    setDragOver(null);
  };

  const handleDrop = (e, dropTargetId) => {
    e.preventDefault();
    const srcId = dragSrcIdRef.current;
    // Capture side BEFORE clearing — handleDragEnd may also fire and
    // wipe state, but we already have what we need.
    const side = dragOver?.id === dropTargetId ? dragOver.side : 'left';
    dragSrcIdRef.current = null;
    setDragOver(null);
    if (!srcId || srcId === dropTargetId) return;

    // Build the new order from the *currently rendered* sequence,
    // remove srcId, then re-insert at the chosen position relative
    // to the drop target.
    //
    // The off-by-one trap: when we filter out srcId first, every
    // index to the right of srcId's old position shifts down by one.
    // The "insert at targetIdx" math is computed AFTER the filter,
    // so it already accounts for that. The only adjustment is
    // appending +1 when dropping on the right half.
    const currentOrder = filteredDashboards.map(d => d.id);
    const without = currentOrder.filter(id => id !== srcId);
    const targetIdx = without.indexOf(dropTargetId);
    if (targetIdx < 0) return;
    const insertAt = side === 'left' ? targetIdx : targetIdx + 1;
    const next = [...without.slice(0, insertAt), srcId, ...without.slice(insertAt)];
    persistTileOrder(next);
    // Mark the source tile as just-dropped for a short window so the
    // synthetic post-drop click on it doesn't navigate. Anything
    // longer than ~150ms is fine; 250ms gives a margin without
    // being noticeable as latency to a user actually trying to
    // double-click their tile to open it.
    droppedRef.current = { id: srcId, expiresAt: Date.now() + 250 };
  };

  const handleDragEnd = () => {
    dragSrcIdRef.current = null;
    setDragOver(null);
  };

  const handleResetOrder = () => {
    persistTileOrder([]);
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

    // Order resolution:
    //   1. Default — most-recently-updated first, matching the
    //      design-mode list (DashboardsListPage). Used as the
    //      starting order and as the fallback for any dashboard the
    //      user hasn't explicitly placed.
    //   2. User order (tileOrder) — array of IDs the user has dragged
    //      into a chosen sequence. Anything in tileOrder appears
    //      first, in the order given.
    //   3. New dashboards (anything not in tileOrder) are prepended
    //      to the front, NOT appended. A new dashboard the user
    //      hasn't seen should be the first thing they notice.
    result.sort((a, b) => {
      const aT = new Date(a.updated || a.created || 0).getTime();
      const bT = new Date(b.updated || b.created || 0).getTime();
      return bT - aT;
    });
    if (tileOrder && tileOrder.length > 0) {
      const orderIdx = new Map(tileOrder.map((id, i) => [id, i]));
      const pinned = [];
      const unpinned = [];
      for (const d of result) {
        if (orderIdx.has(d.id)) {
          pinned.push(d);
        } else {
          unpinned.push(d);
        }
      }
      pinned.sort((a, b) => orderIdx.get(a.id) - orderIdx.get(b.id));
      // unpinned (new-to-the-user) dashboards come first; pinned
      // follow in the user's chosen sequence.
      result = [...unpinned, ...pinned];
    }

    return result;
  }, [dashboards, namespaceFilter, tagFilter, searchTerm, tileOrder]);

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
        {tileOrder && tileOrder.length > 0 && (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Reset}
            onClick={handleResetOrder}
            title="Discard your manual tile order and revert to most-recently-updated first"
          >
            Reset order
          </Button>
        )}
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
          {filteredDashboards.map((dashboard) => {
            const dropSide = dragOver?.id === dashboard.id ? dragOver.side : null;
            return (
            <div
              key={dashboard.id}
              className={[
                'dashboard-tile',
                defaultDashboardId === dashboard.id ? 'dashboard-tile--default' : '',
                dropSide === 'left' ? 'dashboard-tile--drop-before' : '',
                dropSide === 'right' ? 'dashboard-tile--drop-after' : '',
              ].filter(Boolean).join(' ')}
              draggable
              onDragStart={(e) => handleDragStart(e, dashboard.id)}
              onDragOver={(e) => handleDragOver(e, dashboard.id)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, dashboard.id)}
              onDragEnd={handleDragEnd}
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
            );
          })}
        </div>
      )}
    </div>
  );
}

export default DashboardTileViewPage;
