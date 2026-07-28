// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Helpers shared by the "duplicate" actions on the dashboards, components and
 * connections lists, and by the "create duplicate" option in the dashboard
 * editor's component picker.
 *
 * All duplication is composed client-side (fetch the source, POST a create) —
 * there is no server-side duplicate endpoint. These helpers exist so the four
 * call sites agree on the copy-name convention and on which fields are safe to
 * carry into a new record.
 */

// Backend sentinel returned on GET for "a secret is set but not exposed".
// Must match server-go/internal/models/connection.go `SecretMaskedValue` and
// the SECRET_MASKED_VALUE re-exported by components/shared/SecretTextInput —
// declared here rather than imported so this module stays free of React
// component dependencies.
const SECRET_MASKED_VALUE = '********';

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

/**
 * Recursively replace any masked-secret sentinel ("********") with an empty
 * string. The backend never sends real secret values to the frontend — it masks
 * them — so a connection fetched for duplication carries masks where
 * credentials were set. A create saves config verbatim, so leaving the masks in
 * would persist the literal "********" as the secret. Scrubbing the sentinel
 * clears exactly the secret fields, regardless of connection type.
 */
export function scrubMaskedSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubMaskedSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = scrubMaskedSecrets(value[k]);
    return out;
  }
  return value === SECRET_MASKED_VALUE ? '' : value;
}

/**
 * Build the create payload for a connection duplicate. Carries description,
 * tags, namespace and BOTH type shapes: the registry pair (type_id/type_config,
 * preferred) and the legacy pair (type/config). Dropping type_id would silently
 * demote a registry-based connection to the legacy path, so both are forwarded
 * exactly as the source had them — `models.CreateConnectionRequest` marks each
 * omitempty and prefers type_id when present.
 *
 * Secrets are scrubbed (see scrubMaskedSecrets) so the copy is saved without
 * credentials and the user re-enters them. Only `config` is masked server-side
 * (Connection.sanitize never touches type_config), but both are scrubbed anyway
 * — a stray sentinel is never a value worth persisting.
 *
 * @returns {{payload: object, droppedSecrets: boolean}} droppedSecrets is true
 *   when the source had at least one masked secret, so callers can tell the
 *   user the copy needs credentials before it will connect.
 */
export function buildConnectionCopy(connection, existingNames = []) {
  const sourceConfig = connection.config || {};
  const scrubbedConfig = scrubMaskedSecrets(sourceConfig);
  const scrubbedTypeConfig = connection.type_config
    ? scrubMaskedSecrets(connection.type_config)
    : undefined;
  const droppedSecrets =
    JSON.stringify(sourceConfig) !== JSON.stringify(scrubbedConfig) ||
    JSON.stringify(connection.type_config) !== JSON.stringify(scrubbedTypeConfig);

  const payload = {
    namespace: connection.namespace || 'default',
    name: buildCopyName(connection.name || 'Connection', existingNames),
    description: connection.description || '',
    config: scrubbedConfig,
    tags: connection.tags || [],
  };
  // Forward each optional field only when the source had it, so an absent
  // type_id doesn't post an empty string the server would treat as set.
  if (connection.type) payload.type = connection.type;
  if (connection.type_id) payload.type_id = connection.type_id;
  if (scrubbedTypeConfig) payload.type_config = scrubbedTypeConfig;
  if (connection.supported_schemas) payload.supported_schemas = connection.supported_schemas;
  // A legacy connection with neither type nor type_id can't be created; fall
  // back to the same default the editor uses.
  if (!payload.type && !payload.type_id) payload.type = 'sql';

  return { droppedSecrets, payload };
}
