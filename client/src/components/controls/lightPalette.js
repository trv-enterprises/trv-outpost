// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Warm-to-cool palette for light controls, plus a few accents.
 *
 * These are ordinary light colours rather than the Carbon series palette,
 * which is tuned for distinguishability between chart series and produces
 * some deeply unflattering light colours. `allowCustom` on ColorSwatchPicker
 * covers anything not offered here.
 *
 * Lives in its own module so both ControlLight and TileLight can import it
 * without either file exporting a non-component (which breaks Fast Refresh).
 */
export const LIGHT_COLOR_PALETTE = [
  { hex: '#FFF6E5', name: 'Candle' },
  { hex: '#FFE8C4', name: 'Warm white' },
  { hex: '#FFD300', name: 'Amber' },
  { hex: '#FFA000', name: 'Sunset' },
  { hex: '#FF6B35', name: 'Ember' },
  { hex: '#FF3B30', name: 'Red' },
  { hex: '#FF7AB8', name: 'Pink' },
  { hex: '#B388FF', name: 'Lavender' },
  { hex: '#547CFF', name: 'Blue' },
  { hex: '#40C4FF', name: 'Sky' },
  { hex: '#00E5B0', name: 'Mint' },
  { hex: '#7CFF6B', name: 'Green' },
  { hex: '#FFFFFF', name: 'Cool white' },
];

/** Zigbee brightness is 0–254; the UI works in percent. */
export const ZIGBEE_MAX_BRIGHTNESS = 254;

export const pctToZigbee = (pct) =>
  Math.max(0, Math.min(ZIGBEE_MAX_BRIGHTNESS, Math.round((pct / 100) * ZIGBEE_MAX_BRIGHTNESS)));

export const zigbeeToPct = (raw) =>
  Math.max(0, Math.min(100, Math.round((Number(raw) / ZIGBEE_MAX_BRIGHTNESS) * 100)));
