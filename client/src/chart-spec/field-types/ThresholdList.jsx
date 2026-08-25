// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { NumberInput, TextInput, IconButton, Button } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';
import { ALERT_COLOR_PALETTE } from '../option-helpers';
import ColorSwatchPicker from './ColorSwatchPicker';

/**
 * Threshold band editor for the line/area/bar y_thresholds field.
 * Entries are `{ value: number, color: string, label?: string }`.
 *
 * BAND MODEL (Grafana's — see buildThresholds in specs/line.js):
 * entry 0 is the BASE. Its color paints everything below the first real
 * threshold, and its `value` is meaningless — which is why the base row
 * renders WITHOUT a value input rather than with a disabled one. An
 * editable base value is the classic source of "why doesn't the first
 * row's number do anything?", and worse, someone eventually sets it to
 * something other than the true floor and quietly breaks the band math.
 *
 * Every later entry (Vi, Ci) means "from Vi upward, use Ci" — for the
 * data line and for the boundary line drawn AT Vi.
 *
 * Rows sort by value on blur rather than offering drag-reorder: order is
 * a pure function of the numbers, so re-sorting on change handles it for
 * free and there is no way to leave the list in a contradictory order.
 *
 * Values are deliberately NOT validated against the chart's y-axis
 * domain. These components pull live data, so an axis-range check would
 * make editing depend on load order; out-of-range thresholds simply
 * render off-plot until data catches up.
 */
// New rows escalate along the alert ramp, which is the order an author
// almost always builds a band stack in: the BASE is the healthy color
// and each threshold above it is worse. Info is dropped from the default
// rotation — it sorts to the front of a plain reverse() and made the base
// blue, which reads as "informational" rather than "this is the good
// state". It stays available in the swatch picker.
const DEFAULT_COLORS = ALERT_COLOR_PALETTE
  .filter((c) => c.name !== 'Info')
  .map((c) => c.hex)
  .reverse(); // OK → Warning → Caution → Danger

function defaultColorForIndex(i) {
  return DEFAULT_COLORS[i % DEFAULT_COLORS.length];
}

export default function ThresholdListField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();

  const raw = Array.isArray(formState[field.id]) ? formState[field.id] : [];
  const entries = raw.map((e, i) => ({
    value: e && Number.isFinite(Number(e.value)) ? Number(e.value) : 0,
    color: typeof e?.color === 'string' && e.color ? e.color : defaultColorForIndex(i),
    label: typeof e?.label === 'string' ? e.label : '',
  }));

  // The base is entry 0 and never moves; only the real thresholds sort.
  const sortBoundaries = (list) => (
    list.length <= 1
      ? list
      : [list[0], ...list.slice(1).sort((a, b) => Number(a.value) - Number(b.value))]
  );

  const updateEntry = (index, patch) => {
    onFieldChange(field.id, entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  };

  // Sort on BLUR, not on every keystroke — re-ordering mid-type would
  // yank the focused input out from under the cursor.
  const commitOrder = () => {
    const sorted = sortBoundaries(entries);
    if (sorted.some((e, i) => e !== entries[i])) onFieldChange(field.id, sorted);
  };

  const removeEntry = (index) => {
    onFieldChange(field.id, entries.filter((_, i) => i !== index));
  };

  const addEntry = () => {
    // Seed above the current highest so a new row lands where the author
    // expects (at the top of the ramp) instead of colliding with the base.
    const highest = entries.slice(1).reduce((m, e) => Math.max(m, Number(e.value)), 0);
    const next = [...entries, {
      value: entries.length <= 1 ? 0 : highest + 10,
      color: defaultColorForIndex(entries.length),
      label: '',
    }];
    onFieldChange(field.id, sortBoundaries(next));
  };

  // Band preview: the same left-to-right band sequence the chart will
  // paint, driven by the same ordering rule so the two cannot disagree.
  const bands = entries.length > 0
    ? [entries[0], ...entries.slice(1)].map((e) => e.color)
    : [];

  return (
    <div className="spec-threshold-list">
      {field.helperText && (
        <div className="spec-field-helper">{field.helperText}</div>
      )}
      {/* Band preview — the colors the chart will paint, low→high,
          from the same ordering the renderer uses. */}
      {bands.length > 0 && (
        <div className="spec-threshold-list__preview" aria-hidden="true">
          {bands.map((c, i) => (
            <span key={i} className="spec-threshold-list__band" style={{ backgroundColor: c }} />
          ))}
        </div>
      )}
      <div className="spec-threshold-list__rows">
        {entries.map((entry, i) => (
          <div
            key={i}
            className={`spec-threshold-list__row${i === 0 ? ' spec-threshold-list__row--base' : ''}`}
          >
            <div className="spec-threshold-list__value-color">
              {i === 0 ? (
                /* No value input on the base: its value is meaningless
                   to the renderer, and an editable one invites someone
                   to "fix" it and break the band math. */
                <div className="spec-threshold-list__base-label">
                  <strong>Base</strong>
                  <span>Applies below the next threshold</span>
                </div>
              ) : (
                <NumberInput
                  id={`spec-${field.id}-${i}-value`}
                  label="Starts at"
                  value={entry.value}
                  allowEmpty
                  onChange={(_e, { value }) => updateEntry(i, { value: value === '' || value == null ? 0 : Number(value) })}
                  onBlur={commitOrder}
                  step={1}
                  hideSteppers
                />
              )}
              <ColorSwatchPicker
                idPrefix={`spec-${field.id}-${i}-color`}
                value={entry.color}
                onChange={(hex) => updateEntry(i, { color: hex })}
                palette={ALERT_COLOR_PALETTE}
                ariaLabel={i === 0 ? 'Base color' : 'Threshold color'}
              />
            </div>
            <div className="spec-threshold-list__label">
              <TextInput
                id={`spec-${field.id}-${i}-label`}
                labelText="Label (optional)"
                hideLabel={i !== 1}
                value={entry.label}
                onChange={(e) => updateEntry(i, { label: e.target.value })}
                placeholder={i === 0 ? 'Base has no line' : 'e.g. SLA'}
                disabled={i === 0}
              />
            </div>
            <div className="spec-threshold-list__remove">
              {/* The base is structural — removing it would leave the
                  lowest band undefined, so it has no delete control. */}
              {i > 0 && (
                <IconButton
                  kind="ghost"
                  size="sm"
                  label="Remove threshold"
                  onClick={() => removeEntry(i)}
                >
                  <Close />
                </IconButton>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="spec-threshold-list__add">
        <Button
          kind="ghost"
          size="sm"
          renderIcon={Add}
          onClick={addEntry}
        >
          Add threshold
        </Button>
      </div>
    </div>
  );
}
