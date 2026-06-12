// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * rangePresets — relative time-window presets for the dashboard range variable.
 *
 * A range variable's canonical value is an absolute { from, to } pair of ISO
 * instants. Presets are UI sugar: a token like "1h" resolves to a concrete
 * { from, to } ending "now" at the moment the user picks it. The variable layer
 * only ever stores the resolved absolute instants — no relative tokens leak
 * downstream (see useDashboardVariable / the server substitution layer).
 */

// The default preset set offered when a range variable declares none.
export const DEFAULT_RANGE_PRESETS = ['1h', '6h', '24h', '7d', '30d'];

// Human labels for the known preset tokens. Unknown tokens fall back to the
// token itself (so a custom "12h" still renders sensibly).
const PRESET_LABELS = {
  '15m': 'Last 15 minutes',
  '30m': 'Last 30 minutes',
  '1h': 'Last 1 hour',
  '3h': 'Last 3 hours',
  '6h': 'Last 6 hours',
  '12h': 'Last 12 hours',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
};

/**
 * presetLabel — display label for a preset token (e.g. "1h" → "Last 1 hour").
 * Falls back to "Last <token>" for unrecognized-but-parseable tokens.
 */
export function presetLabel(token) {
  if (PRESET_LABELS[token]) return PRESET_LABELS[token];
  return `Last ${token}`;
}

/**
 * presetDurationMs — milliseconds for a duration token, or null if unparseable.
 * Supported units: s (second), m (minute), h (hour), d (day), w (week). Seconds
 * matter for Prometheus STEP tokens (e.g. '15s', '30s'); window presets use m+.
 */
export function presetDurationMs(token) {
  if (typeof token !== 'string') return null;
  const m = /^(\d+)\s*([smhdw])$/i.exec(token.trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  const MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  return n * MS[unit];
}

/**
 * resolvePreset — resolve a relative preset token to an absolute { from, to }
 * window ending at `now` (a Date, defaulting to the current time). Returns null
 * when the token can't be parsed (caller falls back to no range).
 *
 * Both bounds are ISO 8601 strings (the canonical wire format the server's
 * range substitution expects).
 */
export function resolvePreset(token, now = new Date()) {
  const durMs = presetDurationMs(token);
  if (durMs == null) return null;
  const toMs = now.getTime();
  const fromMs = toMs - durMs;
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  };
}

/**
 * isValidRangeIntent — true when `v` is a usable range INTENT:
 *   { type:'relative', token } | { type:'absolute', from, to }  (+optional step)
 */
export function isValidRangeIntent(v) {
  if (!v || typeof v !== 'object') return false;
  if (v.type === 'relative') return !!v.token;
  if (v.type === 'absolute') return !!v.from && !!v.to;
  return false;
}

/**
 * parseRangeIntent — decode a JSON-encoded range intent (from a URL param).
 * Returns the intent object or null when absent/invalid.
 */
export function parseRangeIntent(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return isValidRangeIntent(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * resolveIntentToAbsolute — for client-side preview/streaming parity, turn any
 * intent into a concrete { from, to } window (relative resolves against now).
 * Returns null for an invalid intent.
 */
export function resolveIntentToAbsolute(intent, now = new Date()) {
  if (!isValidRangeIntent(intent)) return null;
  if (intent.type === 'absolute') return { from: intent.from, to: intent.to };
  return resolvePreset(intent.token, now);
}

// Prometheus caps a range query at ~11,000 points; we keep a margin below it.
export const PROM_MAX_POINTS = 10000;

/**
 * clampPromStep — raise a Prometheus step (a duration token like '1m'/'1h') so a
 * window won't exceed PROM_MAX_POINTS, mirroring the server's clamp. The step is
 * a FLOOR (only raised, never lowered). `windowMs` is the resolved window width.
 * Returns the original step when it already fits or can't be parsed.
 */
export function clampPromStep(step, windowMs) {
  const stepMs = presetDurationMs(step);
  if (!stepMs || !windowMs || windowMs <= 0) return step;
  if (windowMs / stepMs <= PROM_MAX_POINTS) return step;
  const minSecs = Math.ceil(windowMs / PROM_MAX_POINTS / 1000);
  return `${Math.max(1, minSecs)}s`;
}

export default {
  DEFAULT_RANGE_PRESETS,
  presetLabel,
  presetDurationMs,
  resolvePreset,
  isValidRangeIntent,
  parseRangeIntent,
  resolveIntentToAbsolute,
  clampPromStep,
  PROM_MAX_POINTS,
};
