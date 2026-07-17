// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loading,
  Search,
  OverflowMenu,
  OverflowMenuItem,
  Button,
  Dropdown,
  Tag,
  Pagination,
} from '@carbon/react';
import { Dashboard, StarFilled, Reset, OverflowMenuVertical, Checkmark, Filter } from '@carbon/icons-react';
import apiClient from '../api/client';
import usePaginatedList from '../hooks/usePaginatedList';
import useIsMobile from '../hooks/useIsMobile';
import NamespaceFilter from '../components/shared/NamespaceFilter';
import TagFilter from '../components/shared/TagFilter';
import ResetFiltersButton from '../components/shared/ResetFiltersButton';
import SortMenu from '../components/shared/SortMenu';
import DashboardTile from '../components/DashboardTile';
import { orderDashboardsForViewer } from '../utils/dashboardOrder';
import { dashboardUsesVariable } from '../utils/dashboardVariable';
import { toUsageItems } from '../utils/usageRefs';
import { getListPrefs, setListPrefs } from '../utils/listPrefs';
import { syncKioskFromUrl, getKioskDashboardIds, isKioskActive } from '../utils/kioskMode';
import '../components/shared/FilterOverflowMenu.scss';
import './DashboardTileViewPage.scss';

const PAGE_SIZES = [25, 50, 100];

/**
 * DashboardTileViewPage Component
 *
 * Landing page for View Mode showing dashboards as tiles in a grid.
 * Each tile shows:
 * - Thumbnail image (if available)
 * - Dashboard name
 * - Description (truncated)
 * - Auto-refresh indicator
 * - Data sources used
 *
 * #114: server-side filter/sort/pagination via usePaginatedList — the same
 * paged DashboardSummary path the design-mode list uses, so the two pages
 * can't drift on filter semantics or response shape. The viewer's prev/next
 * ordering no longer depends on this page loading everything: on a filtered
 * tile click we fetch the full ordered id set from the ids_only nav
 * projection and hand THAT to the viewer.
 */
