// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { NumberInput } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';

export default function NumberField({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const stored = formState[field.id];
  // An emptied field is stored as undefined and shown as '' — see onChange.
  // `stored ?? default` would refill the input the instant it emptied, which is
  // the bug this file previously had, so the empty case is handled explicitly
  // and only a field that was NEVER set falls back to the default.
  const value = field.id in formState && stored == null ? '' : (stored ?? field.default ?? 0);

  return (
    <NumberInput
      id={`spec-${field.id}`}
      label={field.label}
      helperText={field.helperText}
      value={value}
      // allowEmpty lets the field be cleared while typing — without it Carbon
      // coerces an empty input to 0 and that 0 stays sticky, so every digit you
      // type lands behind it ("05", "015", …).
      allowEmpty
      // Store an emptied field as UNDEFINED, not '' and not the default.
      //
      // Writing the default the instant the input emptied made the field
      // impossible to clear: backspacing through "-45" refilled it with "-45"
      // on the very keystroke that emptied it, so the leading characters could
      // never be removed. You had to type the new value first, then go back and
      // delete the leftovers — reported against End Angle, but it affected
      // every spec-driven number field.
      //
      // undefined specifically, because buildOption resolves these through
      // toNumber(value, DEFAULT) and Number('') === 0 — storing '' would
      // silently render a cleared angle as 0° instead of falling back to the
      // spec default. Only undefined takes the fallback path.
      onChange={(_e, { value: next }) =>
        onFieldChange(field.id, next === '' || next == null ? undefined : next)
      }
      min={field.min ?? -1000000}
      max={field.max ?? 1000000}
      step={field.step ?? 1}
      hideSteppers
    />
  );
}
