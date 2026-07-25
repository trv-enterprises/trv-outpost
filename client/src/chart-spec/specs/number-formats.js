// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Value formatters for the spec-driven number chart. The format choice
// (options.numberFormat) IMPLIES the raw value's unit — e.g. "duration"
// means the value is seconds, "bytes" means the value is bytes — so the
// agent/user just maps a raw column and picks the matching format instead
// of doing unit math in the query or dropping to custom code.
//
// Pure functions, no React/DOM — unit-testable. number.js calls
// formatNumberValue() with the chosen format + the decimals setting.

import { formatTimestamp } from '../../utils/dataTransforms.js';

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Plain locale number with an optional fixed decimal count ('auto' = up
// to 2). Shared by the default + as a fallback.
function formatPlain(n, decimals) {
  if (decimals != null && decimals !== 'auto') {
    const places = Number(decimals);
    if (Number.isFinite(places)) {
      return n.toLocaleString('en-US', { minimumFractionDigits: places, maximumFractionDigits: places });
    }
  }
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// 1234567 → "1.23M". decimals controls the fraction digits on the scaled
// value ('auto' → 1). Uses the SI prefix table (T/G/M/k) to match the
// chart SI helper (option-helpers.js formatSI, #159) — number tiles and
// charts now abbreviate the same value identically (1e9 → "G" giga, not
// "B" billion; 1e3 → lowercase SI "k"). Keeping the two in sync avoids a
// dashboard showing "10.3G" on a line chart and "10.3B" on a number tile
// for the same number.
function formatCompact(n, decimals) {
  const places = (decimals != null && decimals !== 'auto' && Number.isFinite(Number(decimals)))
    ? Number(decimals) : 1;
  const abs = Math.abs(n);
  const units = [
    [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'],
  ];
  for (const [factor, suffix] of units) {
    if (abs >= factor) return (n / factor).toFixed(places) + suffix;
  }
  // Below 1000 — no suffix; honor decimals (or trim trailing zeros for auto).
  return decimals != null && decimals !== 'auto' ? n.toFixed(places) : String(+n.toFixed(2));
}

// seconds → "2d 3h 4m" (largest two-ish units). Drops leading zero units.
function formatDuration(totalSeconds) {
  const s = Math.floor(Math.abs(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const sign = totalSeconds < 0 ? '-' : '';
  if (days > 0) return `${sign}${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${sign}${hours}h ${mins}m`;
  if (mins > 0) return `${sign}${mins}m ${secs}s`;
  return `${sign}${secs}s`;
}

// seconds → "HH:MM:SS" (hours uncapped, e.g. 100:00:00 for long uptimes).
function formatDurationClock(totalSeconds) {
  const s = Math.floor(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (x) => String(x).padStart(2, '0');
  const sign = totalSeconds < 0 ? '-' : '';
  return `${sign}${pad(h)}:${pad(m)}:${pad(sec)}`;
}

// Map the date-format sub-choice to the formatTimestamp preset name.
const DATE_PRESETS = {
  date: 'chart_date',
  time: 'chart_time',
  time_seconds: 'chart_time_seconds',
  datetime: 'chart_datetime',
  datetime_seconds: 'chart_datetime_seconds',
};

/**
 * Format a number-chart value according to options.numberFormat.
 *
 * @param {*} raw            the cell value (null/number/string)
 * @param {string} valueColumn  column name (for the auto fallback)
 * @param {object} opts      { numberFormat, numberDecimals, numberDateFormat }
 * @param {Function} formatCellValue  the viewer's auto-formatter (fallback)
 * @returns {string}
 */
export function formatNumberValue(raw, valueColumn, opts = {}, formatCellValue) {
  if (raw == null) return '';
  const format = opts.numberFormat || 'auto';
  const decimals = opts.numberDecimals;

  // Date/time: value is a timestamp; render with the chosen preset.
  if (format === 'datetime') {
    const preset = DATE_PRESETS[opts.numberDateFormat] || 'chart_datetime';
    return formatTimestamp(raw, preset);
  }

  const n = toNum(raw);
  // Non-numeric value with a numeric format → fall back to auto so we
  // never render "NaN". strictTimestampNames: a tile's value column is a
  // measurement — never flip a byte-count magnitude into a date; only a
  // time-NAMED column (or ISO string) renders as time.
  if (n == null) {
    return formatCellValue ? formatCellValue(raw, valueColumn, { strictTimestampNames: true }) : String(raw);
  }

  switch (format) {
    case 'compact':
      return formatCompact(n, decimals);
    case 'duration':
      return formatDuration(n);
    case 'duration_clock':
      return formatDurationClock(n);
    case 'plain':
      return formatPlain(n, decimals);
    case 'auto':
    default:
      // Explicit decimals → fixed; else defer to the viewer's auto
      // formatter (handles its own locale/precision rules).
      // strictTimestampNames — see the non-numeric fallback above.
      if (decimals != null && decimals !== 'auto') return formatPlain(n, decimals);
      return formatCellValue ? formatCellValue(raw, valueColumn, { strictTimestampNames: true }) : formatPlain(n, 'auto');
  }
}
