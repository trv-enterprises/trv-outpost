// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Helpers shared by the "duplicate" actions on the dashboards, components and
 * connections lists, and by the "create duplicate" option in the dashboard
 * editor's component picker.
 *
 * Dashboards and components duplicate client-side (fetch the source, POST a
 * create) — everything they carry is readable by the browser. CONNECTIONS DO
 * NOT: the API masks secrets as "********" on read, so a client-side copy could
 * only produce a credential-less record. That one goes through
 * POST /api/connections/:id/duplicate, which copies secrets server-side; the
 * client supplies only the name (see buildCopyName).
 */

/**
 * Build a non-colliding copy name: "<base> (copy)", bumping to "(copy 2)",
 * "(copy 3)", … while the candidate is in `existingNames`.
 *
 * Name uniqueness is per (namespace, name) and `existingNames` is only what the
 * caller has loaded, so a server-side 409 is still possible on a paginated
 * list. Callers surface that error rather than retrying.
 *
 * @param {string} base - source record name
 * @param {Iterable<string>} existingNames - names already known to be taken
 * @returns {string}
 */
export function buildCopyName(base, existingNames = []) {
  const taken = existingNames instanceof Set ? existingNames : new Set(existingNames);
  const root = base || 'Untitled';
  let candidate = `${root} (copy)`;
  for (let n = 2; taken.has(candidate); n += 1) candidate = `${root} (copy ${n})`;
  return candidate;
}

/**
 * Strip identity, version, draft-session, timestamp and usage fields from a
 * component record so what remains can be POSTed as a brand-new component.
 * Field names track `models.Component`'s json tags.
 *
 * @param {object} component - full component as returned by GET /api/components/:id
 * @returns {object} seed suitable for apiClient.createComponent
 */
export function buildComponentCopy(component, existingNames = []) {
  const {
    id: _id, version: _version, status: _status, ai_session_id: _aiSessionId,
    created: _created, updated: _updated,
    // Usage/read-only decorations from the list endpoints (ComponentWithUsage)
    // — never part of a create payload.
    dashboard_usage: _dashboardUsage, dashboard_count: _dashboardCount,
    has_unauthorized_deps: _hasUnauthorizedDeps,
    version_count: _versionCount, has_draft: _hasDraft,
    ...seed
  } = component;
  return { ...seed, name: buildCopyName(component.name || 'Component', existingNames) };
}
