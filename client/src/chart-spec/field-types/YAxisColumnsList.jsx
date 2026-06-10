// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem, TextInput, Checkbox, IconButton, Button } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';
import ColorSwatchPicker from '../../components/shared/ColorSwatchPicker';

/**
 * Free list of Y-axis column entries. Each entry is
 * `{ column: string, label: string, stack: boolean, axis?: 'left' | 'right' }`.
 *
 * Per-row label is the user-facing series name (shows in the legend,
 * tooltip series prefix). Empty falls back to the column name.
 *
 * Mode controlled by a sibling `multipleYAxis` boolean field in the
 * same spec — its current value is read from formState and gates:
 *   - per-row Axis selector visibility (only when on)
 *   - the "+ Add column" cap (off → unlimited; on → max 2)
 *
 * Stack groups: per-column `stack` boolean. Columns with `stack:true`
 * share one internal stack group name at codegen time.
 *
 * Defaults applied when adding a column:
 *   - column: '' (user must pick)
 *   - label: ''
 *   - stack: false
 *   - axis: in dual-axis mode, first added = 'left', second = 'right'
 *
 * The ✕ remove button is disabled when only one row remains.
 *
 * Field-spec extensions used by this renderer:
 *   - field.modeFieldId: id of the sibling multipleYAxis boolean
 *     field. Defaults to "multipleYAxis" when omitted.
 *   - field.maxInDualAxis: cap when dual mode is on. Defaults to 2.
 */
export default function YAxisColumnsListField({ field }) {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const modeFieldId = field.modeFieldId || 'multipleYAxis';
  const maxInDualAxis = field.maxInDualAxis ?? 2;
  const isDualAxis = Boolean(formState[modeFieldId]);
  // Per-series color is meaningless for a PIVOT (the series are determined at
  // runtime by the pivot column's distinct values) — so hide the picker when a
  // pivot/series column is set; those charts use the automatic palette.
  const isPivot = Boolean(formState.series_column);

  const raw = Array.isArray(formState[field.id]) ? formState[field.id] : [];
  // Normalize legacy/loose shapes. A bare string (legacy y_axis: ['a','b'])
  // becomes a default entry; partial objects fill in defaults too.
  const entries = raw.map((e) => {
    if (typeof e === 'string') return { column: e, label: '', stack: false, axis: 'left', color: '' };
    if (!e || typeof e !== 'object') return { column: '', label: '', stack: false, axis: 'left', color: '' };
    return {
      column: typeof e.column === 'string' ? e.column : '',
      label: typeof e.label === 'string' ? e.label : '',
      stack: Boolean(e.stack),
      axis: e.axis === 'right' ? 'right' : 'left',
      color: typeof e.color === 'string' ? e.color : '',
    };
  });

  const updateEntry = (index, patch) => {
    const next = entries.map((e, i) => (i === index ? { ...e, ...patch } : e));
    onFieldChange(field.id, next);
  };

  const removeEntry = (index) => {
    if (entries.length <= 1) return;
    onFieldChange(field.id, entries.filter((_, i) => i !== index));
  };

  const addEntry = () => {
    const nextAxis = isDualAxis && entries.length === 1 ? 'right' : 'left';
    const next = [...entries, { column: '', label: '', stack: false, axis: nextAxis, color: '' }];
    onFieldChange(field.id, next);
  };

  const atCap = isDualAxis && entries.length >= maxInDualAxis;

  return (
    <div className={`spec-y-axis-columns-list ${isDualAxis ? 'spec-y-axis-columns-list--dual' : ''}`}>
      {field.helperText && (
        <div className="spec-field-helper">{field.helperText}</div>
      )}
      <div className="spec-yacl__rows">
        {entries.map((entry, i) => {
          // Inject the saved column as an option when availableColumns
          // is still empty (editing a chart before re-running the
          // query), so the configured selection shows instead of going
          // blank. Once a fetch repopulates the list the duplicate
          // collapses naturally.
          const colOptions = entry.column && !availableColumns.includes(entry.column)
            ? [entry.column, ...availableColumns]
            : availableColumns;
          return (
          <div key={i} className="spec-yacl__row">
            <div className="spec-yacl__column">
              <Select
                id={`spec-${field.id}-${i}-column`}
                labelText={i === 0 ? 'Column' : undefined}
                hideLabel={i !== 0}
                value={entry.column}
                onChange={(e) => updateEntry(i, { column: e.target.value })}
              >
                <SelectItem value="" text="Select a column" />
                {colOptions.map((col) => (
                  <SelectItem key={col} value={col} text={col} />
                ))}
              </Select>
            </div>
            <div className="spec-yacl__label">
              <TextInput
                id={`spec-${field.id}-${i}-label`}
                labelText={i === 0 ? 'Column name' : undefined}
                hideLabel={i !== 0}
                value={entry.label}
                onChange={(e) => updateEntry(i, { label: e.target.value })}
                placeholder={entry.column || 'Series name in legend'}
              />
            </div>
            {isDualAxis && (
              <div className="spec-yacl__axis">
                <Select
                  id={`spec-${field.id}-${i}-axis`}
                  labelText={i === 0 ? 'Axis' : undefined}
                  hideLabel={i !== 0}
                  value={entry.axis}
                  onChange={(e) => updateEntry(i, { axis: e.target.value })}
                >
                  <SelectItem value="left" text="Left" />
                  <SelectItem value="right" text="Right" />
                </Select>
              </div>
            )}
            {/* In-stack only applies in single-axis mode. Dual-axis
                series live on different scales, so summing them via
                a stack group doesn't produce meaningful values. */}
            {!isDualAxis && (
              <div className="spec-yacl__stack">
                <Checkbox
                  id={`spec-${field.id}-${i}-stack`}
                  labelText="In stack"
                  checked={entry.stack}
                  onChange={(_e, { checked }) => updateEntry(i, { stack: checked })}
                />
              </div>
            )}
            {/* Per-series color override. Hidden for pivots (runtime series). */}
            {!isPivot && (
              <div className="spec-yacl__color">
                {i === 0 && <span className="spec-yacl__color-label">Color</span>}
                <ColorSwatchPicker
                  value={entry.color}
                  onChange={(hex) => updateEntry(i, { color: hex })}
                  label={`${entry.column || 'Series'} color`}
                />
              </div>
            )}
            <div className="spec-yacl__remove">
              <IconButton
                kind="ghost"
                size="sm"
                label="Remove column"
                onClick={() => removeEntry(i)}
                disabled={entries.length <= 1}
              >
                <Close />
              </IconButton>
            </div>
          </div>
          );
        })}
      </div>
      <div className="spec-yacl__add">
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          onClick={addEntry}
          disabled={atCap}
        >
          Add column
        </Button>
        {atCap && (
          <span className="spec-yacl__cap-hint">
            Up to {maxInDualAxis} columns in dual-axis mode
          </span>
        )}
      </div>
    </div>
  );
}
