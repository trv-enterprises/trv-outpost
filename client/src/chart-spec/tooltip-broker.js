// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * One-tooltip-at-a-time broker for chart tooltips.
 *
 * Every ECharts instance owns its OWN tooltip <div>, and with `appendToBody`
 * those divs all live on document.body, floating over the whole page. Nothing
 * in ECharts coordinates them: chart A can be showing its tooltip while the
 * pointer is over chart B showing its own. The user sees a stale readout stuck
 * to the first chart they touched, which is exactly the reported symptom
 * ("cannot switch to another chart's point").
 *
 * Per-chart pointerleave handles the common case, but it races: if B's tooltip
 * renders before A's leave handler runs, both are briefly up — and a fast
 * diagonal move between panels can skip the leave entirely.
 *
 * So make it explicit. Each mounted chart registers a hide function. When any
 * chart shows a tooltip it claims ownership, and every OTHER registered chart
 * is told to hide. Nothing here reaches into ECharts internals; the hide
 * function each chart supplies just dispatches its own `hideTip`.
 *
 * Module-level state is correct here — "which chart owns the tooltip" is a
 * genuinely global question about the page, not per-subtree, and the set is
 * keyed on identities that unregister on unmount.
 */

/** @type {Set<() => void>} every mounted chart's hide function */
const hiders = new Set();

/** The hide function of the chart currently showing a tooltip, if any. */
let owner = null;

/**
 * Register a chart's hide function. Returns an unregister callback for the
 * effect cleanup — without it a hider would outlive its chart and dispatch
 * into a disposed ECharts instance.
 */
export function registerTooltipOwner(hide) {
  hiders.add(hide);
  return () => {
    hiders.delete(hide);
    if (owner === hide) owner = null;
  };
}

/**
 * Claim the tooltip for `hide`'s chart, hiding every other chart's.
 * Cheap enough to call on every mousemove: the common case is that `owner`
 * is already this chart and we return immediately without touching the set.
 */
export function claimTooltip(hide) {
  if (owner === hide) return;
  owner = hide;
  for (const other of hiders) {
    if (other !== hide) other();
  }
}

/**
 * Release the tooltip for `hide`'s chart (pointer left it, or it scrolled
 * away). Only clears ownership when this chart actually holds it, so a late
 * leave from a chart the user already moved off cannot blank the new owner.
 */
export function releaseTooltip(hide) {
  if (owner === hide) owner = null;
}

/** Hide every chart's tooltip. Used for page-level events like scroll. */
export function hideAllTooltips() {
  owner = null;
  for (const hide of hiders) hide();
}

// Test seam only — the module-level state would otherwise leak between cases.
export function __resetTooltipBroker() {
  hiders.clear();
  owner = null;
}
