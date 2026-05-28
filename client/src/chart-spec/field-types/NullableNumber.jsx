// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Checkbox, NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Pattern B per-end auto: an "Auto" checkbox sits on the input row,
 * not the label row. The field label is on its own line at the top
 * (matching the position Carbon labelText uses for plain NumberInput
 * + Select fields). Below: input + Auto checkbox side-by-side.
 * When Auto is checked the input hides; the checkbox stays so the
 * user can toggle back. Storage shape: `null | number`. Default null.
 */
export default function NullableNumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const raw = formState[field.id];
  const value = raw == null ? null : Number(raw);
  const isAuto = value == null;

  return (
    <div className="spec-nullable-number">
      <label className="spec-nullable-number__label">{field.label}</label>
      <div className="spec-nullable-number__input-row">
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
            size="sm"
          />
        )}
        <Checkbox
          id={`spec-${field.id}-auto`}
          labelText="Auto"
          checked={isAuto}
          onChange={(_e, { checked }) => {
            if (checked) {
              onFieldChange(field.id, null);
            } else {
              const fallback = field.default != null && Number.isFinite(Number(field.default))
                ? Number(field.default)
                : 0;
              onFieldChange(field.id, fallback);
            }
          }}
        />
      </div>
    </div>
  );
}
