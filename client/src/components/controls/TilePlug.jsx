// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@mdi/react';
import {
  mdiPowerPlug, mdiLightbulbOn, mdiLightbulbOutline, mdiCeilingFanLight,
  mdiTelevision, mdiWaterPump, mdiFan, mdiPowerSocket, mdiGarage,
  mdiGateOpen, mdiDoorOpen, mdiThermometer
} from '@mdi/js';

const ICON_MAP = {
  'power-plug': mdiPowerPlug,
  'lightbulb-on': mdiLightbulbOn,
  'lightbulb-outline': mdiLightbulbOutline,
  'ceiling-fan-light': mdiCeilingFanLight,
  'fan': mdiFan,
  'television': mdiTelevision,
  'water-pump': mdiWaterPump,
  'power-socket': mdiPowerSocket,
  'garage': mdiGarage,
  'gate-open': mdiGateOpen,
  'door-open': mdiDoorOpen,
  'thermometer': mdiThermometer,
};
import PropTypes from 'prop-types';
import { useControlState } from './useControlState';
import { normalizeBoolean, formatTitle } from './controlUtils';
import { useTileFontSize } from './useTileFontSize';
import { registerControl } from './controlRegistry';
import ControlPlug from './ControlPlug';
import './controls.scss';

function TilePlug({ control, readOnly = false, onSuccess, onError }) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState({});
  const tileRef = useRef(null);
  const fontSize = useTileFontSize();

  const uiConfig = control.control_config?.ui_config || {};
  const displayName = control.title || control.name || uiConfig.label || 'Switch';
  const onLabel = uiConfig.onLabel || 'On';
  const offLabel = uiConfig.offLabel || 'Off';
  const iconPath = ICON_MAP[uiConfig.icon] || mdiPowerPlug;

  const { value: toggled } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: uiConfig.state_field || 'state',
    transform: normalizeBoolean,
    initialValue: false
  });

  const handleTileClick = useCallback(() => {
    if (popupOpen) {
      setPopupOpen(false);
      return;
    }
    if (!tileRef.current) return;
    // Use the tile button's rect (the inner div), not the wrapper.
    // Fall back to the wrapper rect if the inner button isn't there.
    const tileButton = tileRef.current.querySelector('.tile-plug');
    const btnRect = tileButton
      ? tileButton.getBoundingClientRect()
      : tileRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const btnCenterX = btnRect.left + btnRect.width / 2;
    const openRight = btnCenterX < viewportWidth / 2;
    const openAbove = btnRect.top > viewportHeight / 2;

    setPopupStyle({
      position: 'fixed',
      ...(openRight
        ? { right: viewportWidth - btnRect.right - 39 }
        : { left: btnRect.left - 41 }),
      ...(openAbove
        ? { bottom: viewportHeight - btnRect.top + 2 }
        : { top: btnRect.bottom + 2 }),
      zIndex: 9999,
    });
    setPopupOpen(true);
  }, [popupOpen]);

  return (
    <div className="tile-wrapper" ref={tileRef}>
      <div
        className={`tile-plug ${toggled ? 'tile-plug-on' : 'tile-plug-off'}`}
        style={{ fontSize }}
        onClick={(e) => { e.stopPropagation(); handleTileClick(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleTileClick(); }}
        aria-label={`${displayName}: ${toggled ? onLabel : offLabel}`}
      >
        <Icon path={iconPath} size={0.8} className="tile-icon" />
        <span className="tile-name">{formatTitle(displayName)}</span>
        <span className="tile-state">{toggled ? onLabel.toUpperCase() : offLabel.toUpperCase()}</span>
      </div>

      {popupOpen && createPortal(
        <>
          <div className="tile-popup-backdrop" onClick={(e) => { e.stopPropagation(); setPopupOpen(false); }} onDoubleClick={(e) => e.stopPropagation()} />
          <div className="tile-popup" style={popupStyle}>
            <ControlPlug
              control={control}
              readOnly={readOnly}
              onSuccess={onSuccess}
              onError={onError}
            />
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

TilePlug.propTypes = {
  control: PropTypes.shape({
    id: PropTypes.string.isRequired,
    name: PropTypes.string,
    title: PropTypes.string,
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

registerControl('tile_switch', TilePlug);
registerControl('tile_plug', TilePlug); // Backward compatibility
export default TilePlug;
