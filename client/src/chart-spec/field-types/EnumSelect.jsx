// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Select, SelectItem } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function EnumSelectField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? '';

  // A Carbon <Select> with a value that matches no <SelectItem> silently
  // displays the FIRST option instead — so a record saved with an
  // off-grid value (e.g. a number-chart numberSize of 50, which isn't one
  // of the discrete size presets) would render as "10 px" in the editor
  // while the viewer still draws the true 50px. That divergence reads as
  // "the editor shows the wrong size." Guard it generically: if the
  // current value isn't among the options, prepend a synthetic option for
  // it so the control reflects what's actually saved. Selecting any real
  // option drops the synthetic one on the next render.
  const options = field.options || [];
  const hasMatch = options.some((opt) => String(opt.value) === String(value));
  const renderedOptions = hasMatch || value === ''
    ? options
    : [{ value: String(value), label: String(value) }, ...options];

  return (
    <Select
      id={`spec-${field.id}`}
      labelText={field.label}
      helperText={field.helperText}
      value={value}
      onChange={(e) => onFieldChange(field.id, e.target.value)}
    >
      {renderedOptions.map((opt) => (
        <SelectItem key={String(opt.value)} value={opt.value} text={opt.label} />
      ))}
    </Select>
  );
}
