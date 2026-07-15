// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Fallback color used when a namespace has no color set or the record
// can't be resolved at all. Neutral gray on g100 dark theme.
const DEFAULT_COLOR = '#6f6f6f';

// Map each namespace-palette preset hex (NAMESPACE_PALETTE in NamespacesPage)
// to a Carbon tag COLOR NAME. Namespace identity is all about telling colors
// apart, so we render the chip in the exact same vivid, theme-correct,
// distinguishable colors as every other Carbon <Tag> (via the --cds-tag-*
// tokens). Carbon's gray / cool-gray / warm-gray tag backgrounds are nearly
// identical on dark theme (#525252 / #4d5358 / #565151), so we use only ONE
// neutral (gray) and fold the others in — three indistinguishable greys would
// waste namespace-identity slots. Carbon also has no orange/yellow tag hue, so
// those legacy presets fall to their nearest distinct color.
const PRESET_TO_TAG = {
  '#6f6f6f': 'gray',       // Gray
  '#4d5358': 'cool-gray',  // Cool Gray
  '#565151': 'warm-gray',  // Warm Gray
  '#393939': 'gray',       // Black (legacy) → gray
  '#0f62fe': 'blue',       // Blue (removed from the picker; existing blue namespaces still render blue)
  '#1192e8': 'cyan',       // Cyan
  '#009d9a': 'teal',     // Teal
  '#24a148': 'green',    // Green
  '#da1e28': 'red',      // Red
  '#d02670': 'magenta',  // Magenta
  '#8a3ffc': 'purple',   // Purple
  '#6929c4': 'purple',   // Cool (legacy deep purple) → purple
  '#ff832b': 'red',      // Warm (legacy orange) → red (no orange tag hue)
  '#f1c21b': 'gray',     // Yellow (legacy) → gray (warm-gray reads as grey)
};

function tagColorForHex(hex) {
  return PRESET_TO_TAG[(hex || '').toLowerCase()] || 'gray';
}

// The canonical palette hex for each Carbon tag color — the one preset the
// trimmed NAMESPACE_PALETTE offers. Used to normalize a legacy/dropped color
// (e.g. Warm #ff832b, which maps to 'red') to the surviving palette swatch
// (#da1e28) so the picker shows the right swatch when editing old namespaces.
const TAG_TO_CANONICAL_HEX = {
  gray: '#6f6f6f',
  'cool-gray': '#4d5358',
  'warm-gray': '#565151',
  blue: '#0f62fe',
  cyan: '#1192e8',
  teal: '#009d9a',
  green: '#24a148',
  red: '#da1e28',
  magenta: '#d02670',
  purple: '#8a3ffc',
};

/**
 * Normalize any stored namespace color (incl. legacy/dropped palette hexes) to
 * the canonical palette hex for its Carbon tag color. So a namespace saved with
 * Warm (#ff832b → red) resolves to the surviving Red swatch (#da1e28), letting
 * the picker highlight the correct swatch on edit. Chip rendering is unaffected
 * (it already maps via namespaceChipStyle).
 */
export function canonicalNamespaceColor(hex) {
  return TAG_TO_CANONICAL_HEX[tagColorForHex(hex)] || DEFAULT_COLOR;
}

/**
 * Style helper for Carbon `<Tag>` used as a namespace chip. Maps the
 * namespace's chosen palette color to the matching Carbon tag color and
 * returns the theme tag tokens, so namespace chips use the same vivid,
 * distinguishable, theme-aware colors as every other tag (dark-bg/light-text
 * on g100) — color identity is the whole point of a namespace, so we do NOT
 * desaturate. Unknown/legacy hexes fall back to the gray tag tokens.
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
  const tag = tagColorForHex(hex);
  return {
    backgroundColor: `var(--cds-tag-background-${tag})`,
    color: `var(--cds-tag-color-${tag})`,
  };
}

export const NAMESPACE_DEFAULT_COLOR = DEFAULT_COLOR;

// Namespace color palette — ONE preset per distinct Carbon tag color, so the
// picker is a true 1:1 key: each swatch renders as the actual Carbon tag color
// the chip will use (via namespaceChipStyle), and what you pick is exactly the
// chip you get. The stored `value` is the canonical hex for that Carbon color
// (kept for back-compat with existing namespace records, which store a hex;
// PRESET_TO_TAG above maps it to the tag color at render).
//
// Blue is intentionally NOT offered: user tags render type="blue" across the
// app, so a blue namespace pill collides with the tag pills next to it and
// stops reading as a namespace. (Existing namespaces already stored as blue
// still render blue — we only removed it as a NEW choice.) Cool Gray + Warm
// Gray are offered as the remaining distinct Carbon tag hues; on g100 dark
// they read close to Gray, so revisit with custom hues if that's too subtle.
//
// Lives here (not in a page) so the namespace LIST create-modal and the
// namespace DETAIL page edit form stay in lockstep (#4).
export const NAMESPACE_PALETTE = [
  { name: 'Gray',      value: '#6f6f6f' },
  { name: 'Cool Gray', value: '#4d5358' },
  { name: 'Warm Gray', value: '#565151' },
  { name: 'Cyan',      value: '#1192e8' },
  { name: 'Teal',      value: '#009d9a' },
  { name: 'Green',     value: '#24a148' },
  { name: 'Red',       value: '#da1e28' },
  { name: 'Magenta',   value: '#d02670' },
  { name: 'Purple',    value: '#8a3ffc' },
];
