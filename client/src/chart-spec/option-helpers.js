// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

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
