// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useCallback } from 'react';
import { InlineLoading } from '@carbon/react';
import { LightFilled } from '@carbon/icons-react';
import PropTypes from 'prop-types';
import { useControlState } from './useControlState';
import { useControlCommand } from './useControlCommand';
import { registerControl } from './controlRegistry';
import { resolveDeviceScale, uiToDevice, deviceToUi } from './lightPalette';
import './controls.scss';

/**
 * ControlDimmer Component
 *
 * HomeKit-style vertical slider pill for dimming lights.
 * Drag up/down to set level (0-100). Fill rises from bottom.
 * Sends value on mouse/touch release only.
 * Subscribes to MQTT state topic for live updates.
 */
function ControlDimmer({ control, readOnly = false, onSuccess, onError }) {
  const [dragging, setDragging] = useState(false);
  const [dragLevel, setDragLevel] = useState(null);
  const pillRef = useRef(null);

  const uiConfig = control.control_config?.ui_config || {};
  const label = uiConfig.label || 'Light';
  const min = uiConfig.min ?? 0;
  const max = uiConfig.max ?? 100;
  const step = uiConfig.step ?? 1;
  // Devices rarely share the UI's 0-100 scale (Zigbee brightness is 0-254).
  // Without this the control under-sends AND mis-reads the echo back.
  const deviceMax = resolveDeviceScale(uiConfig, max);

  const { value: level, setValue: setLevel, suppress, clearSuppress } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: uiConfig.state_field || 'level',
    fallbackFields: ['level', 'brightness'],
    transform: (raw) => {
      const num = Number(raw);
      return Number.isFinite(num) ? deviceToUi(num, min, max, deviceMax) : undefined;
    },
    initialValue: 0
  });

  const { execute, loading } = useControlCommand({
    controlId: control.id,
    label,
    target: control.control_config?.target || '',
    onSuppress: suppress,
    onClearSuppress: clearSuppress,
    onSuccess,
    onError
  });

  // The displayed level — drag value takes priority during interaction
  const displayLevel = dragging && dragLevel !== null ? dragLevel : level;
  const fillPercent = ((displayLevel - min) / (max - min)) * 100;
  const isOn = displayLevel > min;

  // Convert a Y position within the pill to a level value
  const yToLevel = useCallback((clientY) => {
    if (!pillRef.current) return level;
    const rect = pillRef.current.getBoundingClientRect();
    const ratio = 1 - Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    const raw = min + ratio * (max - min);
    const snapped = Math.round(raw / step) * step;
    return Math.max(min, Math.min(max, snapped));
  }, [min, max, step, level]);

  const sendLevel = (newLevel) => {
    // Send in the device's units; the label stays in the UI's percent.
    execute(uiToDevice(newLevel, min, max, deviceMax),
      `${label} ${newLevel > min ? `${newLevel}%` : 'OFF'}`);
  };

  // Mouse/touch handlers
  const handlePointerDown = (e) => {
    if (loading || readOnly) return;
    e.preventDefault();
    setDragging(true);
    setDragLevel(yToLevel(e.clientY));

    const handlePointerMove = (moveEvent) => {
      setDragLevel(yToLevel(moveEvent.clientY));
    };

    const handlePointerUp = (upEvent) => {
      const finalLevel = yToLevel(upEvent.clientY);
      setLevel(finalLevel);
      setDragging(false);
      setDragLevel(null);
      sendLevel(finalLevel);
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
    };

    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', handlePointerUp);
  };

  // Keyboard support
  const handleKeyDown = (e) => {
    if (readOnly) return;
    let newLevel = level;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
      newLevel = Math.min(max, level + step);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
      newLevel = Math.max(min, level - step);
    } else if (e.key === 'Home') {
      newLevel = max;
    } else if (e.key === 'End') {
      newLevel = min;
    } else {
      return;
    }
    e.preventDefault();
    setLevel(newLevel);
    sendLevel(newLevel);
  };

  return (
    <div className="control-dimmer-container">
      <div
        ref={pillRef}
        className={`dimmer-pill ${isOn ? 'dimmer-on' : 'dimmer-off'} ${loading ? 'dimmer-loading' : ''} ${dragging ? 'dimmer-dragging' : ''} ${readOnly ? 'dimmer-readonly' : ''}`}
        onPointerDown={handlePointerDown}
        onKeyDown={handleKeyDown}
        role="slider"
        tabIndex={0}
        aria-label={`${label}: ${displayLevel}%`}
        aria-valuenow={displayLevel}
        aria-valuemin={min}
        aria-valuemax={max}
      >
        <div className="dimmer-fill" style={{ height: `${fillPercent}%` }} />
        <div className="dimmer-icon-container">
          <LightFilled size={28} className="dimmer-icon" />
        </div>
        <div className="dimmer-value-overlay">
          {displayLevel > min ? `${Math.round(displayLevel)}%` : ''}
        </div>
        {loading && <InlineLoading description="" className="dimmer-inline-loading" />}
      </div>
      <span className={`dimmer-state ${isOn ? 'dimmer-state-on' : ''}`}>
        {isOn ? `${Math.round(displayLevel)}%` : 'OFF'}
      </span>
    </div>
  );
}

ControlDimmer.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    connection_id: PropTypes.string,
    control_config: PropTypes.shape({
      target: PropTypes.string,
      ui_config: PropTypes.object
    })
  }).isRequired,
  readOnly: PropTypes.bool,
  onSuccess: PropTypes.func,
  onError: PropTypes.func
};

registerControl('dimmer', ControlDimmer);
export default ControlDimmer;
