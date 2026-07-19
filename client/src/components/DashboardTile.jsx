// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useEffect, useRef } from 'react';
import { Tag, Tooltip } from '@carbon/react';
import { Dashboard, DataBase, Information, Time, Copy, WarningAltFilled } from '@carbon/icons-react';
import NamespaceChip from './shared/NamespaceChip';
import VariableIndicator from './shared/VariableIndicator';
import CountListPopover from './shared/CountListPopover';
import { dashboardUsesVariable } from '../utils/dashboardVariable';
import apiClient from '../api/client';
import './DashboardTile.scss';

/**
 * Lazy-loading dashboard thumbnail (#19). The blob lives in a separate
 * collection now (not embedded in the dashboard doc) behind a
 * header-authed endpoint, so a native <img src> can't load it (it 401s —
 * browser image requests don't carry our auth headers). Instead we
 * fetch the PNG through apiClient (which attaches auth) once the tile
 * scrolls near the viewport, wrap it in an object URL, and render that.
 * No thumbnail / 404 / any error → placeholder icon. Cache-busted on the
 * dashboard's `updated` stamp so a re-capture shows through.
 */
function TileThumbnail({ dashboardId, updated, alt }) {
  const [objectUrl, setObjectUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    let createdUrl = null;
    const el = containerRef.current;
    if (!el) return undefined;

    const load = async () => {
      try {
        const blob = await apiClient.getDashboardThumbnailBlob(dashboardId, updated);
        if (cancelled) return;
        if (!blob) { setFailed(true); return; }
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    };

    // Defer the fetch until the tile is near the viewport. Falls back to
    // an immediate load when IntersectionObserver is unavailable.
    let observer = null;
    if (typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          load();
        }
      }, { rootMargin: '200px' });
      observer.observe(el);
    } else {
      load();
    }

    return () => {
      cancelled = true;
      if (observer) observer.disconnect();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [dashboardId, updated]);

  if (failed || !objectUrl) {
    return (
      <div className="thumbnail-placeholder" ref={containerRef}>
        <Dashboard size={48} />
      </div>
    );
  }
  return <img ref={containerRef} src={objectUrl} alt={alt} />;
}

/**
 * Shared dashboard tile card. Used by:
 *   - DashboardsListPage   (Design mode list, tile view)
 *   - DashboardTileViewPage (View mode dashboard grid)
 *   - DashboardPickerModal (alert-rule editor's dashboard picker)
 *
 * Slot-based composition rather than a `variant` enum: each caller
 * passes the action chrome that's specific to its site (view/edit/
 * delete buttons, drag-handle + default-star + overflow menu, or
 * nothing for picker mode). The shared body — thumbnail, name,
 * description, meta row — is identical across all sites so the polish
 * lives in one place.
 *
 * Meta-row priority (tags first, connections collapsed) reflects what
 * carries the most user-authored meaning per tile, per Tom 2026-05-20.
 */
