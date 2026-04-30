// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@mdi/react';
import { mdiGarage } from '@mdi/js';
import PropTypes from 'prop-types';
import { useControlState } from './useControlState';
import { useTileFontSize } from './useTileFontSize';
import { formatTitle } from './controlUtils';
import { registerControl } from './controlRegistry';
import GarageDoorSVG, { GARAGE_DOOR_STATES } from './GarageDoorSVG';
import './controls.scss';

function TileGarageDoor({ control, readOnly: _readOnly = false }) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState({});
  const tileRef = useRef(null);
  const fontSize = useTileFontSize();

  const uiConfig = control.control_config?.ui_config || {};
  const displayName = control.title || control.name || uiConfig.label || 'Garage';

  const { value: contact } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: uiConfig.state_field || 'contact',
    initialValue: undefined
  });

  let doorState = 'unknown';
  if (contact === true || contact === 'true') doorState = 'closed';
  else if (contact === false || contact === 'false') doorState = 'open';

  const isOpen = doorState === 'open';
  const doorConfig = GARAGE_DOOR_STATES[doorState];
  const stateLabel = doorConfig.stateLabel;

  const handleTileClick = useCallback(() => {
    if (popupOpen) {
      setPopupOpen(false);
      return;
    }
    if (!tileRef.current) return;
    const tileButton = tileRef.current.querySelector('.tile-garage-door');
    const btnRect = tileButton ? tileButton.getBoundingClientRect() : tileRef.current.getBoundingClientRect();
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
        className={`tile-garage-door ${isOpen ? 'tile-garage-door--open' : 'tile-garage-door--closed'}`}
        style={{ fontSize }}
        onClick={(e) => { e.stopPropagation(); handleTileClick(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        role="status"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleTileClick(); }}
        aria-label={`${displayName}: ${stateLabel}`}
      >
        <Icon path={mdiGarage} size={0.8} className="tile-icon" />
        <span className="tile-name">{formatTitle(displayName)}</span>
        <span className="tile-state">{stateLabel.toUpperCase()}</span>
      </div>

      {popupOpen && createPortal(
        <>
          <div className="tile-popup-backdrop" onClick={(e) => { e.stopPropagation(); setPopupOpen(false); }} onDoubleClick={(e) => e.stopPropagation()} />
          <div className="tile-popup tile-garage-door-popup" style={popupStyle}>
            <GarageDoorSVG state={doorState} width={120} height={108} />
            <span className="popup-label">{displayName}</span>
            <span className="popup-state" style={{ color: doorConfig.stateColor }}>
              {stateLabel.toUpperCase()}
            </span>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

TileGarageDoor.propTypes = {
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
  readOnly: PropTypes.bool
};

registerControl('tile_garage_door', TileGarageDoor);
export default TileGarageDoor;
