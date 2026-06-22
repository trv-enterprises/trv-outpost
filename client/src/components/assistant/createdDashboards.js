// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Helpers for surfacing dashboards the Assistant created in the current
 * conversation, so the chat can offer an "Open in viewer" affordance (#117).
 *
 * The chat agent's `create_dashboard` tool returns the persisted record as
 * JSON in the tool-call `output` — top-level `id` + `name`. We read those
 * straight off the conversation's tool calls; nothing is stored separately,
 * so this stays correct after a refresh that rehydrates messages from the
 * server.
 */

// dashboardFromToolCall returns { id, name } when the tool call is a
// successful create_dashboard, else null. Tolerant of partial/garbled output
// (a failed call won't carry a valid id) so a button is only ever offered for
// a dashboard that actually exists.
export function dashboardFromToolCall(toolCall) {
  if (!toolCall || toolCall.name !== 'create_dashboard' || !toolCall.output) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(toolCall.output);
  } catch {
    return null;
  }
  // The record may be returned bare or wrapped (e.g. { dashboard: {...} }).
  const record = parsed && typeof parsed === 'object'
    ? (parsed.dashboard && typeof parsed.dashboard === 'object' ? parsed.dashboard : parsed)
    : null;
  if (!record || typeof record.id !== 'string' || !record.id) return null;
  return { id: record.id, name: typeof record.name === 'string' ? record.name : '' };
}

// createdDashboardsFromMessages walks the whole conversation in order and
// returns every dashboard the Assistant created, de-duplicated by id (the
// latest occurrence's name wins). Order is conversation order, so the last
// element is the most-recently created — used to drive the "open latest"
// primary button.
export function createdDashboardsFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const byId = new Map();
  for (const msg of messages) {
    if (!msg || !Array.isArray(msg.tool_calls)) continue;
    for (const tc of msg.tool_calls) {
      const dash = dashboardFromToolCall(tc);
      if (dash) {
        // Map preserves insertion order; deleting first keeps the re-insert
        // at the end so "latest" stays the last entry.
        byId.delete(dash.id);
        byId.set(dash.id, dash);
      }
    }
  }
  return Array.from(byId.values());
}
