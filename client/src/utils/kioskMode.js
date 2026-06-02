// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Kiosk mode utilities.
 *
 * A kiosk is a deployment where a (typically system) user is locked to an
 * ordered list of dashboards, shown on a chromeless status-board surface
 * (/kiosk), optionally auto-rotating. Each ENTRY is a dashboard plus an optional
 * dashboard-variable selection (v1: a connection — the connection-swap feature),
 * and the SAME dashboard may appear multiple times with different connections
 * (e.g. system-stats@SRV-001 → @PI-001 → @SRV-002).
 *
 * URL payload (all on the /kiosk route, or legacy on /view):
 *
 *   ?dashboards=<entry>,<entry>,...   ordered entry list (see entry syntax)
 *   ?rotate=<seconds>                 auto-advance interval; absent/0 = manual
 *   ?show-notifications=T|F           passive incoming-alert toasts (default F)
 *   ?show-pinned=T|F                  show globally-pinned alerts (default F)
 *   ?clearKiosk=1                     explicit reset
 *
 * Entry syntax (compact, backward-compatible):
 *
 *   <dashboardId>                      no variable (legacy flat list)
 *   <dashboardId>:connection=<connId>  pre-select connection-swap to <connId>
 *   <dashboardId>:<vartype>=<value>    generic — forward-compat (only
 *                                      `connection` is honored today)
 *
 * Parsed config shape (also the sessionStorage cache shape):
 *
 *   {
 *     entries: [{ dashboardId, variable: { type, value } | null }],
 *     rotateSeconds: number,        // 0 = no auto-rotate
 *     showNotifications: boolean,
 *     showPinned: boolean,
 *   }
 *
 * Semantics:
 * - The URL is authoritative; it's parsed, cached to sessionStorage, and the
 *   query params are stripped so the address bar stays clean.
 * - Neither `dashboards` nor cache present → no active kiosk (null).
 * - `?dashboards=` with empty value, or `?clearKiosk=1`, clears the kiosk.
 */

const KIOSK_STORAGE_KEY = 'kiosk:dashboards';

function parseBoolFlag(raw, fallback) {
  if (raw == null) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v === 't' || v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'f' || v === 'false' || v === '0' || v === 'no' || v === '') return false;
  return fallback;
}

/**
 * Parse the `dashboards` param value into entry objects. Each comma-separated
 * token is a dashboardId with an optional `:vartype=value` suffix.
 */
function parseEntries(raw) {
  return (raw || '')
    .split(',')
    .map((tok) => tok.trim())
    .filter(Boolean)
    .map((tok) => {
      const colon = tok.indexOf(':');
      if (colon === -1) {
        return { dashboardId: tok, variable: null };
      }
      const dashboardId = tok.slice(0, colon).trim();
      const spec = tok.slice(colon + 1).trim(); // e.g. "connection=<connId>"
      const eq = spec.indexOf('=');
      if (!dashboardId) return null;
      if (eq === -1) {
        // malformed suffix — treat as a plain id
        return { dashboardId, variable: null };
      }
      const type = spec.slice(0, eq).trim();
      const value = spec.slice(eq + 1).trim();
      if (!type || !value) return { dashboardId, variable: null };
      return { dashboardId, variable: { type, value } };
    })
    .filter(Boolean);
}

/**
 * Parse + apply the kiosk payload from the current URL. Side effect: strips the
 * consumed kiosk query params via history.replaceState.
 *
 * Returns the active kiosk config object, or `null` if no kiosk is active.
 */
export function syncKioskFromUrl() {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const params = url.searchParams;

  let active = readKioskFromStorage();
  let urlChanged = false;

  if (params.has('clearKiosk')) {
    clearKiosk();
    active = null;
    params.delete('clearKiosk');
    urlChanged = true;
  }

  if (params.has('dashboards')) {
    const entries = parseEntries(params.get('dashboards'));
    if (entries.length > 0) {
      const config = {
        entries,
        rotateSeconds: parseRotate(params.get('rotate')),
        showNotifications: parseBoolFlag(params.get('show-notifications'), false),
        showPinned: parseBoolFlag(params.get('show-pinned'), false),
      };
      writeKioskToStorage(config);
      active = config;
    } else {
      // `?dashboards=` with empty value clears.
      clearKiosk();
      active = null;
    }
    params.delete('dashboards');
    params.delete('rotate');
    params.delete('show-notifications');
    params.delete('show-pinned');
    urlChanged = true;
  }

  if (urlChanged) {
    const cleaned = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
    window.history.replaceState(window.history.state, '', cleaned);
  }

  return active;
}

function parseRotate(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Returns the current kiosk config from sessionStorage, or `null` if no kiosk
 * is active. Does not consult the URL.
 */
export function getKioskConfig() {
  return readKioskFromStorage();
}

/**
 * Flat list of the kiosk's dashboard IDs (derived from entries), or `null`.
 * Kept for callers that only need the id set; new callers should use
 * getKioskConfig() for the full entry/flag data.
 */
export function getKioskDashboardIds() {
  const config = readKioskFromStorage();
  if (!config) return null;
  return config.entries.map((e) => e.dashboardId);
}

/** True iff a kiosk lock is currently in effect. */
export function isKioskActive() {
  const config = readKioskFromStorage();
  return !!config && Array.isArray(config.entries) && config.entries.length > 0;
}

/** Clear the kiosk lock. */
export function clearKiosk() {
  try {
    sessionStorage.removeItem(KIOSK_STORAGE_KEY);
  } catch {
    // sessionStorage disabled — nothing to clear.
  }
}

function readKioskFromStorage() {
  try {
    const raw = sessionStorage.getItem(KIOSK_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);

    // Back-compat: old cache was a flat array of id strings. Migrate to the
    // entry/config shape on read.
    if (Array.isArray(parsed)) {
      if (parsed.length === 0) return null;
      return {
        entries: parsed.map((id) => ({ dashboardId: id, variable: null })),
        rotateSeconds: 0,
        showNotifications: false,
        showPinned: false,
      };
    }

    if (parsed && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      return {
        entries: parsed.entries,
        rotateSeconds: parsed.rotateSeconds || 0,
        showNotifications: !!parsed.showNotifications,
        showPinned: !!parsed.showPinned,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writeKioskToStorage(config) {
  try {
    sessionStorage.setItem(KIOSK_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // sessionStorage disabled / over quota — kiosk active for this page only.
  }
}
