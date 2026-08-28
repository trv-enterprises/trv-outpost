// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Shared utilities for control components.
 */

// After sending a command, ignore incoming state updates for this duration
// so stale MQTT messages don't revert the optimistic UI update
export const SUPPRESS_DURATION_MS = 3000;

/**
 * Derive the state topic from a command target.
 * Convention: command target ends with "/set", state topic is the same path without "/set".
 * Example: "zigbee2mqtt/dining_room_plug/set" → "zigbee2mqtt/dining_room_plug"
 */
export function deriveStateTopic(target) {
  if (!target) return '';
  return target.endsWith('/set') ? target.slice(0, -4) : target;
}

/**
 * Normalize a value to boolean (on/off).
 * Handles the various representations from different MQTT devices.
 */
export function normalizeBoolean(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const upper = value.toUpperCase();
    return upper === 'ON' || upper === 'TRUE' || upper === '1';
  }
  return false;
}

/**
 * Extract a state value from an MQTT record, trying the configured field
 * then common fallbacks.
 *
 * @param {object} record - The MQTT message record
 * @param {string} stateField - Primary field name to check
 * @param {string[]} fallbacks - Additional field names to try
 * @returns {*} The extracted value, or undefined if not found
 */
export function extractStateValue(record, stateField, fallbacks = []) {
  if (record[stateField] !== undefined) return record[stateField];
  for (const field of fallbacks) {
    if (record[field] !== undefined) return record[field];
  }
  return undefined;
}

/**
 * Does the fill cover more than half of an element?
 *
 * Tiles whose fill grows from the bottom (light, dimmer) put their text on a
 * split background at mid levels. The text should take its color from
 * whichever background covers MORE of it, so it flips when the majority of
 * the glyphs change background.
 *
 * Measure the element, never a percentage of tile height. `.tile-name` is
 * `flex: 1` with its text vertically centred, so its glyphs sit well below
 * the tile's own midpoint — testing `fillPercent > 50` called a nearly
 * covered name "uncovered" and left it white on a pale fill, and put the
 * flip point right where the text is, so two tiles a hair apart in
 * brightness disagreed.
 *
 * The element's box works directly for both callers here: the bottom row is
 * text-sized, and the name's single line is centred in its box, so the line
 * and the box share a midpoint and cross the fill together.
 *
 * @param {{top:number, height:number, bottom:number}} rect element box
 * @param {number} fillTop  y of the fill's top edge, same coord space
 * @returns {boolean}
 */
export function isTextMostlyOnFill(rect, fillTop) {
  if (!rect || !rect.height) return false;
  const covered = Math.max(0, rect.bottom - Math.max(rect.top, fillTop));
  return covered > rect.height / 2;
}

/**
 * Format a title string, converting `|` to newline for line breaks.
 * Pair with `white-space: pre-line` in CSS.
 */

export function formatTitle(text) {
  if (!text) return text;
  return text.replaceAll('|', '\n');
}
