// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem, TextInput, IconButton, Button } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';
import { TEXT_THRESHOLD_COLOR_PALETTE, TEXT_THRESHOLD_OPERATORS } from '../option-helpers';
import ColorSwatchPicker from './ColorSwatchPicker';

/**
 * Free list of TEXT threshold rules for the value chart. Each entry is
 * `{ operator: 'eq'|'contains', match: string, color: string }`.
 *
 * Unlike the numeric `threshold_list` (which describes boundaries on a
 * continuous scale and is naturally bounded), text values are discrete
 * and unbounded — a device might report a dozen distinct states — so
 * this list has NO cap. The author adds a rule per state they care about.
 *
 * Rules are evaluated TOP-DOWN and the FIRST match wins, which is what
 * lets a specific `equals` rule sit above a broad `contains` catch-all.
 * That ordering is load-bearing, so the UI states it and offers move
 * up/down controls rather than silently sorting.
 *
 * Colors come from the wider text palette (alert ramp + the chart line
 * colors) because a text state often isn't a severity at all — "Cooling"
 * or "Standby" want a distinguishable color, not a judgement.
 */
const DEFAULT_COLORS = TEXT_THRESHOLD_COLOR_PALETTE.map((c) => c.hex);

function defaultColorForIndex(i) {
  return DEFAULT_COLORS[i % DEFAULT_COLORS.length];
}

export default function TextThresholdListField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();

  const raw = Array.isArray(formState[field.id]) ? formState[field.id] : [];
  const entries = raw.map((e, i) => ({
    operator: e?.operator === 'contains' ? 'contains' : 'eq',
    match: typeof e?.match === 'string' ? e.match : '',
    color: typeof e?.color === 'string' && e.color ? e.color : defaultColorForIndex(i),
  }));

  const commit = (next) => onFieldChange(field.id, next);

  const updateEntry = (index, patch) =>
    commit(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  const removeEntry = (index) => commit(entries.filter((_, i) => i !== index));

  const addEntry = () =>
    commit([...entries, { operator: 'eq', match: '', color: defaultColorForIndex(entries.length) }]);

  // Reordering is a real operation here, not a nicety: first-match-wins
  // means the order IS the logic.
  const moveEntry = (index, delta) => {
    const target = index + delta;
    if (target < 0 || target >= entries.length) return;
    const next = [...entries];
    [next[index], next[target]] = [next[target], next[index]];
    commit(next);
  };

  return (
    <div className="spec-threshold-list spec-threshold-list--text">
      {field.helperText && (
        <div className="spec-field-helper">{field.helperText}</div>
      )}
      <div className="spec-threshold-list__rows">
        {entries.map((entry, i) => (
          <div key={i} className="spec-threshold-list__row spec-threshold-list__row--text">
            <div className="spec-threshold-list__op">
              <Select
                id={`spec-${field.id}-${i}-op`}
                labelText={i === 0 ? 'Match' : undefined}
                hideLabel={i !== 0}
                value={entry.operator}
                onChange={(e) => updateEntry(i, { operator: e.target.value })}
                size="sm"
              >
                {TEXT_THRESHOLD_OPERATORS.map((op) => (
                  <SelectItem key={op.value} value={op.value} text={op.label} />
                ))}
              </Select>
            </div>
            <div className="spec-threshold-list__match">
              <TextInput
                id={`spec-${field.id}-${i}-match`}
                labelText={i === 0 ? 'Value' : undefined}
                hideLabel={i !== 0}
                value={entry.match}
                onChange={(e) => updateEntry(i, { match: e.target.value })}
                placeholder="e.g. ONLINE"
                size="sm"
              />
            </div>
            <div className="spec-threshold-list__color">
              {i === 0 && <span className="spec-threshold-list__color-label">Color</span>}
              <ColorSwatchPicker
                idPrefix={`spec-${field.id}-${i}-color`}
                value={entry.color}
                onChange={(hex) => updateEntry(i, { color: hex })}
                palette={TEXT_THRESHOLD_COLOR_PALETTE}
                ariaLabel="Rule color"
              />
            </div>
            <div className="spec-threshold-list__reorder">
              <IconButton
                kind="ghost"
                size="sm"
                label="Move up"
                disabled={i === 0}
                onClick={() => moveEntry(i, -1)}
              >
                <span aria-hidden="true">↑</span>
              </IconButton>
              <IconButton
                kind="ghost"
                size="sm"
                label="Move down"
                disabled={i === entries.length - 1}
                onClick={() => moveEntry(i, 1)}
              >
                <span aria-hidden="true">↓</span>
              </IconButton>
            </div>
            <div className="spec-threshold-list__remove">
              <IconButton
                kind="ghost"
                size="sm"
                label="Remove rule"
                onClick={() => removeEntry(i)}
              >
                <Close />
              </IconButton>
            </div>
          </div>
        ))}
      </div>
      {entries.length > 1 && (
        <div className="spec-field-helper spec-threshold-list__order-note">
          Rules are checked top to bottom — the first one that matches sets the color.
        </div>
      )}
      <div className="spec-threshold-list__add">
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={addEntry}>
          Add rule
        </Button>
      </div>
    </div>
  );
}
