// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import { Tag, Tooltip } from '@carbon/react';
import { Dashboard, DataBase, Information, Time, Copy } from '@carbon/icons-react';
import NamespaceChip from './shared/NamespaceChip';
import './DashboardTile.scss';

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

  // Pass-through className for extra styling at the call site.
  className = '',
}) {
  // Build the list of unique connections referenced by this dashboard's
  // component panels. Skip panels with no component_id (text panels,
  // empty placeholders) and components that point at a deleted
  // connection. Single-pass through panels for both the count and the
  // tooltip label.
  const connectionsForDashboard = (() => {
    const out = [];
    const seen = new Set();
    for (const panel of dashboard.panels || []) {
      if (!panel.component_id) continue;
      const comp = componentMap[panel.component_id];
      if (!comp?.connection_id) continue;
      const name = connectionMap[comp.connection_id];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
    }
    return out;
  })();

  // Component count: panels that actually reference a component.
  // Excludes text panels and empty placeholders. The previous tooltip
  // showed all panels including '(empty panel)' rows; the chip count
  // now reflects what's actually a component.
  const componentPanels = (dashboard.panels || []).filter(
    (p) => p.component_id,
  );
  const componentNamesLabel = (() => {
    if ((dashboard.panels || []).length === 0) return 'No panels';
    if (componentPanels.length === 0) return 'No components';
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
        {dashboard.thumbnail ? (
          <img src={dashboard.thumbnail} alt={dashboard.name} />
        ) : (
          <div className="thumbnail-placeholder">
            <Dashboard size={48} />
          </div>
        )}
      </div>

      <div className="tile-content">
        <div className="tile-header">
          <h3 className="tile-name">{dashboard.name}</h3>
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
                type="cyan"
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
            {(dashboard.panels || []).length > 0 && (
              <Tooltip
                label={componentNamesLabel}
                align="bottom"
                autoAlign
                enterDelayMs={150}
                className="tooltip-multiline"
              >
                <Tag type="gray" size="sm">
                  {componentPanels.length} comp
                  {componentPanels.length === 1 ? '' : 's'}
                </Tag>
              </Tooltip>
            )}

            {connectionsForDashboard.length > 0 && (
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
            )}
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
