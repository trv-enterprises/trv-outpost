// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Checkbox, NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Pattern B per-end auto: a checkbox labeled "Auto" inline with a
 * NumberInput. Auto checked → NumberInput hides, value stored as
 * null (= auto; codegen omits the corresponding min/max). Unchecked
 * → NumberInput shows with the manual value.
 *
 * Storage shape: `null | number`. Default: `null` (auto). Codegen
 * treats null as "let the axis library auto-scale" (omits the bound
 * from the ECharts axis literal).
 *
 * The layout puts the field label on its own line with the Auto
 * checkbox to the right, then the NumberInput below when manual.
 * This keeps "Decimals" reading as the field name rather than
 * "Decimals — Auto" reading as one phrase.
 */
export default function NullableNumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const raw = formState[field.id];
  const value = raw == null ? null : Number(raw);
  const isAuto = value == null;

  return (
    <div className="spec-nullable-number">
      <div className="spec-nullable-number__header">
        <label className="spec-nullable-number__label">{field.label}</label>
        <Checkbox
          id={`spec-${field.id}-auto`}
          labelText="Auto"
          checked={isAuto}
          onChange={(_e, { checked }) => {
            // Auto on → null. Auto off → fall back to the declared
            // default, or 0 if none. The user can then type their
            // actual value.
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
    </div>
  );
}
