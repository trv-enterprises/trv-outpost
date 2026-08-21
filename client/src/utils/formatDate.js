// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * formatDate — the list-view timestamp format: local date + local time.
 *
 * Six components had grown their own copy of this (ConnectionsPage,
 * ComponentsListPage, DashboardsListPage, UsersListPage, ApiKeysListPage,
 * DashboardTile). Four were byte-identical; ApiKeysListPage's additionally
 * guarded an unparseable value, which is the version kept here — a bad
 * timestamp should render as a dash, not "Invalid Date".
 *
 * Existing call sites are deliberately NOT migrated in the change that
 * introduced this file; they render correctly and rewriting six components
 * to prove a point is not worth the review surface. New code uses this.
 *
 * @param {string|number|Date} value  timestamp (ISO string, epoch, or Date)
 * @param {string} [empty='N/A']      what to render for missing/unparseable
 * @returns {string}
 */
export function formatDate(value, empty = 'N/A') {
  if (!value) return empty;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return empty;
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

export default formatDate;
