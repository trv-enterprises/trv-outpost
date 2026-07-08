// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { CATEGORICAL_PALETTE, CATEGORICAL_NAMES, CATEGORICAL_PAIRINGS, PAIRING_COUNTS } from '../config/theme.js';
import { getPreferredColorOption } from '../utils/chartColorConfig.js';

// Shared ECharts-option helpers for spec-driven chart buildOption
// functions (line/bar/area/gauge/...). Anything every chart's option
// literal wants — color tokens, value formatting, reading values out of
// the {columns, rows} result shape — lives here so each <type>.js
// imports it instead of redeclaring its own copy.
//
// This is the option/data layer. The React/DOM layer (title header,
// loading/error/no-data states, flex wrapper, theme) lives in the
// ChartShell component, not here.

// ── Carbon palette tokens shared across charts ───────────────────────
// Blue is the canonical single-series / left-axis color; purple is the
// right (second) axis. Status colors drive gauge segments + thresholds.
export const COLOR_PRIMARY = '#0f62fe'; // blue60  — left axis / default series
export const COLOR_SECONDARY = '#8a3ffc'; // purple — right axis
export const COLOR_OK = '#24a148'; // green50
export const COLOR_WARN = '#f1c21b'; // yellow30
export const COLOR_DANGER = '#da1e28'; // red60
export const COLOR_TEXT = '#f4f4f4';
export const COLOR_TEXT_SECONDARY = '#c6c6c6';

// ── Carbon categorical (multi-series) palette ────────────────────────
// The canonical Carbon Charts 14-color qualitative sequence, in the
// exact order IBM curates for maximum contrast between neighboring
// categories. Used whenever a chart has 3+ series and there's no
// per-axis color rule to apply — previously this fell through to
// ECharts' own default palette (off-brand). Resolve series colors by
// position into this array (wrapping past 14).
//
// Carbon's categorical data-viz palette for the ACTIVE THEME. The Light and
// Dark variants + the active-theme selection live in ONE place — src/config/
// theme.js (APP_THEME). We re-export it here as CATEGORICAL_COLORS so existing
// importers are unchanged. The renderer references it by index, never raw hex.
// To switch the whole app's series colors: change APP_THEME in config/theme.js.
export const CATEGORICAL_COLORS = CATEGORICAL_PALETTE;

/**
 * Color for the Nth series (0-based) from the Carbon categorical
 * palette, wrapping when there are more series than palette entries.
 * @param {number} i 0-based series index
 * @returns {string} hex color
 */
export function categoricalColor(i) {
  return CATEGORICAL_COLORS[((i % CATEGORICAL_COLORS.length) + CATEGORICAL_COLORS.length) % CATEGORICAL_COLORS.length];
}

/**
 * Carbon's COUNT-AWARE color combination for a chart with `count` series.
 * Carbon curates specific combinations per series-count (1–5) so the colors
 * are mutually distinguishable — NOT just the first N of the 14-sequence.
 * The combination ("option") is the deployment's preferred option for that
 * count (admin setting chart_preferred_color_options, default 2), clamped to
 * what Carbon actually defines for the count.
 *
 * Counts outside 1–5 (or an unexpectedly empty table) fall back to the
 * 14-color categorical sequence cycled by index — the prior behavior — so a
 * 6+ series chart still gets distinct, on-brand colors. The returned array
 * length always === count.
 *
 * @param {number} count number of series in the chart
 * @returns {string[]} hex colors, one per series, in order
 */
export function paletteForCount(count) {
  const n = Math.max(0, Math.floor(count) || 0);
  if (PAIRING_COUNTS.includes(n)) {
    const options = CATEGORICAL_PAIRINGS[n];
    if (Array.isArray(options) && options.length > 0) {
      // Preferred option is 1-based; clamp into range, fall back to option 1.
      const pref = getPreferredColorOption(n);
      const idx = Math.min(Math.max(1, pref), options.length) - 1;
      const combo = options[idx];
      if (Array.isArray(combo) && combo.length === n) return combo.slice();
    }
  }
  // Fallback: cycle the 14-sequence by index.
  return Array.from({ length: n }, (_, i) => categoricalColor(i));
}

// Named, numbered palette for the per-series color picker + agent. Each entry:
// { number (1-based), name (Carbon name), hex }. number/name are the vocabulary
// a user or the AI uses ("color 1", "purple70"); hex is what gets stored on
// y_axis[].color. DERIVED from the active-theme palette (config/theme.js) so it
// stays in lockstep with the auto series colors and follows a theme switch.
export const SERIES_COLOR_PALETTE = CATEGORICAL_PALETTE.map((hex, i) => ({
  number: i + 1,
  name: CATEGORICAL_NAMES[i],
  hex,
}));

