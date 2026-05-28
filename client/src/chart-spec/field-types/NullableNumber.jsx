// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Checkbox, NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Pattern B per-end auto: a checkbox labeled "Auto" inline with a
 * NumberInput. Checked → NumberInput hides/disables, value stored as
 * null (= auto, codegen omits the corresponding min/max from the
 * ECharts axis literal). Unchecked → NumberInput shows, value stored
 * as the entered number.
 *
 * Storage shape: `null | number`. Default: `null` (auto). Caller's
 * codegen reads `null` as "let the axis library auto-scale."
 */
export default function NullableNumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const raw = formState[field.id];
  const value = raw == null ? null : Number(raw);
  const isAuto = value == null;

  return (
    <div className="spec-nullable-number">
      <Checkbox
        id={`spec-${field.id}-auto`}
        labelText={`${field.label} — Auto`}
        checked={isAuto}
        onChange={(_e, { checked }) => {
          // Toggling Auto on → null. Toggling off → fall back to the
          // field's declared default, or 0 if none. The user can then
          // type their actual value.
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
    </div>
  );
}
