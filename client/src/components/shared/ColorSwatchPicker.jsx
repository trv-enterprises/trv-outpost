// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Popover, PopoverContent } from '@carbon/react';
import { SERIES_COLOR_PALETTE } from '../../chart-spec/option-helpers';
import './ColorSwatchPicker.scss';

/**
 * Compact color picker for the full Carbon series palette + an "Auto" option.
 * The trigger is a small swatch showing the current color (a dashed/checker
 * swatch when Auto). Clicking opens a grid of the 14 palette colors, each
 * labelled with its number + Carbon name (e.g. "1 · purple70") via title, so it
 * matches the by-number / by-name vocabulary the agent uses.
 *
 * Stores the resolved HEX (or '' for Auto). The caller decides what it means
 * (e.g. y_axis[].color). Renders nothing fancy when value is unset → Auto.
 *
 * @param {string}   value    current hex ('' = Auto)
 * @param {Function} onChange (hex|'') => void
 * @param {string}   label    accessible label for the trigger
 * @param {Array<{hex: string, name?: string, number?: number}>} [palette]
 *        swatches to offer; defaults to the Carbon series palette
 * @param {boolean}  [allowAuto]   show the "Auto" (no explicit color) swatch.
 *        Off for callers where a color is always required — a border has to
 *        be SOME color, so there is nothing for Auto to mean.
 * @param {boolean}  [allowCustom] append a native color input for hexes the
 *        palette doesn't cover
 */
export default function ColorSwatchPicker({
  value = '',
  onChange,
  label = 'Series color',
  palette = SERIES_COLOR_PALETTE,
  allowAuto = true,
  allowCustom = false,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (hex) => {
    onChange?.(hex);
    setOpen(false);
  };

  const isAuto = !value;

  return (
    <span ref={ref} className="color-swatch-picker">
      <Popover open={open} align="bottom-right" onRequestClose={() => setOpen(false)} dropShadow>
        <button
          type="button"
          className={`color-swatch-picker__trigger ${isAuto ? 'color-swatch-picker__trigger--auto' : ''}`}
          style={isAuto ? undefined : { backgroundColor: value }}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          aria-haspopup="true"
          aria-expanded={open}
          aria-label={isAuto ? `${label}: Auto` : `${label}: ${value}`}
          title={isAuto ? 'Auto (default palette)' : value}
        />
        <PopoverContent className="color-swatch-picker__content">
          <div className="color-swatch-picker__grid">
            {allowAuto && (
              <button
                type="button"
                className={`color-swatch-picker__swatch color-swatch-picker__swatch--auto ${isAuto ? 'is-selected' : ''}`}
                onClick={(e) => { e.stopPropagation(); pick(''); }}
                title="Auto — default palette"
                aria-label="Auto"
              />
            )}
            {palette.map((c) => (
              <button
                key={c.hex}
                type="button"
                className={`color-swatch-picker__swatch ${value.toLowerCase() === c.hex.toLowerCase() ? 'is-selected' : ''}`}
                style={{ backgroundColor: c.hex }}
                onClick={(e) => { e.stopPropagation(); pick(c.hex); }}
                title={c.number ? `${c.number} · ${c.name}` : (c.name || c.hex)}
                aria-label={c.number ? `Color ${c.number} ${c.name}` : (c.name || c.hex)}
              />
            ))}
          </div>
          {allowCustom && (
            // Secondary affordance for hexes the palette doesn't cover.
            // Sized in the SCSS — left unconstrained, a native color input
            // stretches to fill its container.
            <label className="color-swatch-picker__custom-row">
              <span>Custom</span>
              <input
                type="color"
                className="color-swatch-picker__custom"
                value={value || '#000000'}
                onChange={(e) => onChange?.(e.target.value)}
                aria-label={`${label} — custom`}
              />
            </label>
          )}
        </PopoverContent>
      </Popover>
    </span>
  );
}

ColorSwatchPicker.propTypes = {
  value: PropTypes.string,
  onChange: PropTypes.func,
  label: PropTypes.string,
  palette: PropTypes.arrayOf(PropTypes.shape({
    hex: PropTypes.string.isRequired,
    name: PropTypes.string,
    number: PropTypes.number,
  })),
  allowAuto: PropTypes.bool,
  allowCustom: PropTypes.bool,
};
