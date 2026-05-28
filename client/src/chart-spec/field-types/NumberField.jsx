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
      onChange={(_e, { value: next }) => onFieldChange(field.id, next)}
      min={field.min ?? -1000000}
      max={field.max ?? 1000000}
      step={field.step ?? 1}
      hideSteppers
    />
  );
}
