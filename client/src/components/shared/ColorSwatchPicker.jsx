// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
 * @param {boolean}  [float] render the palette in a portal on document.body
 *        with fixed positioning, so it escapes a clipping ancestor.
 *        Dashboard panels and tiles set `overflow: hidden` (they must —
 *        panel content has to stay inside its cell), which cut the palette
 *        off at the panel edge. Off by default: the chart/threshold editors
 *        are not inside a clipping box and don't need it.
 */
export default function ColorSwatchPicker({
  value = '',
  onChange,
  label = 'Series color',
  palette = SERIES_COLOR_PALETTE,
  allowAuto = true,
  allowCustom = false,
  float = false,
}) {
  const [open, setOpen] = useState(false);
  const [floatStyle, setFloatStyle] = useState({});
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => {
      if (!ref.current) return;
      if (ref.current.contains(e.target)) return;
      // In float mode the palette is portalled, so it is NOT inside `ref`.
      // Without this the mousedown closes it before a swatch click lands.
      if (e.target.closest?.('.color-swatch-picker__content--float')) return;
      setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Position the floating palette from the trigger's viewport rect, flipping
  // when it would run off the bottom or right edge.
  const positionFloat = useCallback(() => {
    const trigger = ref.current?.querySelector('.color-swatch-picker__trigger');
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const GAP = 6;
    const EST_W = 190;
    const EST_H = 190;
    const openUp = r.bottom + EST_H > window.innerHeight && r.top > EST_H;
    const openLeft = r.left + EST_W > window.innerWidth;
    setFloatStyle({
      position: 'fixed',
      ...(openUp
        ? { bottom: window.innerHeight - r.top + GAP }
        : { top: r.bottom + GAP }),
      ...(openLeft
        ? { right: Math.max(GAP, window.innerWidth - r.right) }
        : { left: Math.min(r.left, window.innerWidth - EST_W - GAP) }),
      zIndex: 9999,
    });
  }, []);

  const toggleOpen = () => {
    setOpen((o) => {
      const next = !o;
      if (next && float) positionFloat();
      return next;
    });
  };

  const pick = (hex) => {
    onChange?.(hex);
    setOpen(false);
  };

  const isAuto = !value;

  // The palette body, shared by both modes so they cannot drift apart.
  const paletteBody = (
    <>
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
    </>
  );

  const trigger = (
    <button
      type="button"
      className={`color-swatch-picker__trigger ${isAuto ? 'color-swatch-picker__trigger--auto' : ''}`}
      style={isAuto ? undefined : { backgroundColor: value }}
      onClick={(e) => { e.stopPropagation(); toggleOpen(); }}
      aria-haspopup="true"
      aria-expanded={open}
      aria-label={isAuto ? `${label}: Auto` : `${label}: ${value}`}
      title={isAuto ? 'Auto (default palette)' : value}
    />
  );

  // Floating mode: portal to document.body so a panel's overflow:hidden
  // cannot clip the palette. The outside-click handler above compares
  // against `ref`, which no longer contains the portalled content, so the
  // portal stops propagation itself and closes on its own backdrop.
  if (float) {
    return (
      <span ref={ref} className="color-swatch-picker">
        {trigger}
        {open && createPortal(
          <>
            <div
              className="color-swatch-picker__backdrop"
              onClick={(e) => { e.stopPropagation(); setOpen(false); }}
            />
            <div
              className="color-swatch-picker__content color-swatch-picker__content--float"
              style={floatStyle}
              onClick={(e) => e.stopPropagation()}
              role="presentation"
            >
              {paletteBody}
            </div>
          </>,
          document.body,
        )}
      </span>
    );
  }

  return (
    <span ref={ref} className="color-swatch-picker">
      <Popover open={open} align="bottom-right" onRequestClose={() => setOpen(false)} dropShadow>
        {trigger}
        <PopoverContent className="color-swatch-picker__content">
          {paletteBody}
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
  float: PropTypes.bool,
};
