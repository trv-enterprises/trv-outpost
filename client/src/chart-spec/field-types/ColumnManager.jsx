// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button, Toggle, Tag } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';
import DataViewGrid from '../views/DataViewGrid';
import ColumnOptionsModal from './ColumnOptionsModal';

// Per-column value formats — the number tile's vocabulary (number-formats.js)
// plus its date/time presets (the same variations the chart x-axis offers).
// The date/time entries treat the value as a TIMESTAMP; the duration entries
// treat it as elapsed SECONDS — duration_clock's label spells that out
// because "HH:MM:SS" alone read as time-of-day and rendered an epoch
// timestamp as ~211221 hours.
const COLUMN_FORMATS = [
  { value: 'auto', label: 'Auto' },
  { value: 'compact', label: 'Compact (SI — 127G)' },
  { value: 'plain', label: 'Plain number' },
  { value: 'duration', label: 'Duration in seconds (2d 3h)' },
  { value: 'duration_clock', label: 'Duration in seconds (total HH:MM:SS)' },
  { value: 'time', label: 'Time (10:30 AM)' },
  { value: 'time_seconds', label: 'Time + seconds (10:30:05 AM)' },
  { value: 'date', label: 'Date (Jan 15)' },
  { value: 'datetime', label: 'Date + time (Jan 15, 10:30 AM)' },
  { value: 'datetime_seconds', label: 'Date + time + seconds (Jan 15, 10:30:05 AM)' },
];

/**
 * ColumnManager — dataview's bespoke editor widget: a VISUAL COLUMN
 * FORMATTER built on the real table (#214).
 *
 * The author sees the actual AG Grid they're configuring, with their own
 * data in it, and manipulates the layout directly: drag a column edge to
 * set its width, drag a header to reorder, click ✕ to hide. Everything
 * spatial is a gesture on the table itself. Per-column configuration that
 * isn't spatial — display name, value format, exact pixel width,
 * conditional-format rules — opens from the header's ⚙ button
 * (ColumnOptionsModal).
 *
 * This replaced a list of per-column rows carrying a "Width (px)"
 * NumberInput: the author typed a pixel count blind, saved, and switched
 * to preview to find out what it looked like. The number is still
 * reachable in the modal for the cases a drag can't serve (an exact
 * value, matching a width across two tables), but it is no longer the
 * only way in.
 *
 * WIDTH PRECEDENCE — the load-bearing part. The viewer-facing rule is
 * "viewer drag > author width > autosize", with `widthBase` recording
 * which author width a viewer's drag was made against so a later author
 * re-pin invalidates the stale override. An editor drag therefore writes
 * the AUTHOR layer (column_widths) and must never be captured as a user
 * override — otherwise the author's own drag becomes its own widthBase
 * and their next change looks stale. DataViewGrid's `editable` prop is
 * what routes the two apart; see the comments on handleColumnResized.
 *
 * It manages several bound values, not one:
 *   - visible_columns (ordered whitelist; null = show all)
 *   - column_aliases  ({ col → display name })
 *   - column_widths   ({ col → px })
 *   - column_formats  ({ col → format id })
 *   - column_rules    ({ col → rule[] })
 * It reads them from formState and writes via onFieldChange under those
 * ids. (The spec field's own id, `column_manager`, is just the React key
 * — the editor's formState builder + onFieldChange switch supply and
 * consume the underlying keys, the same multi-id-feeds-one-widget
 * pattern as banded_bar's band columns.)
 */
