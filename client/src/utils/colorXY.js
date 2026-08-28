// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * CIE 1931 xy → sRGB hex conversion for Zigbee color bulbs.
 *
 * Why this exists, and why it only goes one direction:
 *
 * Zigbee2MQTT accepts color in several forms on the way IN — hex, {r,g,b},
 * "r,g,b", or {x,y} — and converts them itself. But every state publish comes
 * back as `color: {x, y}` with `color_mode: "xy"`, whichever form was written.
 * There is no hex echo.
 *
 * So the write path needs no conversion at all (we send hex straight from the
 * picker), and the read path needs exactly one: xy → hex, to paint a swatch
 * from device state. Keeping the maths off the command path matters — a wrong
 * conversion there would be user-visible as the wrong color on the light.
 *
 * The matrices are ported from the homelab Homebridge codec's xyToHs so the
 * two agree on what a given xy looks like; this is the same conversion
 * truncated at sRGB instead of continuing into HSV.
 *
 * Accuracy caveat: xy covers a wider gamut than sRGB, and these matrices are
 * Hue-tuned, so a round trip (pick hex → device → read xy → hex) lands near
 * but not exactly on the original. A caller displaying a color the user just
 * picked should show the written hex outright for the round trip, then fall
 * back to the device's report — a DIFFERENCE test cannot do that job, because
 * right after a write the two always differ (the device has not caught up),
 * so it discards the optimistic value at exactly the wrong moment.
 */

/** Clamp to [0, 1]. */
function clamp01(n) {
  return Math.max(0, Math.min(1, n));
}

/** sRGB transfer function (linear → gamma-encoded). */
function gammaEncode(c) {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/**
 * Convert CIE 1931 xy chromaticity to an sRGB hex string.
 *
 * Brightness is normalised away (Y = 1) because the device reports brightness
 * separately in its own field — mixing it in here would make a dim light show
 * a black swatch.
 *
 * @param {number} x
 * @param {number} y
 * @returns {string} 7-digit hex (e.g. "#ffd300"), or '' when the input is
 *   unusable (non-finite, or y = 0 which would divide by zero).
 */
export function xyToHex(x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return '';
  // y === 0 is off the spectral locus and would divide by zero below.
  if (y <= 0) return '';

  const z = 1.0 - x - y;
  const Y = 1.0;
  const X = (Y / y) * x;
  const Z = (Y / y) * z;

  // Wide-gamut (Hue-tuned) XYZ → linear RGB.
  let r = X * 1.656492 - Y * 0.354851 - Z * 0.255038;
  let g = -X * 0.707196 + Y * 1.655397 + Z * 0.036152;
  let b = X * 0.051713 - Y * 0.121364 + Z * 1.011530;

  // Normalise by the largest channel rather than clamping at 1.
  //
  // This matters more than it looks. Forcing Y = 1 above fixes luminance, not
  // scale, so a saturated color lands with one channel far above 1 and the
  // others small. Clamping there would flatten the bright channels to equal
  // values and wash the color out toward white — #547CFF round-tripped to a
  // pale cyan that way. Dividing by the max preserves the ratios between
  // channels, which is what carries hue AND saturation.
  //
  // The homelab codec clamps instead, but it only reads *hue* off the result
  // and throws the washed-out saturation away, so the bug never surfaces there.
  const peak = Math.max(r, g, b);
  if (peak > 0) {
    r /= peak;
    g /= peak;
    b /= peak;
  }

  // Clamp before gamma: out-of-gamut values are negative here, and
  // Math.pow of a negative is NaN.
  r = gammaEncode(clamp01(r));
  g = gammaEncode(clamp01(g));
  b = gammaEncode(clamp01(b));

  // Gamma encoding can push very slightly outside [0,1]; clamp again.
  const toByte = (c) => Math.round(clamp01(c) * 255).toString(16).padStart(2, '0');

  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

/**
 * Pull `{x, y}` out of a Zigbee2MQTT state record's `color` field and convert.
 * Returns '' when the record carries no usable xy color.
 *
 * @param {object} color - the `color` value from a state publish
 * @returns {string} hex or ''
 */
export function colorFieldToHex(color) {
  if (!color || typeof color !== 'object') return '';
  const { x, y } = color;
  if (x === undefined || y === undefined) return '';
  return xyToHex(Number(x), Number(y));
}

/** Parse a 7-digit hex into {r,g,b} bytes, or null if malformed. */
function hexToRgb(hex) {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/**
 * sRGB relative luminance (WCAG 2.x) of a hex color, 0 (black) to 1 (white).
 * Returns null when the hex is unparseable.
 *
 * @param {string} hex
 * @returns {number|null}
 */
export function relativeLuminance(hex) {
  const c = hexToRgb(hex);
  if (!c) return null;
  const lin = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

// Carbon gray100 / gray10. Exported so callers can tell the two cases apart
// (e.g. to swap a text-shadow that only works under light text) without
// re-deriving luminance or hardcoding the hex a second time.
export const TEXT_ON_LIGHT = '#161616';
export const TEXT_ON_DARK = '#f4f4f4';

/** WCAG 2.x contrast ratio between two luminances, 1:1 to 21:1. */
function contrastRatio(l1, l2) {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/**
 * The text color to draw on top of a given fill.
 *
 * Light bulbs are the motivating case: the palette runs from Candle (#FFF6E5)
 * to Blue (#547CFF), so a single hardcoded text color fails at one end.
 * White-on-Candle in particular read as nothing at all.
 *
 * Rather than threshold the luminance, this measures the contrast ratio both
 * ways and returns whichever wins. That avoids picking a crossover point by
 * feel, and it turned out to matter: bulb colors are emissive and skew bright,
 * so *every* color in LIGHT_COLOR_PALETTE reads better under dark text —
 * including ones a 0.5 threshold would have sent the other way (Blue scores
 * 4.9:1 dark vs 3.4:1 light). A threshold would have quietly kept the bug on
 * the mid-luminance colors.
 *
 * Returns Carbon's gray100 / gray10 rather than pure black/white so the tiles
 * stay on-palette.
 *
 * @param {string} hex background fill
 * @returns {string|null} text hex, or null when the fill is unparseable
 */
export function textColorOn(hex) {
  const L = relativeLuminance(hex);
  if (L === null) return null;
  const onLight = contrastRatio(L, relativeLuminance(TEXT_ON_LIGHT));
  const onDark = contrastRatio(L, relativeLuminance(TEXT_ON_DARK));
  return onLight >= onDark ? TEXT_ON_LIGHT : TEXT_ON_DARK;
}

/**
 * How far apart two hex colors are, as the largest per-channel difference
 * in 0–255. Returns Infinity when either side is unparseable, so callers
 * treat "unknown" as "different".
 */
export function hexDistance(a, b) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  if (!ca || !cb) return Infinity;
  return Math.max(
    Math.abs(ca.r - cb.r),
    Math.abs(ca.g - cb.g),
    Math.abs(ca.b - cb.b),
  );
}
