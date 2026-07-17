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
 * durationTokenToSeconds — parse a duration token (e.g. "7d", "90m", "45s",
 * "1w") to whole seconds, or null if unparseable. Same unit set as
 * presetDurationMs (s/m/h/d/w). A bare integer string is accepted as
 * seconds ("3600" → 3600) so existing raw-seconds values still parse.
 */
export function durationTokenToSeconds(token) {
  if (typeof token === 'number' && Number.isFinite(token)) return Math.round(token);
  if (typeof token !== 'string') return null;
  const t = token.trim();
  if (/^\d+$/.test(t)) return parseInt(t, 10); // bare seconds
  const ms = presetDurationMs(t);
  return ms == null ? null : Math.round(ms / 1000);
}

/**
 * secondsToDurationToken — render whole seconds as the largest CLEAN unit
 * token (e.g. 604800 → "7d", 3600 → "1h", 90 → "90s"). Falls back to a
 * seconds token when no larger unit divides evenly. Used to seed the
 * window editor field from a stored seconds value.
 */
export function secondsToDurationToken(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  const UNITS = [['w', 604800], ['d', 86400], ['h', 3600], ['m', 60], ['s', 1]];
  for (const [unit, size] of UNITS) {
    if (n % size === 0) return `${n / size}${unit}`;
  }
  return `${Math.round(n)}s`;
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

// Resolution steps offered by the dashboard range picker's step dropdown.
// Shared by every step-aware connection type — verified to parse under both
// Prometheus and ts-store (whose parser is a superset of Go's, adding d/w/mo/y).
export const STEP_PRESETS = ['15s', '30s', '1m', '5m', '15m', '1h'];

// Default step folded into a step-aware range value that carries none.
// A light pull / visual baseline; the author changes it via the dropdown.
export const DEFAULT_STEP = '1h';

// Prometheus caps a range query at ~11,000 points; we keep a margin below it.
// This is Prometheus's OWN API limit — do not borrow it for other types.
export const PROM_MAX_POINTS = 10000;

// ts-store has no server-side point cap: it serves whatever step it is given,
// so an unclamped fine step over a wide window is a very large pull (a ranged
// ts-store query raises `limit` to 100000). This budget is ours, chosen for
// chart readability rather than any upstream limit.
export const TSSTORE_MAX_POINTS = 5000;

/**
 * maxPointsForType — the point budget a connection type's step clamps against.
 * Returns null for types with no step support (no clamp applies).
 */
export function maxPointsForType(connType) {
  switch (connType) {
    case 'prometheus': return PROM_MAX_POINTS;
    case 'tsstore': return TSSTORE_MAX_POINTS;
    default: return null;
  }
}

/**
 * stepAwareRefreshMs — the effective refresh interval (ms) for a SERIES chart on
 * a step-aware range dashboard. A coarse step means the data only advances every
 * `step`, so re-firing a (potentially slow) query every `baseRefreshMs` just
 * stacks near-identical requests. We refresh at ~step/2 — the open bucket still
 * visibly refines between refreshes, but the requests stop piling up.
 *
 * ONLY ever SLOWS: returns the SLOWER of (baseRefreshMs, step/2), so a chart is
 * never sped up past the dashboard's own refresh. Returns baseRefreshMs
 * unchanged when there's no usable step (nothing to key off) or no base refresh.
 *
 * Instant tiles (gauge/number/pie) never reach here — they don't receive the
 * range, so PanelContent leaves their refresh untouched.
 */
export function stepAwareRefreshMs(baseRefreshMs, step) {
  if (!baseRefreshMs || baseRefreshMs <= 0) return baseRefreshMs;
  const stepMs = presetDurationMs(step);
  if (!stepMs || stepMs <= 0) return baseRefreshMs;
  const halfStep = Math.floor(stepMs / 2);
  return Math.max(baseRefreshMs, halfStep);
}

/**
 * clampStep — raise a step (a duration token like '1m'/'1h') so a window won't
 * exceed `maxPoints`, mirroring the server's clamp. The step is a FLOOR (only
 * raised, never lowered). `windowMs` is the resolved window width. Returns the
 * original step when it already fits, can't be parsed, or has no budget.
 *
 * Note the raised value is expressed in whole seconds (e.g. '540s') and so may
 * not be one of STEP_PRESETS — callers surface it as an *effective* step rather
 * than a dropdown selection.
 */
export function clampStep(step, windowMs, maxPoints) {
  const stepMs = presetDurationMs(step);
  if (!stepMs || !windowMs || windowMs <= 0) return step;
  if (!maxPoints || maxPoints <= 0) return step;
  if (windowMs / stepMs <= maxPoints) return step;
  const minSecs = Math.ceil(windowMs / maxPoints / 1000);
  return `${Math.max(1, minSecs)}s`;
}

/**
 * clampPromStep — Prometheus-budget wrapper over clampStep, kept for callers
 * that are Prometheus-specific by construction.
 */
export function clampPromStep(step, windowMs) {
  return clampStep(step, windowMs, PROM_MAX_POINTS);
}

export default {
  DEFAULT_RANGE_PRESETS,
  STEP_PRESETS,
  DEFAULT_STEP,
  presetLabel,
  presetDurationMs,
  resolvePreset,
  isValidRangeIntent,
  parseRangeIntent,
  resolveIntentToAbsolute,
  clampStep,
  clampPromStep,
  maxPointsForType,
  PROM_MAX_POINTS,
  TSSTORE_MAX_POINTS,
};
