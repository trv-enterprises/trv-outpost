// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * ColorSwatchPicker — a small palette of clickable swatches, with the
 * native OS color input kept as a secondary "custom" affordance.
 *
 * Replaces the bare `<input type="color">` that threshold rows used to
 * render. That control opens the OS color wheel: every color in the
 * spectrum is reachable and none is suggested, so an author picking a
 * "danger" color had to know the brand hex by heart, and two thresholds
 * on two charts rarely ended up the same red. A short palette of the
 * colors we actually use makes the common choice a single click and
 * keeps dashboards visually consistent.
 *
 * The custom picker stays because a palette can't cover every case
 * (matching an external status convention, colorblind-safe overrides).
 * It is deliberately secondary: a narrow well at the end of the row.
 *
 * @param {object} props
 * @param {string} props.value        current hex ('#rrggbb')
 * @param {function} props.onChange   (hex) => void
 * @param {Array<{name: string, hex: string}>} props.palette
 * @param {string} props.idPrefix     unique id stem (Carbon needs unique ids)
 * @param {string} [props.ariaLabel]
 */
export default function ColorSwatchPicker({ value, onChange, palette, idPrefix, ariaLabel = 'Color' }) {
  const current = (value || '').toLowerCase();
  return (
    <div className="spec-color-picker" role="group" aria-label={ariaLabel}>
      {palette.map((c) => {
        const selected = c.hex.toLowerCase() === current;
        return (
          <button
            key={c.hex}
            type="button"
            className={`spec-color-picker__swatch${selected ? ' spec-color-picker__swatch--selected' : ''}`}
            style={{ backgroundColor: c.hex }}
            // Name + hex both in the tooltip/label: the name is how a
            // person talks about it, the hex is what actually got stored.
            title={`${c.name} (${c.hex})`}
            aria-label={c.name}
            aria-pressed={selected}
            onClick={() => onChange(c.hex)}
          />
        );
      })}
      <input
        id={`${idPrefix}-custom`}
        className="spec-color-picker__custom"
        type="color"
        value={value || '#000000'}
        onChange={(e) => onChange(e.target.value)}
        title="Custom color"
        aria-label={`${ariaLabel} — custom`}
      />
    </div>
  );
}