function DashboardTile({
  // Core data
  dashboard,
  componentMap = {},   // { component_id: component }
  connectionMap = {},  // { connection_id: name }
  // #21: pre-computed { id, label } pairs from a paginated summary list
  // (dashboard has no full `panels` array there). When provided, they take
  // precedence over the panel-walk below so the navigable comps/conns pills
  // keep working without fetching every component/connection client-side.
  componentItems: componentItemsProp = null,
  connectionItems: connectionItemsProp = null,

  // Interaction
  onClick,
  onDoubleClick,
  selected = false,

  // Meta-row content toggles
  showDate = false,
  showRefreshInterval = false,

  // Description rendering: 'inline' renders a <p>; 'tooltip' renders an
  // info button with a hover tooltip; 'none' hides it entirely.
  descriptionMode = 'inline',

  // Slots — composed in by the caller. `badge` overlays the top-left of
  // the thumbnail (export checkbox, status flag); `actions` sits at the
  // right side of the footer (overflow menu, view/edit/delete buttons,
  // default-star, etc).
  badge = null,
  actions = null,

  // Drag-and-drop reorder (used by View-mode in manual sort).
  draggable = false,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  dropSide = null, // 'left' | 'right' | null

  // Optional: clicking a tag triggers a parent-supplied filter. Absent
  // means tags are display-only.
  onTagClick,

  // Optional: when provided, the comps / conns anchor pills become navigable
  // CountListPopover dropdowns — clicking the count opens a list of the
  // dashboard's components / connections, and clicking an item calls the
  // handler (callers navigate to the design editor). Absent → the pills stay
  // read-only hover Tooltips. Callers gate these (e.g. view mode passes them
  // only when the user has design privileges).
  onComponentClick,
  onConnectionClick,

  // Pass-through className for extra styling at the call site.
  className = '',
}) {
  // Build the list of unique connections referenced by this dashboard's
  // component panels. Skip panels with no component_id (text panels,
  // empty placeholders) and components that point at a deleted
  // connection. Single-pass through panels for both the count and the
  // tooltip label.
  // Distinct connections as { id, label } so the popover can navigate to each
  // connection's editor. De-duped by connection id. (connectionsForDashboard
  // keeps the name list for the read-only tooltip + the count.)
  const connectionItems = connectionItemsProp != null ? connectionItemsProp : (() => {
    const out = [];
    const seen = new Set();
    for (const panel of dashboard.panels || []) {
      if (!panel.component_id) continue;
      const comp = componentMap[panel.component_id];
      const connId = comp?.connection_id;
      if (!connId || seen.has(connId) || !connectionMap[connId]) continue;
      seen.add(connId);
      out.push({ id: connId, label: connectionMap[connId] });
    }
    return out;
  })();
  const connectionsForDashboard = connectionItems.map((c) => c.label);

  // Distinct components placed on the dashboard, as { id, label }, so the
  // popover can navigate to each component's editor. Panels pointing at a
  // deleted component are dropped (nothing to navigate to). De-duped by id.
  const componentItems = componentItemsProp != null ? componentItemsProp : (() => {
    const out = [];
    const seen = new Set();
    // A panel references its default component_id AND every component-swap
    // override (connection-alt) component. Both count so the popover/count
    // match the summary path (component_usage) and the delete-orphan scan.
    const addRef = (cid) => {
      if (!cid || seen.has(cid)) return;
      const comp = componentMap[cid];
      if (!comp) return;
      seen.add(cid);
      out.push({ id: cid, label: comp.title || comp.name || '(unnamed)' });
    };
    for (const panel of dashboard.panels || []) {
      addRef(panel.component_id);
      for (const ov of panel.component_overrides || []) {
        addRef(ov.component_id);
      }
    }
    return out;
  })();

  // Component count: panels that actually reference a component.
  // Excludes text panels and empty placeholders. The previous tooltip
  // showed all panels including '(empty panel)' rows; the chip count
  // now reflects what's actually a component.
  // Component count + tooltip. When componentItems came in pre-computed
  // (paginated summary path), derive both from it; otherwise walk panels.
  const componentCount = componentItemsProp != null
    ? componentItems.length
    : (dashboard.panels || []).filter((p) => p.component_id).length;
  const componentNamesLabel = (() => {
    if (componentItemsProp != null) {
      return componentItems.length === 0 ? 'No components' : componentItems.map((c) => c.label).join('\n');
    }
    const componentPanels = (dashboard.panels || []).filter((p) => p.component_id);
    if ((dashboard.panels || []).length === 0) return 'No panels';
    if (componentCount === 0) return 'No components';
    return componentPanels
      .map((p) => {
        const c = componentMap[p.component_id];
        if (!c) return '(missing component)';
        return c.title || c.name || '(unnamed)';
      })
      .join('\n');
  })();

  const handleTileClick = () => {
    if (onClick) onClick(dashboard);
  };

  const handleTileDoubleClick = () => {
    if (onDoubleClick) onDoubleClick(dashboard);
  };

  const handleKeyDown = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (onClick) onClick(dashboard);
  };

  const formatDate = (val) => {
    if (!val) return 'N/A';
    const d = new Date(val);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  };

  const classes = [
    'dashboard-tile',
    selected ? 'dashboard-tile--selected' : '',
    dropSide === 'left' ? 'dashboard-tile--drop-before' : '',
    dropSide === 'right' ? 'dashboard-tile--drop-after' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={classes}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={handleTileClick}
      onDoubleClick={onDoubleClick ? handleTileDoubleClick : undefined}
      onKeyDown={onClick ? handleKeyDown : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {badge !== null && <div className="tile-badge">{badge}</div>}

      <div className="tile-thumbnail">
        <TileThumbnail
          dashboardId={dashboard.id}
          updated={dashboard.updated}
          alt={dashboard.name}
        />
      </div>

      <div className="tile-content">
        <div className="tile-header">
          <div className="tile-name-row">
            <h3 className="tile-name">{dashboard.name}</h3>
            {/* #4: this dashboard references a component or connection in
                a namespace the viewer can't see. The affected panels
                render as error panels in the viewer; the badge warns
                up-front from the list. */}
            {dashboard.has_unauthorized_deps && (
              <Tooltip label="This dashboard uses a component or connection you don't have access to. Some panels will show an error." align="bottom">
                <span className="tile-unauthorized-badge" aria-label="Has unauthorized dependencies">
                  <WarningAltFilled size={16} />
                </span>
              </Tooltip>
            )}
          </div>
          <IdCopyButton id={dashboard.id} />
          {descriptionMode === 'tooltip' && dashboard.description && (
            <Tooltip label={dashboard.description} align="bottom">
              <button
                type="button"
                className="info-button"
                onClick={(e) => e.stopPropagation()}
                aria-label="Description"
              >
                <Information size={16} />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Description slot reserved as 2 lines tall even when empty so
            every tile in the grid has identical upper-section height —
            keeps the chip rows at a consistent vertical position
            regardless of whether the dashboard has a description. The
            tooltip mode (used by the Design list page) doesn't render
            description text but still reserves the space so list-mode
            tiles match the picker / view-mode tiles next to them. */}
        <p className={`tile-description ${dashboard.description ? '' : 'tile-description--empty'}`}>
          {descriptionMode === 'inline' ? (dashboard.description || '') : ''}
        </p>

        {/* Meta block wraps both chip rows as a single unit so a
            fixed gap between them is preserved regardless of how
            many tags wrap. The block as a whole is pushed to the
            bottom of the tile via margin-top:auto in SCSS, so empty
            space lives ABOVE the chips (between description and
            chips) rather than between the two chip rows. */}
        <div className="tile-meta-block">
          {/* Top meta row — descriptive chips that vary per dashboard:
              namespace, optional refresh-interval cadence, user-authored
              tags. Wraps freely. */}
          <div className="tile-tags tile-tags--descriptive">
            {dashboard.namespace && (
              <NamespaceChip name={dashboard.namespace} />
            )}
            {showRefreshInterval && dashboard.settings?.refresh_interval > 0 && (
              <Tag type="green" size="sm">
                <Time size={12} />
                {dashboard.settings.refresh_interval}s
              </Tag>
            )}
            {(dashboard.tags || []).map((t) => (
              <Tag
                key={`tag-${t}`}
                type="blue"
                size="sm"
                onClick={
                  onTagClick
                    ? (e) => {
                        e.stopPropagation();
                        onTagClick(t);
                      }
                    : undefined
                }
                title={onTagClick ? `Filter by ${t}` : undefined}
                style={onTagClick ? { cursor: 'pointer' } : undefined}
              >
                {t}
              </Tag>
            ))}
          </div>

          {/* Anchor row — comps + conns chips always live here on the
              last line of the tile so tile bottoms align across the
              grid. Action slot (view/edit/delete buttons, default-star,
              overflow menu) sits on the right side of the same row. */}
          <div className="tile-footer">
          <div className="tile-tags tile-tags--anchor">
            {/* Comps pill — navigable popover when onComponentClick is supplied
                (designers); read-only hover tooltip otherwise. */}
            {(dashboard.panels || []).length > 0 && (
              onComponentClick ? (
                <CountListPopover
                  className="tile-count-pill tile-count-pill--comp"
                  count={`${componentCount} comp${componentCount === 1 ? '' : 's'}`}
                  heading="Components"
                  items={componentItems}
                  onItemClick={(item) => onComponentClick(item)}
                  emptyLabel="No components"
                />
              ) : (
                <Tooltip
                  label={componentNamesLabel}
                  align="bottom"
                  autoAlign
                  enterDelayMs={150}
                  className="tooltip-multiline"
                >
                  <Tag type="gray" size="sm">
                    {componentCount} comp
                    {componentCount === 1 ? '' : 's'}
                  </Tag>
                </Tooltip>
              )
            )}

            {/* Conns pill — navigable popover when onConnectionClick is supplied;
                read-only hover tooltip otherwise. */}
            {connectionsForDashboard.length > 0 && (
              onConnectionClick ? (
                <CountListPopover
                  className="tile-count-pill tile-count-pill--conn"
                  count={`${connectionsForDashboard.length} conn${connectionsForDashboard.length === 1 ? '' : 's'}`}
                  heading="Connections"
                  items={connectionItems}
                  onItemClick={(item) => onConnectionClick(item)}
                  emptyLabel="No connections"
                />
              ) : (
                <Tooltip
                  label={connectionsForDashboard.join('\n')}
                  align="bottom"
                  autoAlign
                  enterDelayMs={150}
                  className="tooltip-multiline"
                >
                  <Tag type="blue" size="sm">
                    <DataBase size={12} />
                    {connectionsForDashboard.length} conn
                    {connectionsForDashboard.length === 1 ? '' : 's'}
                  </Tag>
                </Tooltip>
              )
            )}

            {/* "var" tag — marks a dashboard that defines + enables variables.
                Sits after the conn tag in the anchor row. Shared tile, so this
                renders in both design-mode (lists/tiles) and view-mode
                (sidebar/picker). Renders nothing when not variable-driven. */}
            <VariableIndicator active={dashboardUsesVariable(dashboard)} />
          </div>

            {actions !== null && <div className="tile-actions">{actions}</div>}
          </div>
        </div>

        {showDate && (
          <div className="tile-date">Updated: {formatDate(dashboard.updated)}</div>
        )}
      </div>
    </div>
  );
}

// Inline ID button — shows the dashboard's UUID in a tooltip and
// copies it to the clipboard on click. Sits in the title row of
// every DashboardTile rendering (Design list, View mode tile grid,
// picker modal) so the ID is always one hover/click away. A
// transient "Copied!" tooltip swap confirms the copy; falls back to
// document.execCommand for browsers / contexts without async
// clipboard access (insecure HTTP, older Firefox).
function IdCopyButton({ id }) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    e.preventDefault();
    copyToClipboard(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  // When `copied` is true we force the tooltip open with the "Copied!"
  // label so the click feedback is visible regardless of Carbon's
  // hover/focus state at click time. Otherwise we leave `defaultOpen`
  // unset so the tooltip behaves normally on hover/focus showing the id.
  return (
    <Tooltip
      label={copied ? 'Copied!' : id}
      align="bottom"
      {...(copied ? { open: true } : {})}
    >
      <button
        type="button"
        className="info-button id-copy-button"
        onClick={handleClick}
        aria-label="Copy dashboard ID"
      >
        <Copy size={16} />
      </button>
    </Tooltip>
  );
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return;
  }
  fallbackCopy(text);
}

function fallbackCopy(text) {
  const el = document.createElement('textarea');
  el.value = text;
  // Position off-screen so the focus shift isn't visible.
  el.style.position = 'fixed';
  el.style.top = '-1000px';
  el.style.left = '-1000px';
  document.body.appendChild(el);
  el.focus();
  el.select();
  try { document.execCommand('copy'); } catch { /* ignore */ }
  document.body.removeChild(el);
}

export default DashboardTile;
