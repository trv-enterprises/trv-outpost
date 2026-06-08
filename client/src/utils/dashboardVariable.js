// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * dashboardUsesVariable — true when a dashboard has the dashboard-variable
 * feature turned on AND has at least one variable defined. This is the
 * self-contained per-dashboard signal used to badge a dashboard in list /
 * tile surfaces (the `var` indicator), distinct from the deployment-wide
 * feature gate that `useDashboardVariable` also checks at view time.
 *
 * Mirrors the storage shape: `dashboard.settings.variables_enabled` plus a
 * non-empty `dashboard.settings.variables` array (see the Dashboard model
 * and `useDashboardVariable`).
 *
 * @param {object} dashboard  a dashboard record (may be undefined)
 * @returns {boolean}
 */
export function dashboardUsesVariable(dashboard) {
  const settings = dashboard?.settings || {};
  if (!settings.variables_enabled) return false;
  const list = Array.isArray(settings.variables) ? settings.variables : [];
  return list.some((v) => v && v.mode);
}
