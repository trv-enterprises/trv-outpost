// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * List preferences store — persists per-list UI state (view mode, sort, filters) to the user config.
 *
 * Structure in user config:
 *   settings.list_prefs = {
 *     charts:      { view: 'tile', sortKey: 'updated', sortDir: 'desc', ds: 'all', tags: [], ... },
 *     dashboards:  { view: 'list', ... },
 *     connections: { view: 'tile', ... },
 *     users:       { ... }
 *   }
 *
 * Uses localStorage as a cache for instant render, then syncs with the server in the background.
 * Writes debounce and batch — changes are flushed to the server after 500ms of inactivity.
 */

import apiClient from '../api/client';

const STORAGE_KEY = 'dashboard_list_prefs';
const DEBOUNCE_MS = 500;

// In-memory cache (populated from localStorage on first use, kept in sync with server)
let cache = null;
let flushTimer = null;
let pendingWrite = false;

function loadCache() {
  if (cache !== null) return cache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    cache = raw ? JSON.parse(raw) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function persistLocal() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore quota errors
  }
}

/**
 * Fetch the user's list prefs from the server and merge into the local cache.
 * Call once on app load to hydrate from persistent storage.
 */
export async function hydrateListPrefs() {
  const userGuid = apiClient.getCurrentUserGuid();
  if (!userGuid) return;
  try {
    const config = await apiClient.getUserConfig(userGuid);
    const serverPrefs = config?.settings?.list_prefs;
    if (serverPrefs && typeof serverPrefs === 'object') {
      // Server wins for any keys it has; merge to preserve any local-only keys
      cache = { ...loadCache(), ...serverPrefs };
      persistLocal();
    }
  } catch (err) {
    console.warn('[listPrefs] Failed to hydrate from user config:', err.message);
  }
}

function scheduleFlush() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushToServer, DEBOUNCE_MS);
}

async function flushToServer() {
  flushTimer = null;
  if (pendingWrite) return; // A write is already in flight; new one will fire on its completion
  const userGuid = apiClient.getCurrentUserGuid();
  if (!userGuid) return;

  pendingWrite = true;
  const snapshot = { ...loadCache() };
  try {
    await apiClient.updateUserConfig(userGuid, { list_prefs: snapshot });
  } catch (err) {
    console.warn('[listPrefs] Failed to persist to user config:', err.message);
  } finally {
    pendingWrite = false;
  }
}

/**
 * Get preferences for a list page.
 * @param {string} listKey - Unique identifier for the list (e.g., 'charts', 'dashboards')
 * @returns {object} Stored prefs or empty object
 */
export function getListPrefs(listKey) {
  const data = loadCache();
  return data[listKey] || {};
}

/**
 * Update preferences for a list page. Merges with existing keys.
 * Persists to localStorage immediately and schedules a debounced server sync.
 * @param {string} listKey - Unique identifier for the list
 * @param {object} updates - Partial pref updates to merge
 */
export function setListPrefs(listKey, updates) {
  const data = loadCache();
  data[listKey] = { ...(data[listKey] || {}), ...updates };
  persistLocal();
  scheduleFlush();
}

export default {
  hydrateListPrefs,
  getListPrefs,
  setListPrefs
};
