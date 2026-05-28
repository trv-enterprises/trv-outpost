// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Toggle } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function BooleanField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = Boolean(formState[field.id] ?? field.default ?? false);

  return (
    <Toggle
      id={`spec-${field.id}`}
      labelText={field.label}
      labelA="Off"
      labelB="On"
      toggled={value}
      onToggle={(next) => onFieldChange(field.id, next)}
    />
  );
}
