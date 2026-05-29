// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { NumberInput, TextInput, IconButton, Button } from '@carbon/react';
import { Add, Close } from '@carbon/icons-react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Free list of threshold entries for the line chart's y_thresholds
 * field. Each entry is `{ value: number, color: string, label?: string }`.
 *
 * The render mode (line / color_segments / both) lives in a sibling
 * enum field on the same spec — this renderer just owns the data,
 * not the rendering choice.
 *
 * Defaults applied when adding a threshold:
 *   - value: 0
 *   - color: rotates through a small Carbon palette so consecutive
 *     adds aren't all the same color
 *   - label: ''
 */
const DEFAULT_COLORS = ['#24a148', '#f1c21b', '#da1e28', '#0f62fe', '#8a3ffc'];

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

  const updateEntry = (index, patch) => {
    const next = entries.map((e, i) => (i === index ? { ...e, ...patch } : e));
    onFieldChange(field.id, next);
  };

  const removeEntry = (index) => {
    onFieldChange(field.id, entries.filter((_, i) => i !== index));
  };

  const addEntry = () => {
    const next = [...entries, { value: 0, color: defaultColorForIndex(entries.length), label: '' }];
    onFieldChange(field.id, next);
  };

  return (
    <div className="spec-threshold-list">
      {field.helperText && (
        <div className="spec-field-helper">{field.helperText}</div>
      )}
      <div className="spec-threshold-list__rows">
        {entries.map((entry, i) => (
          <div key={i} className="spec-threshold-list__row">
            {/* Value + color in the first 1/4 cell: the swatch sits
                inline with the numeric value so they read as one
                composite "what threshold at what color" control. */}
            <div className="spec-threshold-list__value-color">
              <NumberInput
                id={`spec-${field.id}-${i}-value`}
                label={i === 0 ? 'Value' : undefined}
                hideLabel={i !== 0}
                value={entry.value}
                onChange={(_e, { value }) => updateEntry(i, { value: Number(value) })}
                step={1}
                hideSteppers
              />
              <input
                id={`spec-${field.id}-${i}-color`}
                className="spec-threshold-list__swatch"
                type="color"
                value={entry.color}
                onChange={(e) => updateEntry(i, { color: e.target.value })}
                aria-label="Threshold color"
              />
            </div>
            <div className="spec-threshold-list__label">
              <TextInput
                id={`spec-${field.id}-${i}-label`}
                labelText={i === 0 ? 'Label (optional)' : undefined}
                hideLabel={i !== 0}
                value={entry.label}
                onChange={(e) => updateEntry(i, { label: e.target.value })}
                placeholder="e.g. SLA"
              />
            </div>
            <div className="spec-threshold-list__remove">
              <IconButton
                kind="ghost"
                size="sm"
                label="Remove threshold"
                onClick={() => removeEntry(i)}
              >
                <Close />
              </IconButton>
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
