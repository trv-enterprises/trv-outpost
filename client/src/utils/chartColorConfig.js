// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Deployment-wide preferred Carbon color-pairing OPTION per series count.
// Carbon offers several curated combinations ("options") for each
// series-count (see CATEGORICAL_PAIRINGS in config/theme.js); this picks
// which option a multi-series chart uses when it auto-colors. Lives in its
// own tiny module so option-helpers (the color resolver) reads it without a
// circular import, exactly like streamBufferConfig.js does for the buffer.
//
// The app sets this once at bootstrap from the `chart_preferred_color_options`
// admin setting (JSON map {count: optionNumber}). 1-based option numbers,
// matching the Settings UI and Carbon's `pairing.option`. Default 2 for
// every count (Tom's pick — option 1 is Carbon's default; 2 reads better on
// our dashboards). Applies on next page load, like the other appearance
// settings.

// 1-based option index per series-count. Default 2 across the board.
const DEFAULT_PREFERRED_OPTIONS = { 1: 2, 2: 2, 3: 2, 4: 2, 5: 2 };

let preferredOptions = { ...DEFAULT_PREFERRED_OPTIONS };

/**
 * Normalize an admin-setting value into a plain { count: option } object.
 * The Go/Mongo driver decodes a YAML/BSON map into the "ordered document"
 * shape `[{Key, Value}, ...]` when it round-trips through interface{} — the
 * same quirk EnabledTypesEditorModal handles — so accept both forms.
 * @param {object|Array} value
 * @returns {Record<string, number>}
 */
export function normalizePreferredColorOptions(value) {
  if (!value) return {};
  if (Array.isArray(value)) {
    const out = {};
    value.forEach((entry) => {
      if (entry && typeof entry === 'object' && 'Key' in entry) out[entry.Key] = entry.Value;
    });
    return out;
  }
  if (typeof value === 'object') return value;
  return {};
}

/**
 * Set the deployment-wide preferred pairing option per count. Called once at
 * app bootstrap from the chart_preferred_color_options admin setting. Accepts
 * either a plain object or the BSON [{Key,Value}] shape, merges onto the
 * defaults, and ignores non-positive / non-integer values so a partial or
 * malformed setting can't break coloring.
 * @param {Record<string|number, number>|Array} mapOrPairs
 */
export function setPreferredColorOptions(mapOrPairs) {
  const map = normalizePreferredColorOptions(mapOrPairs);
  const next = { ...DEFAULT_PREFERRED_OPTIONS };
  for (const [count, opt] of Object.entries(map)) {
    const n = Number(opt);
    if (Number.isInteger(n) && n >= 1) next[count] = n;
  }
  preferredOptions = next;
}

/**
 * Preferred 1-based pairing option for a given series count (default 2).
 * Counts without a configured/curated option return 1 as a safe floor.
 * @param {number} count
 * @returns {number} 1-based option number
 */
export function getPreferredColorOption(count) {
  return preferredOptions[count] ?? 1;
}

/** The whole current map (for the Settings UI to seed its editor). */
export function getPreferredColorOptions() {
  return { ...preferredOptions };
}

export { DEFAULT_PREFERRED_OPTIONS };
