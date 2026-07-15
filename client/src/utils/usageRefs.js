// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Namespace-authorization redaction (#4).
 *
 * A usage ref from the server (component_usage / connection_usage /
 * dashboard_usage) is either a normal {id, name[, namespace]} entry or
 * an opaque {unauthorized: true, kind} placeholder for an entity in a
 * namespace the caller can't see. Map both shapes to the {id, label}
 * form CountListPopover consumes, carrying the redaction flags through
 * so the popover renders a non-clickable red "Unauthorized <Kind>"
 * row.
 *
 * @param {Array} refs  server usage refs
 * @returns {Array} CountListPopover items
 */
export function toUsageItems(refs) {
  return (refs || []).map((ref) => (
    ref.unauthorized
      ? { unauthorized: true, kind: ref.kind }
      : { id: ref.id, label: ref.name }
  ));
}