/**
 * Resolve a series-color token to a canonical hex from SERIES_COLOR_PALETTE.
 * Accepts:
 *   - a 1-based palette NUMBER (1-14), as number or numeric string ("6")
 *   - a Carbon NAME ("purple70", case-insensitive)
 *   - a HEX ("#6929c4") — returned as-is (lowercased) if it's a 7-char hex
 * Returns the resolved hex, or null when the token is empty/unrecognized
 * (caller then falls back to the automatic palette).
 * @param {string|number} token
 * @returns {string|null}
 */
export function resolveSeriesColor(token) {
  if (token == null || token === '') return null;
  if (typeof token === 'string' && /^#[0-9a-fA-F]{6}$/.test(token)) {
    return token.toLowerCase();
  }
  // numeric index (1-based)
  const n = Number(token);
  if (Number.isInteger(n) && n >= 1 && n <= SERIES_COLOR_PALETTE.length) {
    return SERIES_COLOR_PALETTE[n - 1].hex;
  }
  // Carbon name
  const name = String(token).trim().toLowerCase();
  const byName = SERIES_COLOR_PALETTE.find((c) => c.name.toLowerCase() === name);
  return byName ? byName.hex : null;
}

// CARBON_COLORS is the same palette as a single named object. Spec-driven
// charts import the COLOR_* constants directly; custom-code charts can't
// import, so the dynamic loader injects THIS object into their eval scope
// (as `CARBON_COLORS`). Custom code references e.g. CARBON_COLORS.primary
// instead of a hardcoded '#0f62fe', which keeps custom charts consistent
// with spec-driven ones and gives us a single seam to resolve from Carbon
// theme tokens at runtime later (see the chart-colors-resolve-carbon-tokens
// todo) — when that lands, theme switches flow into custom charts for free.
export const CARBON_COLORS = {
  primary: COLOR_PRIMARY,
  secondary: COLOR_SECONDARY,
  ok: COLOR_OK,
  warn: COLOR_WARN,
  danger: COLOR_DANGER,
  text: COLOR_TEXT,
  textSecondary: COLOR_TEXT_SECONDARY,
};

// ── Numeric coercion ─────────────────────────────────────────────────

/** Coerce to a finite number, or return `fallback` when it isn't one. */
export function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ── {columns, rows} readers ──────────────────────────────────────────
// Spec buildOption receives data as { columns: string[], rows: any[][] }.
// These read values by column name without each chart re-implementing
// the indexOf dance.

/** Index of a named column in the result, or -1. */
export function columnIndex(data, name) {
  return (data?.columns || []).indexOf(name);
}

/** All values of a named column, in row order. Empty array if absent. */
export function columnValues(data, name) {
  const idx = columnIndex(data, name);
  if (idx < 0) return [];
  return (data?.rows || []).map((r) => r[idx]);
}

// ── accumulator / delta transform ────────────────────────────────────
// Counter-style sources (odometers, packet counters, kWh meters) emit a
// monotonically-increasing accumulator; the interesting value is each
// point's DELTA from the previous one. When `accumulator_mode` is on, walk
// the series pairwise and emit value[i] - value[i-1]. The first point has no
// predecessor → null (ECharts leaves a gap). Counter resets (delta < 0) are
// governed by reset_policy. See issue #8.
export const ACCUMULATOR_RESET_POLICIES = ['drop_negative', 'keep_negative', 'clamp_zero'];

/**
 * Pairwise-delta a series of values per the accumulator reset policy.
 * @param {any[]} values series y-values in row order (may contain null)
 * @param {string} policy 'drop_negative' (default) | 'keep_negative' | 'clamp_zero'
 * @returns {(number|null)[]} deltas, same length as input; index 0 is always null
 */
export function applyAccumulator(values, policy = 'drop_negative') {
  const out = new Array(values.length).fill(null);
  let prev = null; // last numeric value seen (skips nulls so a gap doesn't reset)
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    // Non-numeric / null source point: emit a gap, keep prev for the next pair.
    if (v == null || !Number.isFinite(Number(v))) { out[i] = null; continue; }
    const cur = Number(v);
    if (prev == null) { out[i] = null; prev = cur; continue; } // no predecessor
    const delta = cur - prev;
    prev = cur;
    if (delta < 0) {
      // Counter reset / wrap.
      if (policy === 'keep_negative') out[i] = delta;
      else if (policy === 'clamp_zero') out[i] = 0;
      else out[i] = null; // drop_negative (default): break the line
    } else {
      out[i] = delta;
    }
  }
  return out;
}

/**
 * First row's value for a named column, coerced to a number.
 * Used by single-value charts (gauge, number). Returns `fallback`
 * when the column is missing or the result set is empty.
 */
