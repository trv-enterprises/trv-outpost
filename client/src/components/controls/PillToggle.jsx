// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import './controls.scss';

/**
 * PillToggle
 *
 * An on/off pill with the label INSIDE it, opposite the knob.
 *
 * Why not Carbon's Toggle: Carbon renders its label outside the pill, to the
 * right. In a centred column (the light popup) that hangs off one side and
 * makes the control read as lopsided — and the pill visually shifts as the
 * label changes width between "On" and "Off". Putting the label inside gives
 * one self-contained object with a fixed width, so nothing moves when it
 * flips.
 *
 * This is a custom control by design. The rest of this folder — ControlPlug,
 * ControlDimmer, the tiles — is already hand-rolled in the same HomeKit-style
 * idiom, and Carbon has no inside-label toggle. Styling uses Carbon tokens.
 *
 * Accessibility matches what Carbon's Toggle exposes: role="switch" with
 * aria-checked, Space/Enter activation, and a visible focus ring.
 */
export default function PillToggle({
  id,
  checked,
  onChange,
  disabled = false,
  onLabel = 'ON',
  offLabel = 'OFF',
  label,
  className = '',
}) {
  const toggle = () => {
    if (disabled) return;
    onChange?.(!checked);
  };

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`pill-toggle ${checked ? 'is-on' : 'is-off'} ${className}`}
      onClick={(e) => { e.stopPropagation(); toggle(); }}
      onKeyDown={(e) => {
        // Space and Enter both activate a switch. A <button> handles this
        // natively, but the tile hosts swallow key events, so be explicit.
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          toggle();
        }
      }}
    >
      {/* The knob sits left when off and right when on; the label takes the
          other side, so the two never overlap. */}
      <span className="pill-toggle__knob" aria-hidden="true" />
      <span className="pill-toggle__label" aria-hidden="true">
        {checked ? onLabel : offLabel}
      </span>
    </button>
  );
}

PillToggle.propTypes = {
  id: PropTypes.string,
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  disabled: PropTypes.bool,
  onLabel: PropTypes.string,
  offLabel: PropTypes.string,
  /** Accessible name, e.g. "Night Light power". */
  label: PropTypes.string,
  className: PropTypes.string,
};
