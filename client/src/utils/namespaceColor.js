// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Fallback color used when a namespace has no color set or the record
// can't be resolved at all. Neutral gray on g100 dark theme.
const DEFAULT_COLOR = '#6f6f6f';

// Derive a readable foreground for a given hex background. Anything
// brighter than half-gray gets black text, darker gets white. Keeps
// text legible across Carbon's blue/green/red/purple palette that
// users pick from.
function contrastForeground(hex) {
  if (!hex || hex.length < 7) return '#ffffff';
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Standard luminance formula (sRGB approximation).
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? '#161616' : '#ffffff';
}

/**
 * Style helper for Carbon `<Tag>` used as a namespace chip. Returns
 * inline styles that lock in background + foreground regardless of
 * Carbon's default tag coloring.
 *
 * Pass either:
 *   - a namespace record { name, color }
 *   - a plain hex color string
 *   - nothing, in which case the fallback gray is used
 */
export function namespaceChipStyle(nsOrHex) {
  let hex = DEFAULT_COLOR;
  if (typeof nsOrHex === 'string' && nsOrHex.startsWith('#')) {
    hex = nsOrHex;
  } else if (nsOrHex && typeof nsOrHex === 'object' && nsOrHex.color) {
    hex = nsOrHex.color;
  }
  return {
    backgroundColor: hex,
    color: contrastForeground(hex),
  };
}

export const NAMESPACE_DEFAULT_COLOR = DEFAULT_COLOR;
