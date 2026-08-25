// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useCallback, useEffect } from 'react';
import { InlineLoading, Toggle } from '@carbon/react';
import PropTypes from 'prop-types';
import { useControlState } from './useControlState';
import { useControlCommand } from './useControlCommand';
import { registerControl } from './controlRegistry';
import ColorSwatchPicker from '../shared/ColorSwatchPicker';
import { colorFieldToHex, holdWrittenHex } from '../../utils/colorXY';
import { LIGHT_COLOR_PALETTE, pctToZigbee, zigbeeToPct } from './lightPalette';
import './controls.scss';

/**
 * ControlLight
 *
 * Full control surface for a Zigbee2MQTT colour bulb: power, brightness, and
 * colour. Used on its own as a panel control, and hosted inside TileLight's
 * popup.
 *
 * Command shape: this control sends a composite object rather than a scalar,
 * e.g. {state:'ON', brightness:120, color:{hex:'#ffd300'}}. Z2M accepts hex
 * directly and converts on the way in, so nothing is converted on the command
 * path. State comes back as color:{x,y}, which is why the read path converts
 * (see utils/colorXY.js).
 */
function ControlLight({ control, readOnly = false, onSuccess, onError, compact = false }) {
  const uiConfig = control.control_config?.ui_config || {};
  const label = uiConfig.label || control.title || control.name || 'Light';
  const showColor = uiConfig.show_color !== false;
  const showBrightness = uiConfig.show_brightness !== false;

  // The hex this client last wrote. Held against the device's reported colour
  // so the swatch doesn't visibly shift on the lossy xy round trip — but only
  // while the device still agrees (an automation can recolour the light).
  const [writtenHex, setWrittenHex] = useState('');
  const [dragPct, setDragPct] = useState(null);
  const barRef = useRef(null);

  // Power. `state` arrives as the string "ON"/"OFF".
  const { value: rawState, setValue: setRawState, suppress, clearSuppress } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: uiConfig.state_field || 'state',
    fallbackFields: ['state'],
    initialValue: undefined,
  });

  // Brightness, normalised to percent for display.
  const { value: brightnessPct, setValue: setBrightnessPct } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: 'brightness',
    fallbackFields: [],
    transform: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? zigbeeToPct(n) : undefined;
    },
    initialValue: 0,
  });

  // Colour. The device only ever reports {x,y}, so convert on the way in.
  const { value: deviceHex } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: 'color',
    fallbackFields: [],
    transform: (raw) => colorFieldToHex(raw),
    initialValue: '',
  });

  const isOn = typeof rawState === 'string' ? rawState.toUpperCase() === 'ON' : !!rawState;
  const displayHex = holdWrittenHex(writtenHex, deviceHex);
  const displayPct = dragPct !== null ? dragPct : (brightnessPct || 0);

  // Once the device reports a colour materially different from what we wrote,
  // the hold has expired — drop it so we stop competing with the device.
  useEffect(() => {
    if (writtenHex && deviceHex && holdWrittenHex(writtenHex, deviceHex) === deviceHex) {
      setWrittenHex('');
    }
  }, [deviceHex, writtenHex]);

  const { execute, loading } = useControlCommand({
    controlId: control.id,
    label,
    target: control.control_config?.target || '',
    onSuppress: suppress,
    onClearSuppress: clearSuppress,
    onSuccess,
    onError,
  });

  const handleToggle = useCallback((checked) => {
    if (readOnly || loading) return;
    setRawState(checked ? 'ON' : 'OFF');
    execute({ state: checked ? 'ON' : 'OFF' }, `${label} ${checked ? 'ON' : 'OFF'}`);
  }, [readOnly, loading, execute, label, setRawState]);

  const sendBrightness = useCallback((pct) => {
    setBrightnessPct(pct);
    if (pct <= 0) {
      execute({ state: 'OFF' }, `${label} OFF`);
      return;
    }
    // Only force the light on when it is already on, or when the user is
    // raising it from zero (an unambiguous "turn it up" gesture).
    //
    // Zigbee keeps `brightness` as the REMEMBERED level while `state` is OFF —
    // the device reports state:OFF with brightness:109 — so setting brightness
    // on an off light must adjust that remembered level, not switch it on.
    // Sending state:'ON' unconditionally turned the light on any time the
    // slider moved, which is not what the gesture means.
    const turnOn = isOn || (brightnessPct || 0) <= 0;
    execute(
      turnOn
        ? { state: 'ON', brightness: pctToZigbee(pct) }
        : { brightness: pctToZigbee(pct) },
      `${label} ${pct}%`,
    );
  }, [execute, label, setBrightnessPct, isOn, brightnessPct]);

  const handleColor = useCallback((hex) => {
    if (readOnly || loading || !hex) return;
    // Hold it immediately so the swatch shows what was picked, not the
    // round-tripped approximation that arrives a moment later.
    setWrittenHex(hex);
    // Z2M takes hex directly — no conversion on the command path.
    execute({ state: 'ON', color: { hex } }, `${label} colour ${hex}`);
  }, [readOnly, loading, execute, label]);

  // --- brightness bar drag ---------------------------------------------
  const yToPct = useCallback((clientY) => {
    if (!barRef.current) return displayPct;
    const rect = barRef.current.getBoundingClientRect();
    const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return Math.round(ratio * 100);
  }, [displayPct]);

  const handlePointerDown = (e) => {
    if (readOnly || loading) return;
    e.preventDefault();
    e.stopPropagation();
    setDragPct(yToPct(e.clientY));

    const move = (ev) => setDragPct(yToPct(ev.clientY));
    const up = (ev) => {
      const final = yToPct(ev.clientY);
      setDragPct(null);
      sendBrightness(final);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const handleBarKeyDown = (e) => {
    if (readOnly || loading) return;
    let next = displayPct;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') next = Math.min(100, displayPct + 5);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') next = Math.max(0, displayPct - 5);
    else if (e.key === 'Home') next = 100;
    else if (e.key === 'End') next = 0;
    else return;
    e.preventDefault();
    sendBrightness(next);
  };

  return (
    <div className={`control-light ${compact ? 'control-light--compact' : ''}`}>
      <div className="control-light__section control-light__section--power">
        <Toggle
          // Carbon toggles are Downshift-free but still need unique ids when
          // the same control is mounted more than once on a dashboard.
          id={`light-power-${control.id}`}
          className="control-light__toggle"
          labelText=""
          labelA="Off"
          labelB="On"
          toggled={isOn}
          disabled={readOnly || loading}
          onToggle={handleToggle}
        />
        {loading && <InlineLoading description="" className="control-light__loading" />}
      </div>

      {showBrightness && (
        <div className="control-light__section control-light__section--brightness">
          <div
            ref={barRef}
            className={`control-light__bar ${isOn ? 'is-on' : 'is-off'} ${readOnly ? 'is-readonly' : ''}`}
            onPointerDown={handlePointerDown}
            onKeyDown={handleBarKeyDown}
            role="slider"
            tabIndex={readOnly ? -1 : 0}
            aria-label={`${label} brightness`}
            aria-valuenow={displayPct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`control-light__bar-fill ${isOn ? '' : 'is-off'}`}
              style={{
                // The bar still shows the level while the light is off,
                // because that IS the remembered level the bulb will return
                // to — but dimmed, so "off at 43%" cannot be mistaken for lit.
                height: `${displayPct}%`,
                // Tint the fill with the live colour so brightness and colour
                // read as one object rather than two unrelated widgets.
                ...(displayHex ? { backgroundColor: displayHex } : {}),
              }}
            />
            <span className="control-light__bar-value">{isOn ? `${displayPct}%` : 'OFF'}</span>
          </div>
        </div>
      )}

      {showColor && (
        <div className="control-light__section control-light__section--color">
          <span className="control-light__color-label">Colour</span>
          <ColorSwatchPicker
            value={displayHex}
            onChange={handleColor}
            label={`${label} colour`}
            palette={LIGHT_COLOR_PALETTE}
            allowAuto={false}
            allowCustom
          />
        </div>
      )}
    </div>
  );
}

ControlLight.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    title: PropTypes.string,
    connection_id: PropTypes.string,
    control_config: PropTypes.shape({
      target: PropTypes.string,
      ui_config: PropTypes.object,
    }),
  }).isRequired,
  readOnly: PropTypes.bool,
  onSuccess: PropTypes.func,
  onError: PropTypes.func,
  compact: PropTypes.bool,
};

registerControl('light', ControlLight);
export default ControlLight;
