// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Control Components Registry
 *
 * Control components are interactive UI elements that send commands to connections.
 * They are stored as charts with component_type="control".
 */

export { default as ControlButton } from './ControlButton';
export { default as ControlToggle } from './ControlToggle';
export { default as ControlSlider } from './ControlSlider';
export { default as ControlTextInput } from './ControlTextInput';
export { default as ControlPlug } from './ControlPlug';
export { default as ControlDimmer } from './ControlDimmer';
export { default as ControlGarageDoor } from './ControlGarageDoor';
export { default as TilePlug } from './TilePlug';
export { default as TileDimmer } from './TileDimmer';
export { default as ControlLight } from './ControlLight';
export { default as TileLight } from './TileLight';
// Palette + unit helpers live in their own module so the component files
// export only components (a non-component export breaks Fast Refresh).
export { LIGHT_COLOR_PALETTE, ZIGBEE_MAX_BRIGHTNESS, pctToZigbee, zigbeeToPct } from './lightPalette';
export { default as TileGarageDoor } from './TileGarageDoor';
export { default as ControlMqttPublish } from './ControlMqttPublish';
export { default as ControlTextLabel } from './ControlTextLabel';
export { default as ControlRenderer } from './ControlRenderer';
export { default as GarageDoorSVG, GARAGE_DOOR_STATES } from './GarageDoorSVG';

// Shared hooks and utilities
export { useControlState } from './useControlState';
export { useControlCommand } from './useControlCommand';
export { useTileFontSize } from './useTileFontSize';
export * from './controlUtils';

// Re-export types and metadata from controlTypes (avoids circular deps)
export { CONTROL_TYPES, CONTROL_TYPE_INFO, CONTROL_CATEGORIES } from './controlTypes';
