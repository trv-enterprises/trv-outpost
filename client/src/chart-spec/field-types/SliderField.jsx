// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Slider } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function SliderField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? field.min ?? 0;

  return (
    <Slider
      id={`spec-${field.id}`}
      labelText={field.label}
      value={value}
      onChange={({ value: next }) => onFieldChange(field.id, next)}
      min={field.min ?? 0}
      max={field.max ?? 100}
      step={field.step ?? 1}
    />
  );
}
