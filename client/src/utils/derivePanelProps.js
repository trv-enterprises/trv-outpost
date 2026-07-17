// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * derivePanelProps — the per-panel data derivation shared by every render
 * path that turns a stored panel record into the props <PanelContent> needs.
 *
 * This logic used to live inline in DashboardGrid's panels.map(). It's now a
 * pure function so the mobile viewer (which renders <PanelContent> in a
 * vertical stack instead of the cell grid) derives the same values without
 * copy-pasting the grid's body. Keep it layout-agnostic: only the data/
 * authorization/refresh derivation lives here. Layout-specific concerns
 * (the "stretch" gauge counter-transform, expand-on-double-click eligibility,
 * grid-cell positioning) stay in the caller — they don't apply to a mobile
 * stack and shouldn't be dragged along.
 *
 * @param {object} panel  the stored panel record ({ id, x, y, w, h,
 *   component_id?, text_config? })
 * @param {object} opts
 * @param {object} opts.chartsMap  component_id → component record
 * @param {function} [opts.resolveComponent]  panel → effective component_id
 *   (component-swap rules); falls back to panel.component_id when absent.
 * @param {object} [opts.unauthorizedComponents]  component_id → "component" |
 *   "connection" for panels the viewer can't see (#4). Empty for unrestricted.
 * @param {object} [opts.dashboard]  dashboard record (read for
 *   settings.refresh_interval).
 * @param {number|null} [opts.dataRefreshInterval]  explicit override in ms;
 *   when provided it wins over the dashboard's own interval.
 * @param {boolean} [opts.editMode]  when true, the dashboard refresh interval
 *   is suppressed (no auto-refresh while designing). Mobile passes false.
 * @returns {{ effectiveComponentId, chart, unauthorizedReason, hasText,
 *   hasChart, hasContent, effectiveRefreshInterval }}
 */
export function derivePanelProps(panel, {
  chartsMap = {},
  resolveComponent = null,
  unauthorizedComponents = {},
  dashboard = null,
  dataRefreshInterval = null,
  editMode = false,
} = {}) {
  // Effective component for this panel: a component-swap rule may pick an
  // alternate component_id based on the active variable; otherwise the panel's
  // own component_id. The resolved id must be in chartsMap (override components
  // are pre-fetched by the caller).
  const effectiveComponentId = resolveComponent
    ? resolveComponent(panel)
    : panel.component_id;
  const chart = effectiveComponentId ? chartsMap[effectiveComponentId] : null;

  // #4: the caller can't see this panel's component or its connection — the
  // render shows an "unauthorized" error panel instead of a blank one.
  // Reason: "component" | "connection".
  const unauthorizedReason = effectiveComponentId
    ? (unauthorizedComponents[effectiveComponentId] || null)
    : null;

  const hasText = !!panel.text_config;
  // A panel has chart content when its component is a chart, control, or
  // display. Spec-driven charts (use_custom_code=false) carry an EMPTY
  // component_code — the render is synthesized from chart_type + data_mapping
  // by the loader — so we must NOT gate on component_code. The legacy
  // `!!chart.component_code` term remains as a fallback for records that
  // predate component_type being set.
  const hasChart = !hasText && (
    chart?.component_type === 'chart'
    || chart?.component_type === 'control'
    || chart?.component_type === 'display'
    || !!chart?.component_code
  );
  const hasContent = hasText || hasChart;

  // View mode polls at the dashboard's refresh interval; edit mode passes null
  // (no auto-refresh while designing). An explicit dataRefreshInterval wins.
  const effectiveRefreshInterval = dataRefreshInterval != null
    ? dataRefreshInterval
    : (!editMode && dashboard?.settings?.refresh_interval > 0
      ? dashboard.settings.refresh_interval * 1000
      : null);

  return {
    effectiveComponentId,
    chart,
    unauthorizedReason,
    hasText,
    hasChart,
    hasContent,
    effectiveRefreshInterval,
  };
}

export default derivePanelProps;
