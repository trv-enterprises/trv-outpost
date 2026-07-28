// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { Button } from '@carbon/react';
import { useSpecRenderContext } from '../SpecContext';
import { BACKGROUND_COLOR_PALETTE, contrastPartnerFor } from '../option-helpers';
import ColorSwatchPicker from './ColorSwatchPicker';

/**
 * ColorSelect — an OPTIONAL single color, chosen from a swatch palette.
 *
 * Differs from the color control embedded in the threshold lists in one
 * way that matters: "no color" is a first-class value here. A value chart
 * has no background until the author gives it one, and they must be able
 * to take it back off — so the field pairs the swatches with a Clear
 * action and stores '' for unset.
 *
 * When the field declares `showsContrastPartner`, the preview also shows
 * the text color that will be paired with the chosen background. The
 * partner is derived (contrastPartnerFor), never picked: the whole point
 * of the pairing is that the author chooses one color and gets a readable
 * combination, so exposing it as a second control would invite the
 * unreadable combinations the lookup exists to prevent.
 */
export default function ColorSelect({ field }) {
  const { formState, onFieldChange } = useSpecRenderContext();
  const value = formState[field.id] || '';
  const partner = field.showsContrastPartner ? contrastPartnerFor(value) : null;

  return (
    <div className="spec-color-select">
      {field.label && <div className="spec-color-select__label">{field.label}</div>}
      {field.helperText && <div className="spec-field-helper">{field.helperText}</div>}
      <div className="spec-color-select__row">
        <ColorSwatchPicker
          idPrefix={`spec-${field.id}`}
          value={value}
          onChange={(hex) => onFieldChange(field.id, hex)}
          palette={BACKGROUND_COLOR_PALETTE}
          ariaLabel={field.label || 'Color'}
        />
        {value && (
          <Button
            kind="ghost"
            size="sm"
            onClick={() => onFieldChange(field.id, '')}
          >
            Clear
          </Button>
        )}
      </div>
      {value && partner && (
        // Live pairing preview — the author picked the fill; this is what
        // the text on it will look like. Cheaper than switching to the
        // chart preview to check readability.
        <div
          className="spec-color-select__preview"
          style={{ backgroundColor: value, color: partner }}
        >
          <span>123.4</span>
          <span className="spec-color-select__preview-note">auto-contrast text</span>
        </div>
      )}
    </div>
  );
}
