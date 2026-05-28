// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function EnumSelectField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? '';

  return (
    <Select
      id={`spec-${field.id}`}
      labelText={field.label}
      helperText={field.helperText}
      value={value}
      onChange={(e) => onFieldChange(field.id, e.target.value)}
    >
      {field.options.map((opt) => (
        <SelectItem key={String(opt.value)} value={opt.value} text={opt.label} />
      ))}
    </Select>
  );
}
