// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Kiosk mode utilities.
 *
 * A kiosk is a deployment where a (typically system) user is locked
 * to a specific set of dashboards, in a specific order, via a URL
 * payload. Example URLs:
 *
 *   /view/dashboards/abc?dashboards=abc,def,ghi
 *   /view/dashboards          ?dashboards=abc,def,ghi
 *   /view/dashboards?clearKiosk=1
 *
 * Semantics:
 *
 * - `?dashboards=<id>,<id>,...` — sets the kiosk dashboard list.
 *   Order is preserved. Cached to sessionStorage under
 *   KIOSK_STORAGE_KEY so reloads without the query string keep the
 *   lock (a power glitch on a TV shouldn't lose the kiosk config).
 *
 * - `?clearKiosk=1` — explicit reset for an operator switching a
 *   kiosk to a different profile or unlocking it.
 *
 * - Neither present — fall through to sessionStorage. If that's
 *   empty too, there is no active kiosk.
 *
 * - When kiosk mode is active, callers should:
 *   - Filter the dashboard list to only the kiosk IDs.
 *   - Order it by the kiosk IDs (the URL's order is authoritative).
 *   - Disable filter controls; locking the surface is the point.
 */

const KIOSK_STORAGE_KEY = 'kiosk:dashboards';

/**
 * Parse + apply the kiosk payload from the current URL. Side effect:
 * strips the kiosk query params from the URL after reading so the
 * address bar stays clean (no double-applying on subsequent navs).
 *
 * Returns the active kiosk dashboard IDs, or `null` if no kiosk mode
 * is active for this session.
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
    const raw = params.get('dashboards');
    const ids = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) {
      writeKioskToStorage(ids);
      active = ids;
    } else {
      // `?dashboards=` with empty value clears.
      clearKiosk();
      active = null;
    }
    params.delete('dashboards');
    urlChanged = true;
  }

  if (urlChanged) {
    // history.replaceState avoids a navigation entry — the kiosk
    // lands on the same route URL, just without the consumed query
    // params, and back-button still works as the user expects.
    const cleaned = url.pathname + (params.toString() ? `?${params.toString()}` : '') + url.hash;
    window.history.replaceState(window.history.state, '', cleaned);
  }

  return active;
}

/**
 * Returns the current kiosk dashboard IDs from sessionStorage, or
 * `null` if no kiosk is active. Does not consult the URL.
 */
export function getKioskDashboardIds() {
  return readKioskFromStorage();
}

/**
 * True iff a kiosk lock is currently in effect. Cheap helper for
 * gating UI affordances.
 */
export function isKioskActive() {
  const ids = readKioskFromStorage();
  return Array.isArray(ids) && ids.length > 0;
}

/**
 * Clear the kiosk lock. Used by `?clearKiosk=1` and by any future
 * admin affordance.
 */
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
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeKioskToStorage(ids) {
  try {
    sessionStorage.setItem(KIOSK_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // sessionStorage disabled / over quota. Kiosk mode is then
    // active for the current page only — better than silently
    // dropping the lock entirely.
  }
}
