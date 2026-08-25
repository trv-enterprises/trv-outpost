// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Control type constants and metadata.
 * Separated from index.js to avoid circular dependencies
 * (ControlRenderer imports these, and index.js exports ControlRenderer).
 */

import {
  mdiGestureTap,
  mdiToggleSwitch,
  mdiTuneVertical,
  mdiFormTextbox,
  mdiPowerPlug,
  mdiLightbulbOn,
  mdiLightbulbNight,
  mdiFormatText,
  mdiGarage,
  mdiSend
} from '@mdi/js';

// Control type constants - must match backend models.ControlType* constants
export const CONTROL_TYPES = {
  BUTTON: 'button',
  TOGGLE: 'toggle',
  SLIDER: 'slider',
  TEXT_INPUT: 'text_input',
  SWITCH: 'switch',
  DIMMER: 'dimmer',
  GARAGE_DOOR: 'garage_door',
  TILE_SWITCH: 'tile_switch',
  TILE_DIMMER: 'tile_dimmer',
  LIGHT: 'light',
  TILE_LIGHT: 'tile_light',
  TILE_GARAGE_DOOR: 'tile_garage_door',
  MQTT_PUBLISH: 'mqtt_publish',
  TEXT_LABEL: 'text_label'
};

// Control type metadata for UI, discovery, and AI builder
export const CONTROL_TYPE_INFO = {
  [CONTROL_TYPES.BUTTON]: {
    label: 'Button',
    description: 'Simple action button that triggers a command when clicked',
    icon: mdiGestureTap,
    category: 'carbon',
    canWrite: true,
    canRead: false,
    defaultUIConfig: {
      label: 'Execute',
      kind: 'primary'
    }
  },
  [CONTROL_TYPES.TOGGLE]: {
    label: 'Toggle',
    description: 'On/off switch that sends true or false',
    icon: mdiToggleSwitch,
    category: 'carbon',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Enable',
      offLabel: 'Disable',
      state_field: 'state'
    }
  },
  [CONTROL_TYPES.SLIDER]: {
    label: 'Slider',
    description: 'Numeric slider for setting values within a range',
    icon: mdiTuneVertical,
    category: 'carbon',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Value',
      min: 0,
      max: 100,
      step: 1,
      state_field: 'value'
    }
  },
  [CONTROL_TYPES.TEXT_INPUT]: {
    label: 'Text Input',
    description: 'Text field for entering custom values or commands',
    icon: mdiFormTextbox,
    category: 'carbon',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Command',
      placeholder: 'Enter value...',
      submitLabel: 'Send',
      state_field: 'value'
    }
  },
  [CONTROL_TYPES.SWITCH]: {
    label: 'Switch',
    description: 'On/off switch with HomeKit-style pill design',
    icon: mdiPowerPlug,
    category: 'custom',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Switch',
      onLabel: 'On',
      offLabel: 'Off',
      state_field: 'state'
    }
  },
  [CONTROL_TYPES.DIMMER]: {
    label: 'Dimmer',
    description: 'Vertical slider for dimming lights, drag to set level',
    icon: mdiLightbulbOn,
    category: 'custom',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Light',
      min: 0,
      max: 100,
      step: 1,
      state_field: 'level',
      device_scale: 254
    }
  },
  [CONTROL_TYPES.GARAGE_DOOR]: {
    label: 'Garage Door',
    description: 'Full-size animated garage door with open/closed state from a contact sensor.',
    icon: mdiGarage,
    category: 'custom',
    canWrite: false,
    canRead: true,
    defaultUIConfig: {
      label: 'Garage',
      state_field: 'contact'
    }
  },
  [CONTROL_TYPES.TILE_SWITCH]: {
    label: 'Tile Switch',
    description: 'Compact tile showing on/off state. Tap to open full control.',
    icon: mdiPowerPlug,
    category: 'tile',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Switch',
      onLabel: 'On',
      offLabel: 'Off',
      state_field: 'state'
    }
  },
  [CONTROL_TYPES.TILE_DIMMER]: {
    label: 'Tile Dimmer',
    description: 'Compact tile showing dimmer level with vertical fill. Tap to open full control.',
    icon: mdiLightbulbOn,
    category: 'tile',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Light',
      min: 0,
      max: 100,
      step: 1,
      // Device-side scale. Zigbee brightness is 0-254, so without this the
      // control sends 50 for "50%" (really 20%) and reads the echo back as
      // a percent. Set to the UI max for a device that genuinely uses 0-100.
      device_scale: 254,
      state_field: 'level'
    }
  },
  [CONTROL_TYPES.LIGHT]: {
    label: 'Light',
    description: 'Colour bulb control — power, brightness, and colour. Writes hex directly; reads CIE xy back from the device.',
    icon: mdiLightbulbOn,
    category: 'carbon',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Light',
      state_field: 'state',
      show_brightness: true,
      show_color: true
    }
  },
  [CONTROL_TYPES.TILE_LIGHT]: {
    label: 'Tile Light',
    description: 'Compact tile for a colour bulb. Fill height is brightness and the fill takes the light\'s live colour; the colour swatch sits on the tile face. Shows a motion dot when the device reports occupancy.',
    icon: mdiLightbulbNight,
    category: 'tile',
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Light',
      icon: 'lightbulb-on',
      state_field: 'state',
      show_color_on_tile: true
    }
  },
  [CONTROL_TYPES.TILE_GARAGE_DOOR]: {
    label: 'Tile Garage Door',
    description: 'Compact tile showing garage door open/closed state from a contact sensor.',
    icon: mdiGarage,
    category: 'tile',
    canWrite: false,
    canRead: true,
    defaultUIConfig: {
      label: 'Garage',
      state_field: 'contact'
    }
  },
  [CONTROL_TYPES.MQTT_PUBLISH]: {
    label: 'MQTT Publish',
    description: 'Fire-and-forget button that publishes a static JSON payload to an MQTT topic when pressed. No device type needed.',
    icon: mdiSend,
    category: 'carbon',
    canWrite: true,
    canRead: false,
    defaultUIConfig: {
      label: 'Publish',
      kind: 'primary',
      payload: {}
    }
  },
  [CONTROL_TYPES.TEXT_LABEL]: {
    label: 'Text Label',
    description: 'Static text display for section headers, date/time, or dashboard titles. No connection needed.',
    icon: mdiFormatText,
    category: 'decorative',
    hidden: true, // Replaced by native text panels — kept for backward compat
    canWrite: false,
    canRead: false,
    defaultUIConfig: {
      display_content: 'title',
      align: 'center',
      size: 'md'
    }
  },

  // --- Backward-compat aliases ---
  // Legacy DB records may still have these control types. The renderers
  // self-register both old and new names (see ControlPlug.jsx, TilePlug.jsx),
  // but the editor also needs metadata entries so the Connection dropdown
  // and other editor fields render correctly. Hidden from the type selector
  // so users can't create new ones — they only appear when editing legacy
  // components.
  plug: {
    label: 'Plug (legacy)',
    description: 'Legacy name for Switch. Kept so existing components can still be edited.',
    icon: mdiPowerPlug,
    category: 'custom',
    hidden: true,
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Switch',
      onLabel: 'On',
      offLabel: 'Off',
      state_field: 'state'
    }
  },
  tile_plug: {
    label: 'Tile Plug (legacy)',
    description: 'Legacy name for Tile Switch. Kept so existing components can still be edited.',
    icon: mdiPowerPlug,
    category: 'tile',
    hidden: true,
    canWrite: true,
    canRead: true,
    defaultUIConfig: {
      label: 'Switch',
      onLabel: 'On',
      offLabel: 'Off',
      state_field: 'state'
    }
  }
};

// Categories for widget selector grouping
export const CONTROL_CATEGORIES = {
  carbon: { label: 'Carbon Controls', description: 'Standard Carbon Design System components' },
  custom: { label: 'Custom Controls', description: 'Full-size custom controls for switches and dimmers' },
  tile: { label: 'Tiles', description: 'Compact state tiles for dashboards' }
};
