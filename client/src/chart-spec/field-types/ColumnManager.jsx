// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Button, Checkbox, IconButton, TextInput } from '@carbon/react';
import { CaretUp, CaretDown } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * ColumnManager — dataview's bespoke editor widget. A per-column row with:
 * a visibility checkbox, reorder (↕) buttons, the column name, and an
 * optional display-name (alias) text input.
 *
 * Unlike single-value field types, this manages TWO bound values:
 *   - visible_columns (ordered whitelist; null = show all)
 *   - column_aliases  ({ col → display name })
 * It reads both from formState (keys `visible_columns` / `column_aliases`)
 * and writes via onFieldChange under those ids. (The spec field's own id,
 * `column_manager`, is just the React key — the editor's formState builder
 * + onFieldChange switch supply/consume the two underlying keys, same
 * multi-id-feeds-one-widget pattern as banded_bar's band columns.)
 *
 * Ported from the legacy `chartType === 'dataview'` editor JSX in
 * ComponentEditor.
 *
 * visible-column semantics: visible_columns = null means "show all" (the
 * default + back-compat). As soon as the user touches a checkbox it
 * switches to an explicit whitelist (an empty array = hide all).
 */
export default function ColumnManager() {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const visibleColumns = formState.visible_columns ?? null;
  const columnAliases = formState.column_aliases || {};

  if (!availableColumns || availableColumns.length === 0) {
    return (
      <p className="aliases-hint">
        Run the query to discover columns, then choose which to show, reorder them, and set display names.
      </p>
    );
  }

  const effectiveVisible = Array.isArray(visibleColumns) ? visibleColumns : availableColumns;
  const isVisible = (col) => effectiveVisible.includes(col);

  const setVisible = (next) => onFieldChange('visible_columns', next);
  const setAliases = (next) => onFieldChange('column_aliases', next);

  const toggleVisible = (col) => {
    if (isVisible(col)) {
      // Hiding: drop the column. If that empties the list, keep it as []
      // (explicit hide-all) rather than reverting to null/show-all.
      setVisible(effectiveVisible.filter((c) => c !== col));
    } else {
      // Showing: add it back, preserving availableColumns order so columns
      // render in a stable sequence regardless of click order.
      setVisible(availableColumns.filter((c) => effectiveVisible.includes(c) || c === col));
    }
  };

  const allVisible = availableColumns.every(isVisible);

  // Visible columns render in their saved order, then hidden columns at
  // the bottom. Reorder buttons only act inside the visible group.
  const visibleList = effectiveVisible.filter((c) => availableColumns.includes(c));
  const hiddenList = availableColumns.filter((c) => !visibleList.includes(c));

  const moveColumn = (col, delta) => {
    const idx = visibleList.indexOf(col);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= visibleList.length) return;
    const next = [...visibleList];
    next.splice(idx, 1);
    next.splice(target, 0, col);
    setVisible(next);
  };

  const setAlias = (col, newValue) => {
    const updated = { ...columnAliases };
    if (newValue) updated[col] = newValue;
    else delete updated[col];
    setAliases(updated);
  };

  const renderRow = (col, opts) => (
    <div key={col} className="alias-row">
      {/* First quarter: checkbox anchored left, reorder arrows centered
          in the remaining space. Grouped so the column name stays one
          cell over, not pushed away by the arrows. */}
      <div className="alias-row__controls">
        <Checkbox
          id={`visible-${col}`}
          labelText=""
          checked={isVisible(col)}
          onChange={() => toggleVisible(col)}
        />
        <div className="alias-row__reorder" style={{ visibility: opts.canReorder ? 'visible' : 'hidden' }}>
          <IconButton kind="ghost" size="sm" label="Move up" onClick={() => moveColumn(col, -1)} disabled={!opts.canMoveUp}>
            <CaretUp size={14} />
          </IconButton>
          <IconButton kind="ghost" size="sm" label="Move down" onClick={() => moveColumn(col, 1)} disabled={!opts.canMoveDown}>
            <CaretDown size={14} />
          </IconButton>
        </div>
      </div>
      <span className="column-name" title={col}>{col}</span>
      <TextInput
        id={`alias-${col}`}
        labelText=""
        placeholder="rename"
        value={columnAliases[col] || ''}
        onChange={(e) => setAlias(col, e.target.value)}
        size="sm"
        disabled={!isVisible(col)}
      />
    </div>
  );

  return (
    <div className="column-aliases-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h5 style={{ margin: 0 }}>Columns</h5>
        <Button kind="ghost" size="sm" onClick={() => setVisible(allVisible ? [] : null)}>
          {allVisible ? 'Hide all' : 'Show all'}
        </Button>
      </div>
      <p className="aliases-hint">
        Check to include the column. Use the ↕ arrows to reorder and set an optional display name. Column widths auto-size to fit the data; drag the header in the live table to override.
      </p>
      <div className="aliases-grid">
        {visibleList.map((col, i) => renderRow(col, {
          canReorder: true,
          canMoveUp: i > 0,
          canMoveDown: i < visibleList.length - 1,
        }))}
        {hiddenList.map((col) => renderRow(col, { canReorder: false, canMoveUp: false, canMoveDown: false }))}
      </div>
    </div>
  );
}
