// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import { CATEGORICAL_PALETTE, CATEGORICAL_NAMES } from '../config/theme.js';

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
 * @returns {(val:any)=>string}
 */
export function makeValueFormatter(decimals, units = '') {
  const d = decimals == null ? null : Number(decimals);
  const u = units || '';
  return (val) => {
    if (val == null) return '';
    const num = Number(val);
    if (!Number.isFinite(num)) return String(val);
    const str = d == null ? String(num) : num.toFixed(d);
    return u ? `${str} ${u}` : str;
  };
}

// ── Shared option fragments ──────────────────────────────────────────

/** Every chart renders on a transparent canvas (panel supplies bg). */
export const TRANSPARENT_BG = 'transparent';
