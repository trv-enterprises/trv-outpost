// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Layout Configuration
 *
 * Defines standard dimensions and spacing for the dashboard layout system.
 * Based on Carbon Design System spacing tokens and grid patterns.
 */

// Base spacing unit - Carbon Design $spacing-08
export const SPACING_UNIT = 32; // 32px

// Canvas configuration
export const CANVAS = {
  maxWidth: 1920,
  maxHeight: 1080,
  backgroundColor: '#161616', // Carbon g100 background
};

// Grid configuration
export const GRID = {
  columns: 12, // 12-column grid
  rowHeight: SPACING_UNIT, // 32px per row
  spacing: SPACING_UNIT, // 32px between panels
  snapToGrid: true,
};

// Default panel dimensions (in pixels)
export const PANEL = {
  defaultWidth: 320, // 10 * SPACING_UNIT
  defaultHeight: 256, // 8 * SPACING_UNIT
  minWidth: 160, // 5 * SPACING_UNIT
  minHeight: 160, // 5 * SPACING_UNIT
  maxWidth: 1280, // 40 * SPACING_UNIT
  maxHeight: 1280, // 40 * SPACING_UNIT
};

// Panel controls configuration
export const CONTROLS = {
  dragHandleSize: 24, // Circle size for drag handle
  resizeHandleSize: 16, // Bottom-right corner handle
  borderWidth: 2,
  selectedBorderColor: '#0f62fe', // Carbon blue60
  hoverBorderColor: '#4589ff', // Carbon blue50
  defaultBorderColor: '#393939', // Carbon gray80
};

// Mode configuration
export const MODES = {
  DESIGN: 'design',
  VIEW: 'view',
  MANAGE: 'manage',
};

// Design mode sections
export const DESIGN_SECTIONS = {
  LAYOUTS: 'layouts',
  CONNECTIONS: 'connections',
  COMPONENTS: 'components',
  DASHBOARDS: 'dashboards',
};

// Z-index layers
export const Z_INDEX = {
  panel: 1,
  panelHover: 2,
  panelDragging: 10,
  controls: 5,
  modal: 100,
  tooltip: 200,
};

// Animation durations (ms)
export const ANIMATION = {
  panelTransition: 200,
  hoverDelay: 100,
  tooltipDelay: 300,
};

// Minimum panel sizes per component subtype (in grid units: w=columns, h=rows)
// Grid cells are 32x32px. Used to prevent panels from being resized smaller than the component can render.
export const COMPONENT_MIN_SIZES = {
  // Default fallback
  default: { w: 4, h: 2 },

  // Charts (component_type='chart')
  bar:       { w: 6, h: 4 },
  line:      { w: 6, h: 4 },
  area:      { w: 6, h: 4 },
  pie:       { w: 6, h: 4 },
  scatter:   { w: 6, h: 4 },
  gauge:     { w: 4, h: 3 },
  dataview:  { w: 8, h: 3 },
  number:    { w: 4, h: 2 },
  custom:    { w: 4, h: 2 },

  // Controls (component_type='control')
  button:     { w: 4, h: 2 },
  toggle:     { w: 6, h: 3 },
  slider:     { w: 8, h: 4 },
  text_input: { w: 6, h: 2 },
  switch:     { w: 4, h: 8 },
  plug:       { w: 4, h: 8 },  // Backward compatibility
  dimmer:     { w: 4, h: 8 },
  tile_switch:{ w: 3, h: 3 },
  tile_plug:  { w: 3, h: 3 },  // Backward compatibility
  tile_dimmer:{ w: 3, h: 3 },
  tile_garage_door: { w: 3, h: 3 },
  text_label: { w: 2, h: 1 },

  // Displays (component_type='display')
  frigate_camera: { w: 8, h: 6 },
  weather:        { w: 14, h: 12 },
};

// Get minimum size for a component subtype
export function getComponentMinSize(subtype) {
  return COMPONENT_MIN_SIZES[subtype] || COMPONENT_MIN_SIZES.default;
}

export default {
  SPACING_UNIT,
  CANVAS,
  GRID,
  PANEL,
  CONTROLS,
  MODES,
  DESIGN_SECTIONS,
  Z_INDEX,
  ANIMATION,
  COMPONENT_MIN_SIZES,
  getComponentMinSize,
};
