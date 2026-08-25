// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Warm-to-cool palette for light controls, plus a few accents.
 *
 * These are ordinary light colors rather than the Carbon series palette,
 * which is tuned for distinguishability between chart series and produces
 * some deeply unflattering light colors. `allowCustom` on ColorSwatchPicker
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

/**
 * Resolve a control's device-side brightness scale.
 *
 * The UI works in 0–100%, but devices don't: Zigbee bulbs use 0–254, and
 * other integrations use their own ranges. A control that assumes the device
 * shares its own 0–100 scale both under-sends (50% → raw 50, which is 20% of
 * 254) and mis-displays (raw 48 read straight back as "48%").
 *
 * `ui_config.device_scale` names the device's maximum. When unset, the scale
 * is 1:1 with the UI range, which is the historical behaviour — so existing
 * controls on genuinely 0–100 devices are unaffected.
 *
 * @param {object} uiConfig
 * @param {number} uiMax - the control's own UI maximum (usually 100)
 * @returns {number} the device-side maximum
 */
export function resolveDeviceScale(uiConfig = {}, uiMax = 100) {
  const raw = Number(uiConfig.device_scale);
  return Number.isFinite(raw) && raw > 0 ? raw : uiMax;
}

/** UI value (min..uiMax) → device value (0..deviceMax). */
export function uiToDevice(value, uiMin, uiMax, deviceMax) {
  if (uiMax === uiMin) return 0;
  const ratio = (value - uiMin) / (uiMax - uiMin);
  return Math.max(0, Math.min(deviceMax, Math.round(ratio * deviceMax)));
}

/** Device value (0..deviceMax) → UI value (uiMin..uiMax). */
export function deviceToUi(raw, uiMin, uiMax, deviceMax) {
  if (deviceMax <= 0) return uiMin;
  const ratio = Number(raw) / deviceMax;
  return Math.max(uiMin, Math.min(uiMax, Math.round(uiMin + ratio * (uiMax - uiMin))));
}
