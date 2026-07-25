// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState } from 'react';
import { Button, Checkbox, IconButton, NumberInput, Select, SelectItem, TextInput } from '@carbon/react';
import { CaretUp, CaretDown } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';

// Per-column value formats — the number tile's vocabulary (number-formats.js),
// minus its date/time preset (timestamp columns already auto-format).
const COLUMN_FORMATS = [
  { value: 'auto', label: 'Auto' },
  { value: 'compact', label: 'Compact (SI — 127G)' },
  { value: 'duration', label: 'Duration (2d 3h)' },
  { value: 'duration_clock', label: 'Duration (HH:MM:SS)' },
  { value: 'plain', label: 'Plain number' },
];

// Editor row order at first sight of the columns: hidden columns anchored at
// their discovered-schema slots, visible columns filling the remaining slots
// in table (visible_columns) order — so a saved custom order is what the
// author sees when the editor opens.
const slotMerge = (available, visible) => {
  const visInAvail = visible.filter((c) => available.includes(c));
  const visSet = new Set(visInAvail);
  let vi = 0;
  return available.map((c) => (visSet.has(c) ? visInAvail[vi++] : c));
};

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
  // Author-set per-column pixel widths ({ col → px }). Blank = auto. These are
  // the chart default; a viewer's live drag-resize still overrides per-user.
  const columnWidths = formState.column_widths || {};
  // Author-set per-column value formats ({ col → format id }). Missing =
  // 'auto' (default cell formatting).
  const columnFormats = formState.column_formats || {};

  const effectiveVisible = Array.isArray(visibleColumns)
    ? visibleColumns
    : (availableColumns || []);
  const isVisible = (col) => effectiveVisible.includes(col);

  // Editor row order — the ONE thing that decides where a row renders, and
  // ONLY the reorder arrows mutate it (each press swaps the two affected
  // rows on screen). Visibility toggles never move a row: the old
  // visible-then-hidden re-sort yanked rows under the cursor on uncheck
  // (click-stealing), and the fix for THAT froze rows entirely — so arrow
  // presses reordered the real table invisibly while the arrows' disabled
  // states tracked a position the editor didn't show. Row order is frozen
  // from the saved order when columns first appear (render-phase lazy init,
  // the React "adjust state during render" pattern), then reconciled only
  // when the discovered column set itself changes.
  const [rowOrder, setRowOrder] = useState([]);
  if (availableColumns?.length) {
    if (rowOrder.length === 0) {
      setRowOrder(slotMerge(availableColumns, effectiveVisible));
    } else {
      const kept = rowOrder.filter((c) => availableColumns.includes(c));
      const added = availableColumns.filter((c) => !kept.includes(c));
      if (kept.length !== rowOrder.length || added.length > 0) {
        setRowOrder([...kept, ...added]);
      }
    }
  }

  if (!availableColumns || availableColumns.length === 0) {
    return (
      <p className="aliases-hint">
        Run the query to discover columns, then choose which to show, reorder them, and set display names.
      </p>
    );
  }

  const setVisible = (next) => onFieldChange('visible_columns', next);
  const setAliases = (next) => onFieldChange('column_aliases', next);
  const setWidths = (next) => onFieldChange('column_widths', next);
  const setFormats = (next) => onFieldChange('column_formats', next);

  const displayOrder = rowOrder.length ? rowOrder : availableColumns;

  const toggleVisible = (col) => {
    if (isVisible(col)) {
      // Hiding: drop the column. If that empties the list, keep it as []
      // (explicit hide-all) rather than reverting to null/show-all.
      setVisible(effectiveVisible.filter((c) => c !== col));
    } else {
      // Showing: insert at the column's ON-SCREEN position among the visible
      // rows, so the table order matches what the editor shows. (The old
      // rebuild-from-availableColumns reset the author's entire custom order
      // every time a hidden column was re-checked.)
      const before = displayOrder
        .slice(0, displayOrder.indexOf(col))
        .filter((c) => effectiveVisible.includes(c)).length;
      const next = effectiveVisible.filter((c) => availableColumns.includes(c));
      next.splice(before, 0, col);
      setVisible(next);
    }
  };

  const allVisible = availableColumns.every(isVisible);

  const visibleList = effectiveVisible.filter((c) => availableColumns.includes(c));

  const moveColumn = (col, delta) => {
    // Reorder only acts within the visible group (hidden columns have no
    // table position). Swaps the column with its visible neighbor in BOTH
    // visible_columns (the table order) and rowOrder (the editor rows) —
    // on screen the two rows trade places, hopping over any hidden rows
    // that sit between them.
    const idx = visibleList.indexOf(col);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= visibleList.length) return;
    const neighbor = visibleList[target];
    const next = [...visibleList];
    next[idx] = neighbor;
    next[target] = col;
    setVisible(next);
    setRowOrder((prev) => {
      const a = prev.indexOf(col);
      const b = prev.indexOf(neighbor);
      if (a < 0 || b < 0) return prev;
      const swapped = [...prev];
      swapped[a] = neighbor;
      swapped[b] = col;
      return swapped;
    });
  };

  const setAlias = (col, newValue) => {
    const updated = { ...columnAliases };
    if (newValue) updated[col] = newValue;
    else delete updated[col];
    setAliases(updated);
  };

  const setWidth = (col, raw) => {
    const updated = { ...columnWidths };
    const n = Number(raw);
    // Blank / 0 / non-numeric = auto: drop the key rather than store 0.
    if (raw === '' || raw == null || !Number.isFinite(n) || n <= 0) delete updated[col];
    else updated[col] = n;
    setWidths(updated);
  };

  const setFormat = (col, fmt) => {
    const updated = { ...columnFormats };
    // 'auto' is the default — drop the key rather than store it.
    if (!fmt || fmt === 'auto') delete updated[col];
    else updated[col] = fmt;
    setFormats(updated);
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
      <NumberInput
        id={`width-${col}`}
        label=""
        hideLabel
        className="column-width-input"
        placeholder="auto"
        value={columnWidths[col] ?? ''}
        allowEmpty
        min={1}
        max={2000}
        step={10}
        hideSteppers
        onChange={(_e, { value }) => setWidth(col, value)}
        size="sm"
        disabled={!isVisible(col)}
      />
      <Select
        id={`format-${col}`}
        labelText=""
        hideLabel
        size="sm"
        className="column-format-select"
        value={columnFormats[col] || 'auto'}
        onChange={(e) => setFormat(col, e.target.value)}
        disabled={!isVisible(col)}
      >
        {COLUMN_FORMATS.map((f) => (
          <SelectItem key={f.value} value={f.value} text={f.label} />
        ))}
      </Select>
    </div>
  );

  return (
    <div className="column-aliases-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h5 style={{ margin: 0 }}>Columns</h5>
        {/* Show all adopts the current ON-SCREEN order as the explicit table
            order (not null/schema order) — rows never move, and the table
            keeps matching the editor. Hide all keeps rows put too ([]). */}
        <Button kind="ghost" size="sm" onClick={() => setVisible(allVisible ? [] : [...displayOrder])}>
          {allVisible ? 'Hide all' : 'Show all'}
        </Button>
      </div>
      <p className="aliases-hint">
        Check to include the column. Use the ↕ arrows to reorder, set an optional display name, a fixed pixel width (blank = auto-size to fit), and a value format (e.g. Compact turns 136365211648 into 127.0G). A viewer can still drag the header in the live table to override the width for their own session.
      </p>
      <div className="aliases-grid">
        {/* Header row — aligned to the same grid as each column row so the
            three data fields are labelled once. The first cell hints at the
            reorder (↕) control that sits under it; the rest label the data
            fields. Without it the "rename" and "auto" placeholders don't say
            what they are once a value is typed. */}
        <div className="aliases-grid__header" aria-hidden="true">
          {/* First cell sits over the checkbox — no label. The Column header
              carries a parenthetical reorder hint, since the ↕ arrows render
              alongside the column name. */}
          <span />
          <span className="aliases-grid__header-column">
            Column
            <span className="aliases-grid__header-reorder">
              (
              <CaretUp size={10} />
              <CaretDown size={10} />
              )
            </span>
          </span>
          <span>Display name</span>
          <span>Width (px)</span>
          <span>Format</span>
        </div>
        {/* One stable list — rows never relocate on a visibility toggle. A
            column's reorder arrows are active only while it's visible (hidden
            columns have no table position); position is its index within the
            visible group. */}
        {displayOrder.map((col) => {
          const vIdx = visibleList.indexOf(col);
          const isVis = vIdx >= 0;
          return renderRow(col, {
            canReorder: isVis,
            canMoveUp: isVis && vIdx > 0,
            canMoveDown: isVis && vIdx < visibleList.length - 1,
          });
        })}
      </div>
    </div>
  );
}
