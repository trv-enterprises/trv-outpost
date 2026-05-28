// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { TextInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function TextField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? '';

  return (
    <TextInput
      id={`spec-${field.id}`}
      labelText={field.label}
      helperText={field.helperText}
      placeholder={field.placeholder}
      value={value}
      onChange={(e) => onFieldChange(field.id, e.target.value)}
    />
  );
}