function DashboardTileViewPage({ canDesign = false }) {
  const navigate = useNavigate();
  const [connections, setConnections] = useState({}); // id -> name, for the dropdown options
  // Filters persist across navigation within the same browser tab via
  // sessionStorage. Filters are session-y (not user-config-y) — fresh
  // tab / new browser = clean slate. Survives clicking into a viewer
  // and back, and survives a tab reload.
  const persistedFilters = (() => {
    try {
      const raw = sessionStorage.getItem('tile:filters');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  })();

  const [searchTerm, setSearchTerm] = useState(persistedFilters.search || '');
  // Multi-select filters mirroring the design-mode dashboard list
  // (DashboardsListPage). Empty arrays = "show all"; selecting any
  // value narrows the visible tiles.
  const [namespaceFilter, setNamespaceFilter] = useState(Array.isArray(persistedFilters.namespaces) ? persistedFilters.namespaces : []);
  const [tagFilter, setTagFilter] = useState(Array.isArray(persistedFilters.tags) ? persistedFilters.tags : []);
  // Single-select connection filter. 'all' = no filter.
  const [connectionFilter, setConnectionFilter] = useState(persistedFilters.connection || 'all');
  // Variable-driven only: keep dashboards that define + enable variables.
  // #114: like design mode, this is a client-only post-filter on the loaded
  // page — the dashboards API has no variable-driven field.
  const [variableOnly, setVariableOnly] = useState(!!persistedFilters.variableOnly);
  // Sort mode for the tile grid. 'manual' means honour the user's
  // drag-reorder; any other value disables drag and applies a key+dir
  // sort. Defaults to 'manual' for backwards-compat (existing users with
  // a stored tile order keep seeing their layout).
  const [sortKey, setSortKey] = useState('manual');
  const [sortDirection, setSortDirection] = useState('asc');

  // On mobile the filter row (namespace/tag/connection dropdowns + sort) is
  // collapsed behind a Filters toggle so it doesn't eat the screen above the
  // tiles; search stays always visible. Desktop renders them inline as before.
  const isMobile = useIsMobile();
  const [filtersOpen, setFiltersOpen] = useState(false);
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

  // Kiosk mode: if the URL carries `?dashboards=id1,id2,id3`, lock
  // the tile picker to that set in that order. The util consumes the
  // query string and caches to sessionStorage so reloads keep the
  // lock. Read synchronously on the initial render so the first paint
  // already reflects the kiosk constraint instead of flashing the
  // unfiltered grid first.
  const [kioskIds] = useState(() => syncKioskFromUrl() || getKioskDashboardIds());
  const kiosk = isKioskActive();
  // Kiosk dashboards are fetched by id (the kiosk set is a handful of
  // explicit dashboards) instead of through the paginated list.
  const [kioskDashboards, setKioskDashboards] = useState([]);
  const [kioskLoading, setKioskLoading] = useState(kiosk);

  // Server-side filter/sort/pagination (#114, mirroring DashboardsListPage
  // #21). Rows are DashboardSummary objects (include_connections:true) —
  // each carries component_usage/connection_usage {id,name} pairs +
  // panel_count instead of the full panels array. 'manual' sort isn't a
  // server field; send 'updated' desc and re-apply the pinned order
  // client-side within the current page.
  const serverSortKey = sortKey === 'manual' ? 'updated' : sortKey;
  const serverSortDir = sortKey === 'manual' ? 'desc' : sortDirection;
  const {
    rows: dashboards,
    total,
    loading,
    hasLoadedOnce,
    error,
    page,
    setPage,
    pageSize,
    setPageSize,
  } = usePaginatedList({
    // Kiosk mode never consults the paginated list — resolve empty
    // instead of fetching a page nobody renders.
    fetcher: (q) => (kiosk ? Promise.resolve({ dashboards: [], total: 0 }) : apiClient.getDashboards(q)),
    extract: (resp) => ({ rows: resp?.dashboards || [], total: resp?.total || 0, hasMore: resp?.has_more }),
    filters: {
      include_connections: true,
      namespace: namespaceFilter,
      tags: tagFilter,
      connection_id: connectionFilter === 'all' ? '' : connectionFilter,
    },
    sortKey: serverSortKey,
    sortDir: serverSortDir,
    initialPageSize: getListPrefs('view-dashboards').pageSize || 25,
    search: searchTerm,
    searchKey: 'name',
  });

  useEffect(() => {
    fetchUserConfig();
  }, []);

  // One-shot all-connections fetch for the connection filter dropdown
  // options (comprehensive set, independent of the paginated rows).
  useEffect(() => {
    if (kiosk) return undefined;
    let cancelled = false;
    apiClient.getConnections({ page_size: 'all' }).then((data) => {
      if (cancelled || !data?.connections) return;
      const connMap = {};
      data.connections.forEach((conn) => { connMap[conn.id] = conn.name; });
      setConnections(connMap);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [kiosk]);

  // Kiosk mode: fetch exactly the manifest's dashboards by id. Failures
  // (deleted id in a stale manifest) drop out silently.
  useEffect(() => {
    if (!kioskIds || kioskIds.length === 0) return undefined;
    let cancelled = false;
    Promise.all(kioskIds.map((id) => apiClient.getDashboard(id).catch(() => null)))
      .then((list) => {
        if (cancelled) return;
        setKioskDashboards(list.filter(Boolean));
        setKioskLoading(false);
      });
    return () => { cancelled = true; };
  }, [kioskIds]);

  // Persist filter state to sessionStorage so it survives a
  // round-trip through the viewer (or a tab reload). Clears the
  // entry entirely when no filter is active — keeps the storage
  // honest about "no filter" rather than a stale `{}`.
  useEffect(() => {
    const hasAny = (
      searchTerm ||
      namespaceFilter.length > 0 ||
      tagFilter.length > 0 ||
      connectionFilter !== 'all' ||
      variableOnly
    );
    try {
      if (hasAny) {
        sessionStorage.setItem('tile:filters', JSON.stringify({
          search: searchTerm,
          namespaces: namespaceFilter,
          tags: tagFilter,
          connection: connectionFilter,
          variableOnly,
        }));
      } else {
        sessionStorage.removeItem('tile:filters');
      }
    } catch {
      // quota / disabled — non-fatal, filters just don't survive.
    }
  }, [searchTerm, namespaceFilter, tagFilter, connectionFilter, variableOnly]);

  // Page size is a durable UI preference (per-user list prefs), unlike
  // the session-y filters above.
  useEffect(() => {
    setListPrefs('view-dashboards', { pageSize });
  }, [pageSize]);

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
      const storedSort = settings.dashboard_tile_sort;
      if (storedSort && typeof storedSort.key === 'string') {
        setSortKey(storedSort.key);
        setSortDirection(storedSort.direction === 'desc' ? 'desc' : 'asc');
      }
    } catch {
      // User may not have config yet — treat as empty manual order.
      setTileOrder([]);
    }
  };

  // Persist the sort preference. Caller passes the new key + direction;
  // we save and update local state. Mirrors persistTileOrder's pattern.
  const persistSort = useCallback((nextKey, nextDirection) => {
    setSortKey(nextKey);
    setSortDirection(nextDirection);
    const userGuid = apiClient.getCurrentUserGuid();
    if (!userGuid) return;
    apiClient.updateUserConfig(userGuid, {
      dashboard_tile_sort: { key: nextKey, direction: nextDirection },
    }).catch(() => {});
  }, []);

  // Persist the user's tile order. Caller passes the new order array;
  // we save and update local state.
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

  // True when any SERVER-side filter narrows the set. variableOnly is
  // deliberately excluded — it's a page-local client post-filter (no server
  // field), so it narrows the visible tiles but not the viewer's nav set.
  const serverFiltersActive = (
    !!searchTerm ||
    namespaceFilter.length > 0 ||
    tagFilter.length > 0 ||
    connectionFilter !== 'all'
  );

  const handleTileClick = async (dashboardId) => {
    // Swallow the synthetic click that fires on the dropped tile
    // immediately after a drop. Scope is tight: only THIS tile, only
    // for ~250ms after the drop. Clicks on other tiles, and later
    // intentional clicks on this tile, navigate normally.
    const dropped = droppedRef.current;
    if (dropped.id === dashboardId && Date.now() < dropped.expiresAt) {
      droppedRef.current = { id: null, expiresAt: 0 };
      return;
    }
    // Carry the currently-filtered dashboard ID list into the viewer so
    // its prev/next arrows walk the same set the user just saw. Filters
    // are session-y, so they ride in route state (cleared on direct URL /
    // new tab); the viewer also caches into sessionStorage so a tab
    // reload keeps the filtered list intact.
    //
    // #114: the page only holds ONE page of rows, so the full filtered id
    // set comes from the server's ids_only nav projection using the same
    // filter params as the grid. Membership is what matters — the viewer
    // re-applies the user's tile order/sort to whatever set it's given.
    if (serverFiltersActive) {
      try {
        const resp = await apiClient.getDashboards({
          ids_only: true,
          name: searchTerm,
          namespace: namespaceFilter,
          tags: tagFilter,
          connection_id: connectionFilter === 'all' ? '' : connectionFilter,
        });
        const filteredIds = (resp?.dashboards || []).map((d) => d.id);
        navigate(`/view/dashboards/${dashboardId}`, {
          state: { filteredDashboardIds: filteredIds },
        });
        return;
      } catch {
        // Nav-ref fetch failed — fall through to unfiltered navigation
        // rather than blocking the click.
      }
    }
    // Unfiltered click — clear any stale viewer-side filter cache so
    // the viewer's prev/next don't accidentally inherit a previous
    // session's filter via sessionStorage.
    try { sessionStorage.removeItem('viewer:filter'); } catch { /* no-op */ }
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
    const currentOrder = displayDashboards.map(d => d.id);
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

  // Manual drag-reorder is only safe within a single page — it can't
  // move rows that live on other pages. Disable it whenever the dataset
  // spans more than one page (same rule as the design-mode list, #21).
  const isPaginated = total > pageSize;

  // Client-only transforms on top of the server-paged rows (#114).
  // Filtering/search/namespace/tags/connection already happened
  // server-side; what's left has no server equivalent:
  //   - variableOnly: post-filter on the loaded page (variables are rare).
  //   - tile order: orderDashboardsForViewer re-sequences the current page
  //     so this page and the viewer walk dashboards in the same sequence.
  // Kiosk short-circuits everything: the operator's URL manifest is the
  // source of truth for the set AND the order.
  const displayDashboards = useMemo(() => {
    if (kioskIds && kioskIds.length > 0) {
      return orderDashboardsForViewer(kioskDashboards, kioskIds, { key: 'manual', direction: 'asc' });
    }

    let result = [...dashboards];
    if (variableOnly) {
      result = result.filter(d => dashboardUsesVariable(d));
    }
    return orderDashboardsForViewer(result, tileOrder, { key: sortKey, direction: sortDirection });
  }, [kioskIds, kioskDashboards, dashboards, variableOnly, tileOrder, sortKey, sortDirection]);

  if ((kiosk && kioskLoading) || (!kiosk && loading && !hasLoadedOnce)) {
    return (
      <div className="dashboard-tile-view-page">
        <Loading description="Loading dashboards..." withOverlay={false} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="dashboard-tile-view-page">
        <div className="error-message">Error: {error.message || String(error)}</div>
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
        {kiosk ? (
          // Kiosk mode: filters + sort are locked by the URL manifest;
          // hide the controls and surface a single badge so the user
          // knows why the picker is constrained.
          <Tag type="purple" size="md" title={`Locked to ${kioskIds.length} dashboard${kioskIds.length === 1 ? '' : 's'} via ?dashboards= URL`}>
            Kiosk mode — {kioskIds.length} dashboard{kioskIds.length === 1 ? '' : 's'}
          </Tag>
        ) : (
          <>
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
            {/* Mobile-only toggle: the filter/sort controls below collapse
                behind this so they don't push tiles off the first screen. */}
            {isMobile && (
              <Button
                className="mobile-filters-toggle"
                kind={filtersOpen ? 'secondary' : 'tertiary'}
                size="md"
                renderIcon={Filter}
                onClick={() => setFiltersOpen((v) => !v)}
              >
                Filters
              </Button>
            )}
            <div className={`header-filters${isMobile && !filtersOpen ? ' header-filters--collapsed' : ''}`}>
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
            <Dropdown
              id="connection-filter-view-dashboards"
              className="connection-filter-dropdown"
              label="Filter by connection"
              titleText=""
              items={[
                { id: 'all', text: 'All Connections' },
                ...Object.entries(connections).map(([id, name]) => ({ id, text: name }))
              ]}
              itemToString={(item) => item?.text || ''}
              selectedItem={{ id: connectionFilter, text: connectionFilter === 'all' ? 'All Connections' : (connections[connectionFilter] || 'Unknown') }}
              onChange={({ selectedItem }) => {
                setConnectionFilter(selectedItem?.id || 'all');
              }}
              size="md"
            />
            {/* Overflow (⋮) menu for facet toggles — mirrors the dashboards
                list. "Variable dashboards only". Sits BEFORE the reset button
                so reset stays the rightmost filter control. */}
            <OverflowMenu
              renderIcon={() => <OverflowMenuVertical size={20} />}
              flipped
              direction="bottom"
              align="bottom-end"
              iconDescription="Filter options"
              menuOptionsClass="filter-overflow-options"
              className={`filter-overflow-trigger${variableOnly ? ' filter-overflow-trigger--active' : ''}`}
            >
              <OverflowMenuItem
                itemText={
                  <span className="filter-overflow-item">
                    {variableOnly
                      ? <Checkmark size={16} />
                      : <span style={{ width: 16, display: 'inline-block' }} />}
                    <span>Variable dashboards only</span>
                  </span>
                }
                onClick={() => setVariableOnly((v) => !v)}
              />
            </OverflowMenu>
            <ResetFiltersButton
              active={
                !!searchTerm ||
                namespaceFilter.length > 0 ||
                tagFilter.length > 0 ||
                connectionFilter !== 'all' ||
                variableOnly
              }
              onReset={() => {
                setSearchTerm('');
                setNamespaceFilter([]);
                setTagFilter([]);
                setConnectionFilter('all');
                setVariableOnly(false);
              }}
            />
            <SortMenu
              sortKey={sortKey}
              sortDirection={sortDirection}
              onChange={(k, d) => persistSort(k, d)}
              options={[
                { key: 'manual', label: 'Manual (drag to reorder)' },
                { key: 'name', label: 'Name', defaultDir: 'asc' },
                { key: 'updated', label: 'Last modified', defaultDir: 'desc' },
                { key: 'namespace', label: 'Namespace', defaultDir: 'asc' },
              ]}
            />
            {sortKey === 'manual' && !isPaginated && tileOrder && tileOrder.length > 0 && (
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Reset}
                onClick={handleResetOrder}
                title="Discard your manual tile order and revert to most-recently-updated first"
              >
                Reset manual order
              </Button>
            )}
            </div>
          </>
        )}
      </div>

      {/* Scrollable tile region — the page itself is a fixed-height flex
          column (like DashboardsListPage) so the pagination footer stays
          pinned to the bottom of the display instead of riding at the end
          of the scrolled content. */}
      <div className="tiles-content">
      {displayDashboards.length === 0 ? (
        <div className="no-dashboards">
          {(searchTerm || namespaceFilter.length > 0 || tagFilter.length > 0 || connectionFilter !== 'all' || variableOnly) ? (
            <p>No dashboards match your filters.</p>
          ) : (
            <p>No dashboards available. Create one in Design mode.</p>
          )}
        </div>
      ) : (
        <div className="dashboard-tiles-grid">
          {displayDashboards.map((dashboard) => {
            const dropSide = dragOver?.id === dashboard.id ? dragOver.side : null;
            const isDefault = defaultDashboardId === dashboard.id;
            // Drag-reorder is only meaningful in manual sort, disabled in
            // kiosk mode (URL manifest owns the order), and disabled while
            // paginated (a drag can't move rows onto another page).
            const isManual = sortKey === 'manual' && !kiosk && !isPaginated;
            // #114: feed the tile pre-computed comps/conns from the
            // summary's denormalized {id,name} fields. Kiosk rows are full
            // docs fetched by id (no usage fields) — the chips just come up
            // empty there, which a locked kiosk picker doesn't need anyway.
            const tileComponentItems = toUsageItems(dashboard.component_usage);
            const tileConnectionItems = toUsageItems(dashboard.connection_usage);
            return (
              <DashboardTile
                key={dashboard.id}
                dashboard={dashboard}
                componentItems={tileComponentItems}
                connectionItems={tileConnectionItems}
                onClick={() => handleTileClick(dashboard.id)}
                showRefreshInterval
                descriptionMode="inline"
                className={isDefault ? 'dashboard-tile--default' : ''}
                onComponentClick={canDesign ? ((item) => navigate(`/design/components/${item.id}`)) : undefined}
                onConnectionClick={canDesign ? ((item) => navigate(`/design/connections/${item.id}`)) : undefined}
                draggable={isManual}
                onDragStart={isManual ? (e) => handleDragStart(e, dashboard.id) : undefined}
                onDragOver={isManual ? (e) => handleDragOver(e, dashboard.id) : undefined}
                onDragLeave={isManual ? handleDragLeave : undefined}
                onDrop={isManual ? (e) => handleDrop(e, dashboard.id) : undefined}
                onDragEnd={isManual ? handleDragEnd : undefined}
                dropSide={dropSide}
                actions={
                  isDefault ? (
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
                  )
                }
              />
            );
          })}
        </div>
      )}
      </div>

      {/* Server-side pagination (#114). Hidden in kiosk mode — the manifest
          is the whole set. */}
      {!kiosk && total > 0 && (
        <Pagination
          className="list-pagination list-pagination--tile"
          page={page}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          totalItems={total}
          onChange={({ page: p, pageSize: ps }) => {
            if (ps !== pageSize) setPageSize(ps);
            setPage(p);
          }}
        />
      )}
    </div>
  );
}

export default DashboardTileViewPage;
