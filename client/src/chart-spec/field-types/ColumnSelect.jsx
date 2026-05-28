// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function ColumnSelectField({ field }) {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? '';

  return (
    <Select
      id={`spec-${field.id}`}
      labelText={field.label}
      helperText={field.helperText}
      value={value}
      onChange={(e) => onFieldChange(field.id, e.target.value)}
      invalid={field.required && !value}
      invalidText={field.required ? 'Required' : undefined}
    >
      <SelectItem value="" text={field.placeholder || 'Select a column'} />
      {availableColumns.map((col) => (
        <SelectItem key={col} value={col} text={col} />
      ))}
    </Select>
  );
}
