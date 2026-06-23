// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function NumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? 0;

  return (
    <NumberInput
      id={`spec-${field.id}`}
      label={field.label}
      helperText={field.helperText}
      value={value}
      // allowEmpty lets the field be cleared while typing — without it Carbon
      // coerces an empty input to 0 and that 0 stays sticky, so every digit you
      // type lands behind it ("05", "015", …). Empty commits back to the field
      // default (or 0) so storage never holds a non-numeric value.
      allowEmpty
      onChange={(_e, { value: next }) =>
        onFieldChange(field.id, next === '' || next == null ? (field.default ?? 0) : next)
      }
      min={field.min ?? -1000000}
      max={field.max ?? 1000000}
      step={field.step ?? 1}
      hideSteppers
    />
  );
}