export default function ColumnManager() {
  const { availableColumns, formState, onFieldChange, previewData } = useSpecRenderContext();
  const visibleColumns = formState.visible_columns ?? null;
  const columnAliases = formState.column_aliases || {};
  const columnWidths = formState.column_widths || {};
  const columnFormats = formState.column_formats || {};
  const columnRules = formState.column_rules || {};

  // Which column's options modal is open (null = none).
  const [editingColumn, setEditingColumn] = useState(null);
  // Reveal hidden columns IN THE TABLE. Off by default and that's the
  // point: the author hides columns to get them out of the way, and
  // sizing the remaining ones against a table still full of noise defeats
  // the purpose. On, hidden columns come back greyed so they can be
  // un-hidden without leaving the table.
  const [showHidden, setShowHidden] = useState(false);

  const effectiveVisible = Array.isArray(visibleColumns)
    ? visibleColumns.filter((c) => availableColumns.includes(c))
    : (availableColumns || []);
  const isVisible = useCallback(
    (col) => (Array.isArray(visibleColumns) ? visibleColumns.includes(col) : true),
    [visibleColumns]
  );

  const setVisible = (next) => onFieldChange('visible_columns', next);

  // Hidden columns, in discovered-schema order — the tray below the table.
  const hiddenColumns = (availableColumns || []).filter((c) => !isVisible(c));

  // Columns the grid renders. With Show hidden on, hidden columns are
  // appended after the visible ones rather than restored to their schema
  // slots: they have no table position (that's what hidden means), and
  // interleaving them would shuffle the visible layout the author is
  // actively sizing.
  const gridColumns = showHidden
    ? [...effectiveVisible, ...hiddenColumns]
    : effectiveVisible;

  const hide = (col) => {
    // Hiding switches null ("show all") into an explicit whitelist. An
    // empty array is a real value — explicit hide-all — not a reversion
    // to show-all.
    setVisible(effectiveVisible.filter((c) => c !== col));
  };

  const show = (col) => {
    if (isVisible(col)) return;
    setVisible([...effectiveVisible, col]);
  };

  const setWidth = (col, raw) => {
    const updated = { ...columnWidths };
    const n = Number(raw);
    // Blank / 0 / non-numeric = auto: drop the key rather than store 0.
    if (raw === '' || raw == null || !Number.isFinite(n) || n <= 0) delete updated[col];
    else updated[col] = n;
    onFieldChange('column_widths', updated);
  };

  // A drag on the grid's column edge — the primary width gesture. Writes
  // the AUTHOR layer (see the precedence note in the docblock).
  const handleAuthorWidthChange = useCallback((col, px) => {
    const updated = { ...(formState.column_widths || {}) };
    updated[col] = px;
    onFieldChange('column_widths', updated);
  }, [formState.column_widths, onFieldChange]);

  // A header drag — reorder. Writes visible_columns, which IS the table
  // order. Hidden columns are filtered back out: with Show hidden on they
  // appear in the grid, so the id list AG Grid hands back includes them,
  // and letting them into visible_columns would silently un-hide them.
  const handleAuthorOrderChange = useCallback((ids) => {
    const next = ids.filter((c) => isVisible(c));
    onFieldChange('visible_columns', next);
  }, [isVisible, onFieldChange]);

  // Clear a column's width back to content-autosize.
  const autoSize = (col) => setWidth(col, '');

  const clearAllWidths = () => onFieldChange('column_widths', {});

  const patchColumn = (col, patch) => {
    if ('alias' in patch) {
      const updated = { ...columnAliases };
      if (patch.alias) updated[col] = patch.alias;
      else delete updated[col];
      onFieldChange('column_aliases', updated);
    }
    if ('format' in patch) {
      const updated = { ...columnFormats };
      if (!patch.format || patch.format === 'auto') delete updated[col];
      else updated[col] = patch.format;
      onFieldChange('column_formats', updated);
    }
    if ('width' in patch) setWidth(col, patch.width);
    if ('rules' in patch) {
      const updated = { ...columnRules };
      if (Array.isArray(patch.rules) && patch.rules.length > 0) updated[col] = patch.rules;
      else delete updated[col];
      onFieldChange('column_rules', updated);
    }
  };

  // The grid needs a { columns, rows } shape. previewData already has it;
  // restrict the columns to what we're showing so the grid doesn't build
  // defs for columns the author has hidden.
  const gridDataCtx = useMemo(() => {
    if (!previewData?.columns) return { data: null, loading: false, error: null };
    return {
      data: { columns: previewData.columns, rows: previewData.rows || [] },
      loading: false,
      error: null,
    };
  }, [previewData]);

  if (!availableColumns || availableColumns.length === 0) {
    return (
      <p className="aliases-hint">
        Run the query to discover columns, then choose which to show, reorder them, and set display names.
      </p>
    );
  }

  const hasData = !!previewData?.rows?.length;

  return (
    <div className="column-formatter">
      <div className="column-formatter__bar">
        <h5 className="column-formatter__heading">Columns</h5>
        <div className="column-formatter__bar-actions">
          {hiddenColumns.length > 0 && (
            <Toggle
              id="column-formatter-show-hidden"
              size="sm"
              labelText=""
              labelA="Show hidden"
              labelB="Show hidden"
              toggled={showHidden}
              onToggle={setShowHidden}
            />
          )}
          <Button kind="ghost" size="sm" onClick={clearAllWidths}>
            Auto-size all
          </Button>
        </div>
      </div>

      <p className="aliases-hint">
        Drag a column edge to set its width, drag a header to reorder, and use each header&rsquo;s
        controls to hide it or open its options (display name, value format, conditional
        formatting). Widths set here are the chart default — a viewer can still drag the header
        in the live table to override them for their own session.
      </p>

      {hasData ? (
        <div className="column-formatter__grid">
          <DataViewGrid
            key={gridColumns.join('|')}
            columnAliases={columnAliases}
            columnWidths={columnWidths}
            columnFormats={columnFormats}
            columnRules={columnRules}
            visibleColumnsConfig={gridColumns}
            config={{ id: '', options: { showTitle: false } }}
            dataCtx={gridDataCtx}
            editable
            editorHiddenColumns={showHidden ? hiddenColumns : []}
            onAuthorWidthChange={handleAuthorWidthChange}
            onAuthorOrderChange={handleAuthorOrderChange}
            onEditColumn={setEditingColumn}
            onHideColumn={hide}
            onShowColumn={show}
            onAutoSizeColumn={autoSize}
          />
        </div>
      ) : (
        // Columns are known (the schema came back) but there are no rows to
        // render. Sizing against an empty table would be guesswork, so say
        // so rather than showing an empty grid that looks broken.
        <p className="aliases-hint column-formatter__nodata">
          Run the query to load rows — the table below sizes against your real data.
        </p>
      )}

      {/* Hidden-column tray. Always listed even when Show hidden is off:
          otherwise a hidden column is invisible in BOTH places and the
          author has no way to discover it, which is the bug this whole
          section exists to avoid. */}
      {hiddenColumns.length > 0 && (
        <div className="column-formatter__hidden">
          <span className="column-formatter__hidden-label">
            Hidden ({hiddenColumns.length}):
          </span>
          {hiddenColumns.map((col) => (
            <Tag
              key={col}
              type="gray"
              size="sm"
              filter
              onClose={() => show(col)}
              title="Show this column"
            >
              {col}
            </Tag>
          ))}
        </div>
      )}

      {/* PORTALED to <body>, like every other nested modal the editor opens
          (connection picker, chart-type picker, value pickers). When the
          editor itself is inside ComponentEditorModal — the "Edit Chart"
          dialog reached from a dashboard — an inline modal renders INSIDE
          that outer modal's container and inherits its box: it was pushed
          off-center and spilled past the right edge of the screen. Portaling
          escapes to the top level, where the 40% width and centering apply
          against the viewport as intended.

          The outer modal already lists `.cds--modal` in
          selectorsFloatingMenus, so its focus trap leaves portaled modals'
          inputs alone (see the note in ComponentEditorModal). */}
      {editingColumn && createPortal(
        <ColumnOptionsModal
          column={editingColumn}
          alias={columnAliases[editingColumn] || ''}
          format={columnFormats[editingColumn] || 'auto'}
          width={columnWidths[editingColumn] ?? ''}
          rules={columnRules[editingColumn] || []}
          formats={COLUMN_FORMATS}
          onChange={(patch) => patchColumn(editingColumn, patch)}
          onClose={() => setEditingColumn(null)}
        />,
        document.body
      )}
    </div>
  );
}
