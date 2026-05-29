// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Checkbox, NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Per-end auto. Cell layout:
 *
 *   Min
 *   [NumberInput] [✓] Auto    ← side-by-side on one row
 *
 * The Auto checkbox is always visible. The NumberInput hides
 * when Auto is checked (the row becomes just the checkbox).
 *
 * Storage shape: `null | number`. Default null (auto).
 */
export default function NullableNumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const raw = formState[field.id];
  const value = raw == null ? null : Number(raw);
  const isAuto = value == null;

  const handleAutoToggle = (_e, { checked }) => {
    if (checked) {
      onFieldChange(field.id, null);
    } else {
      const fallback = field.default != null && Number.isFinite(Number(field.default))
        ? Number(field.default)
        : 0;
      onFieldChange(field.id, fallback);
    }
  };

  return (
    <div className="spec-nullable-number">
      <label className="spec-nullable-number__label" htmlFor={`spec-${field.id}`}>
        {field.label}
      </label>
      <div className="spec-nullable-number__row">
        {!isAuto && (
          <NumberInput
            id={`spec-${field.id}`}
            label=""
            hideLabel
            helperText={field.helperText}
            value={value}
            onChange={(_e, { value: next }) => onFieldChange(field.id, next == null || next === '' ? null : Number(next))}
            min={field.min ?? -1000000}
            max={field.max ?? 1000000}
            step={field.step ?? 1}
            hideSteppers
          />
        )}
        <Checkbox
          id={`spec-${field.id}-auto`}
          labelText="Auto"
          checked={isAuto}
          onChange={handleAutoToggle}
        />
      </div>
    </div>
  );
}
