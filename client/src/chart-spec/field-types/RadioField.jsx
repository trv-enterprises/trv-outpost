// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { RadioButtonGroup, RadioButton } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

/**
 * Radio-button group for a small, fixed set of mutually-exclusive
 * choices. Same spec shape as `enum` (options: [{value, label}]) — the
 * difference is purely presentational: a radio group shows every option
 * at once, so the author compares them without opening a menu. Use it
 * when there are ~2-4 options and the choice benefits from seeing the
 * alternatives; keep `enum` for longer lists (the size ladder, the
 * source-unit table) where a menu is the only sane control.
 *
 * `name` is keyed on the field id, not the label: Carbon groups radios
 * by `name`, so two groups sharing one would behave as a SINGLE group —
 * selecting in one clears the other. The numeric and text value paths
 * each render their own copy of the threshold-target control, which is
 * exactly that hazard. See [[carbon-duplicate-id-gotcha]].
 */
export default function RadioField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] ?? field.default ?? '';
  const options = field.options || [];

  // Helper text renders ABOVE the group rather than through Carbon's
  // legend: RadioButtonGroup has no helperText slot, and the same
  // `.spec-field-helper` element is what ThresholdList/TextThresholdList
  // use, so field-level help reads identically across the form.
  return (
    <div className="spec-radio-field">
      {field.helperText && (
        <div className="spec-field-helper">{field.helperText}</div>
      )}
      <RadioButtonGroup
        name={`spec-${field.id}`}
        legendText={field.label}
        valueSelected={value}
        onChange={(next) => onFieldChange(field.id, next)}
        orientation={field.orientation === 'vertical' ? 'vertical' : 'horizontal'}
      >
        {options.map((opt) => (
          <RadioButton
            key={String(opt.value)}
            id={`spec-${field.id}-${opt.value}`}
            value={opt.value}
            labelText={opt.label}
          />
        ))}
      </RadioButtonGroup>
    </div>
  );
}