export function firstNumericValue(data, name, fallback = 0) {
  const idx = columnIndex(data, name);
  const rows = data?.rows || [];
  if (idx < 0 || rows.length === 0) return fallback;
  return toNumber(rows[0][idx], fallback);
}

// ── Value formatting (decimals + unit suffix) ────────────────────────

/**
 * Build a value formatter from a decimals count + unit suffix. This is
 * the shared 80%-case formatter — decimals + units, no freeform JS.
 * Charts wanting arbitrary formatting use chart-level custom code.
 *
 * @param {number|null} decimals  null/undefined → no rounding.
 * @param {string} [units]        appended after a space when non-empty.
 * @param {boolean} [si]          SI-abbreviate values ≥ 1k (#159). Takes
 *   precedence over `decimals` for those values — the per-component SI
 *   toggle is the off switch when full digits are wanted. Values under
 *   1k keep the decimals/raw behavior.
 * @returns {(val:any)=>string}
 */
export function makeValueFormatter(decimals, units = '', si = false) {
  const d = decimals == null ? null : Number(decimals);
  const u = units || '';
  return (val) => {
    if (val == null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val);
    let str;
    if (si && Math.abs(num) >= 1000) str = formatSI(num);
    else str = d == null ? String(num) : num.toFixed(d);
    return u ? `${str} ${u}` : str;
  };
}

// ── SI-prefix abbreviation for large values (#159) ───────────────────

// Ordered largest-first so the first match wins. Values below 1k get no
// prefix (nothing to abbreviate).
const SI_PREFIXES = [
  { value: 1e12, symbol: 'T' },
  { value: 1e9, symbol: 'G' },
  { value: 1e6, symbol: 'M' },
  { value: 1e3, symbol: 'k' },
];

/**
 * Pick the SI prefix for a magnitude. Returns `{ value, symbol }` or
 * null when |maxAbs| < 1000 (leave the value unabbreviated).
 */
export function siPrefixFor(maxAbs) {
  const m = Math.abs(Number(maxAbs));
  if (!Number.isFinite(m)) return null;
  for (const p of SI_PREFIXES) {
    if (m >= p.value) return p;
  }
  return null;
}

/**
 * Format one value against a FIXED prefix, 3 significant digits with
 * trailing zeros trimmed (14,340,393,939 @ G → "14.3G"). The caller
 * picks the prefix once per axis so every tick shares the same suffix.
 * A null prefix passes the value through unformatted.
 */
export function formatSIWithPrefix(val, prefix) {
  if (val == null) return '';
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  if (!prefix) return String(num);
  const scaled = num / prefix.value;
  const abs = Math.abs(scaled);
  // 3 significant digits: <10 → 2 decimals, <100 → 1, else integer.
  // parseFloat trims trailing zeros so ticks read "5G", not "5.00G".
  let str;
  if (abs >= 100) str = String(Math.round(scaled));
  else if (abs >= 10) str = String(parseFloat(scaled.toFixed(1)));
  else str = String(parseFloat(scaled.toFixed(2)));
  return `${str}${prefix.symbol}`;
}

/**
 * Per-value SI format for data labels (each point picks its own
 * prefix). Values under 1k pass through unchanged — small numbers keep
 * their existing rendering.
 */
export function formatSI(val) {
  if (val == null) return '';
  const num = Number(val);
  if (!Number.isFinite(num)) return String(val);
  return formatSIWithPrefix(num, siPrefixFor(num));
}

/**
 * Build an axisLabel.formatter that abbreviates with ONE shared prefix
 * chosen from the axis's largest |value| — the issue #159 rule that all
 * labels on an axis render with the same suffix. `range` (a manual
 * {min, max} override) is folded into the magnitude so a pinned axis
 * picks the prefix its ticks will actually reach. Returns null when the
 * axis never leaves 3-digit territory, so callers skip the formatter
 * entirely and ECharts' default tick rendering is untouched.
 */
export function makeSIAxisFormatter(values, range = {}) {
  let maxAbs = 0;
  const consider = (v) => {
    if (v == null) return;
    const n = Number(v);
    if (Number.isFinite(n) && Math.abs(n) > maxAbs) maxAbs = Math.abs(n);
  };
  (values || []).forEach(consider);
  consider(range?.min);
  consider(range?.max);
  const prefix = siPrefixFor(maxAbs);
  if (!prefix) return null;
  return (val) => formatSIWithPrefix(val, prefix);
}

// ── Shared option fragments ──────────────────────────────────────────

/** Every chart renders on a transparent canvas (panel supplies bg). */
export const TRANSPARENT_BG = 'transparent';
