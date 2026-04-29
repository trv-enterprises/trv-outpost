// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Session-level cache for the shared tag pool. The cache holds a Promise
 * so callers that race on first load all share the same in-flight fetch.
 * On error the cache is cleared so the next call retries.
 *
 * Call `invalidateTagsCache()` after any create/update that may have added
 * or removed a tag so the next TagInput / TagFilter mount picks up the
 * fresh pool. This is especially important when editing inside modals:
 * ComponentEditor inside ComponentEditorModal uses a `key` bump to remount on
 * every open, so invalidating here is sufficient.
 */
let cache = null;

/**
 * Fetch the merged tag list for all entity types. Returns the raw
 * `{ tags: [{name, count, connections, components, dashboards}, ...] }`
 * response from GET /api/tags.
 */
export function getAllTagsCached(apiClient) {
  if (!cache) {
    cache = apiClient.getAllTags().catch((err) => {
      cache = null;
      throw err;
    });
  }
  return cache;
}

/**
 * Drop the cached response. Call after any entity create/update so the
 * next TagInput / TagFilter mount picks up the new tag pool.
 */
export function invalidateTagsCache() {
  cache = null;
}

/**
 * Client-side mirror of the backend NormalizeTags function.
 * Lowercases, trims, replaces internal whitespace with "-", drops empties.
 * Used by TagInput to preview what the server will actually store when
 * the user types a new tag.
 */
export function normalizeTag(input) {
  if (typeof input !== 'string') return '';
  // Lowercase → split on any whitespace → join with "-".
  return input.toLowerCase().trim().split(/\s+/).filter(Boolean).join('-');
}
