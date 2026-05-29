// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function ColumnSelectField({ field }) {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? '';

  // When editing a saved chart, availableColumns is empty until the
  // user re-runs the query. Carbon's <Select> renders blank if `value`
  // has no matching <SelectItem>, which would make a configured chart
  // look unconfigured. Inject the saved value as an option so the
  // current selection always shows; once a fetch repopulates
  // availableColumns the duplicate collapses naturally.
  const options = value && !availableColumns.includes(value)
    ? [value, ...availableColumns]
    : availableColumns;

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
      {options.map((col) => (
        <SelectItem key={col} value={col} text={col} />
      ))}
    </Select>
  );
}
