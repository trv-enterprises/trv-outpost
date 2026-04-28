// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * orderDashboardsForViewer
 *
 * Returns dashboards arranged in the order the user expects to see
 * them — same algorithm used by the View Mode tile page so that
 * navigating with the prev/next arrows in the dashboard viewer
 * matches the visible tile order on the listing page.
 *
 * Resolution:
 *   1. Default — most-recently-updated first.
 *   2. If tileOrder is supplied (array of dashboard IDs the user has
 *      pinned via drag-and-drop), pinned dashboards keep the user's
 *      chosen sequence. Unpinned (new-to-the-user) dashboards come
 *      FIRST so a freshly-created one is the first thing they
 *      notice.
 *
 * Mirrors the inline algorithm in DashboardTileViewPage's
 * filteredDashboards memo. Keep in sync if you change one.
 *
 * @param {Array<{id: string, updated?: string, created?: string}>} dashboards
 *   Full dashboard list from `/api/dashboards`.
 * @param {Array<string> | null | undefined} tileOrder
 *   Stored at `app_config.user.<guid>.settings.dashboard_tile_order`.
 *   Null/undefined/empty → no manual ordering, use the default sort.
 * @returns {Array} New array — the input is not mutated.
 */
export function orderDashboardsForViewer(dashboards, tileOrder) {
  const result = [...(dashboards || [])];

  // Default: newest-updated first.
  result.sort((a, b) => {
    const aT = new Date(a.updated || a.created || 0).getTime();
    const bT = new Date(b.updated || b.created || 0).getTime();
    return bT - aT;
  });

  if (!tileOrder || tileOrder.length === 0) {
    return result;
  }

  const orderIdx = new Map(tileOrder.map((id, i) => [id, i]));
  const pinned = [];
  const unpinned = [];
  for (const d of result) {
    if (orderIdx.has(d.id)) pinned.push(d);
    else unpinned.push(d);
  }
  pinned.sort((a, b) => orderIdx.get(a.id) - orderIdx.get(b.id));
  return [...unpinned, ...pinned];
}
