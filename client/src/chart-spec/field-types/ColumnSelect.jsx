// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function ColumnSelectField({ field }) {
  const { availableColumns, formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? '';

  // Sort the column options alphabetically so the dropdown isn't in
  // arbitrary query order. (Doesn't touch availableColumns itself, which
  // other field types use for column ordering — e.g. the dataview's
  // visible-column order.)
  const sortedColumns = [...availableColumns].sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  // When editing a saved chart, availableColumns is empty until the
  // user re-runs the query. Carbon's <Select> renders blank if `value`
  // has no matching <SelectItem>, which would make a configured chart
  // look unconfigured. Inject the saved value as an option so the
  // current selection always shows; once a fetch repopulates
  // availableColumns the duplicate collapses naturally.
  const options = value && !sortedColumns.includes(value)
    ? [value, ...sortedColumns]
    : sortedColumns;

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
