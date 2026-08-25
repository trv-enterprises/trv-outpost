// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { useState, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Icon from '@mdi/react';
import PropTypes from 'prop-types';
import {
  mdiLightbulbOn, mdiLightbulbOutline, mdiLightbulbNight,
  mdiCeilingFanLight, mdiFloorLamp, mdiLamp, mdiTrackLight, mdiWallSconce,
} from '@mdi/js';
import { formatTitle } from './controlUtils';
import { useControlState } from './useControlState';
import { useTileFontSize } from './useTileFontSize';
import { registerControl } from './controlRegistry';
import { colorFieldToHex } from '../../utils/colorXY';
import ControlLight from './ControlLight';
import { zigbeeToPct } from './lightPalette';
import './controls.scss';

const ICON_MAP = {
  'lightbulb-on': mdiLightbulbOn,
  'lightbulb-outline': mdiLightbulbOutline,
  'lightbulb-night': mdiLightbulbNight,
  'ceiling-fan-light': mdiCeilingFanLight,
  'floor-lamp': mdiFloorLamp,
  'lamp': mdiLamp,
  'track-light': mdiTrackLight,
  'wall-sconce': mdiWallSconce,
};

/**
 * TileLight
 *
 * Compact tile for a Zigbee2MQTT color bulb, following TileDimmer's
 * vertical-fill idiom so it reads as part of the existing tile set.
 *
 * Two things it adds over TileDimmer:
 *
 *  - The fill is tinted with the light's live color, so the tile shows what
 *    the light is actually doing at a glance.
 *  - The color swatch is ON THE TILE FACE, not only inside the popup.
 *    Changing color is a primary action for this control (the alternative
 *    today is hand-publishing a hex over MQTT), so it gets one tap rather
 *    than two.
 *
 * A motion dot appears only when the device reports `occupancy`. Bulbs that
 * don't publish it simply render without one — the tile is a generic Z2M
 * color bulb, not a nightlight-specific control. Note that occupancy here is
 * a read-only *indicator*: motion driving the light is an automation concern,
 * not something this tile does.
 *
 * No title is rendered inside the tile body — ControlRenderer owns the panel
 * title.
 */
function TileLight({ control, readOnly = false, onSuccess, onError }) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupStyle, setPopupStyle] = useState({});
  const tileRef = useRef(null);
  // The tile only reads, but its four reads must still move together — a
  // per-field window would let brightness and state drift apart mid-update.
  const suppressRef = useRef(0);
  const fontSize = useTileFontSize();

  const uiConfig = control.control_config?.ui_config || {};
  const displayName = control.title || control.name || uiConfig.label || 'Light';
  const iconPath = ICON_MAP[uiConfig.icon] || mdiLightbulbOn;
  const showColorOnTile = uiConfig.show_color_on_tile !== false;

  const { value: rawState } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: uiConfig.state_field || 'state',
    fallbackFields: ['state'],
    initialValue: undefined,
  sharedSuppressRef: suppressRef,
  });

  const { value: brightnessPct } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: 'brightness',
    fallbackFields: [],
    transform: (raw) => {
      const n = Number(raw);
      return Number.isFinite(n) ? zigbeeToPct(n) : undefined;
    },
    initialValue: 0,
  sharedSuppressRef: suppressRef,
  });

  const { value: deviceHex } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: 'color',
    fallbackFields: [],
    transform: (raw) => colorFieldToHex(raw),
    initialValue: '',
  sharedSuppressRef: suppressRef,
  });

  // Read-only presence indicator. `undefined` means this device doesn't
  // report occupancy at all, which is different from "reports false" —
  // only the former hides the dot.
  const { value: occupancy } = useControlState({
    connectionId: control.connection_id,
    target: control.control_config?.target || '',
    stateField: 'occupancy',
    fallbackFields: [],
    initialValue: undefined,
  sharedSuppressRef: suppressRef,
  });

  const isOn = typeof rawState === 'string' ? rawState.toUpperCase() === 'ON' : !!rawState;
  // The tile only reads, so there is no written hex to hold against — that
  // belongs to ControlLight, which does the writing. Show the device's color.
  const displayHex = deviceHex;
  const fillPercent = isOn ? (brightnessPct || 0) : 0;

  const handleTileClick = useCallback(() => {
    if (popupOpen) {
      setPopupOpen(false);
      return;
    }
    if (!tileRef.current) return;
    const tileButton = tileRef.current.querySelector('.tile-light');
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
        className={`tile-light ${isOn ? 'tile-light-on' : 'tile-light-off'}`}
        style={{ fontSize }}
        onClick={(e) => { e.stopPropagation(); handleTileClick(); }}
        onDoubleClick={(e) => e.stopPropagation()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleTileClick(); }}
        aria-label={`${displayName}: ${isOn ? `on, ${fillPercent}%` : 'off'}`}
      >
        <div
          className="tile-light-fill"
          style={{
            height: `${fillPercent}%`,
            ...(displayHex && isOn ? { backgroundColor: displayHex } : {}),
          }}
        />

        <Icon
          path={iconPath}
          size={0.8}
          className="tile-icon"
          // Tint the icon with the live color when lit, so the tile reads
          // correctly even at low brightness where the fill is a sliver.
          style={displayHex && isOn ? { color: displayHex } : undefined}
        />

        {occupancy !== undefined && (
          <span
            className={`tile-light-motion ${occupancy ? 'is-active' : ''}`}
            title={occupancy ? 'Motion detected' : 'No motion'}
            aria-label={occupancy ? 'Motion detected' : 'No motion'}
          />
        )}

        <span className="tile-name">{formatTitle(displayName)}</span>

        <div className="tile-bottom-row">
          <span className="tile-state">{isOn ? 'ON' : 'OFF'}</span>
          {showColorOnTile ? (
            // A swatch, deliberately NOT a picker. Carbon's Popover renders
            // inline, so a picker opened here is clipped by the tile's
            // overflow:hidden — the palette got cut off at the tile edge.
            // The swatch shows the live color and the tile's own popup (which
            // portals to document.body) carries the actual picker, so this
            // stays one tap and the whole tile behaves the same way.
            <span
              className="tile-light-swatch"
              style={displayHex ? { backgroundColor: displayHex } : undefined}
              title={displayHex ? `Color ${displayHex}` : 'Color'}
              aria-hidden="true"
            />
          ) : (
            <span className="tile-value">{isOn ? `${fillPercent}%` : ''}</span>
          )}
        </div>
      </div>

      {popupOpen && createPortal(
        <>
          <div
            className="tile-popup-backdrop"
            onClick={(e) => { e.stopPropagation(); setPopupOpen(false); }}
            onDoubleClick={(e) => e.stopPropagation()}
          />
          <div className="tile-popup tile-popup--light" style={popupStyle}>
            <ControlLight
              control={control}
              readOnly={readOnly}
              onSuccess={onSuccess}
              onError={onError}
              compact
            />
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

TileLight.propTypes = {
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
};

registerControl('tile_light', TileLight);
export default TileLight;
