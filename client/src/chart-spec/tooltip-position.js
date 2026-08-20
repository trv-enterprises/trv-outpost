// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

/**
 * Tooltip placement for chart tooltips.
 *
 * ECharts' built-in placement (`refixTooltipPosition`) only ever FLIPS
 * horizontally: put the box to the right of the cursor, or — if that would
 * overflow — to the left. It never clamps, and it never falls back to
 * placing the box ABOVE or BELOW. So when the tooltip is wider than the
 * space on either side of the cursor (a wide multi-series readout on a
 * mid-width panel, cursor near the middle), BOTH options overflow and the
 * left flip pushes x negative — the box hangs off the edge and the series
 * names are cut off ("dashboard-caddy-1" reads as "hboard-caddy-1").
 *
 * There is no combination of built-in options that fixes this. `confine`
 * would clamp, but confine and `appendToBody` are mutually exclusive:
 * appendToBody makes the tooltip's coords PAGE-relative while confine
 * clamps against the CHART's box, so setting both pins the tooltip and
 * breaks pointer tracking. We need appendToBody (it's what lets the tooltip
 * escape the panel's overflow:hidden), so placement is ours to do.
 *
 * Strategy, in order:
 *   1. Right of the cursor, if it fits.
 *   2. Left of the cursor, if THAT fits.
 *   3. Neither side fits → go VERTICAL: above the cursor if there's room,
 *      else below. Horizontally centre on the cursor, then clamp into view.
 *   4. Whatever we chose, clamp both axes so the box is never off-screen.
 *      Clamping is the backstop, not the strategy — a clamped box can cover
 *      the cursor, which is why vertical placement is tried first.
 *
 * Coordinates here are CHART-LOCAL (what ECharts passes the callback and
 * what it expects back), so `viewSize` is the right frame of reference even
 * though the DOM node lives in document.body.
 */

// Gap between the cursor and the tooltip box, matching ECharts' own 20px.
const GAP = 20;

/**
 * @param {number[]} point        [x, y] cursor, chart-local
 * @param {object}   _params      series params (unused)
 * @param {Element}  _dom         tooltip element (unused)
 * @param {object}   _rect        anchor rect (unused; axis-trigger passes null)
 * @param {{viewSize: number[], contentSize: number[]}} size
 * @returns {number[]} [x, y] chart-local top-left for the tooltip box
 */
export function positionTooltip(point, _params, _dom, _rect, size) {
  const [cx, cy] = point || [0, 0];
  const [vw, vh] = (size && size.viewSize) || [0, 0];
  const [tw, th] = (size && size.contentSize) || [0, 0];

  // Degenerate inputs (no measurements yet) — let ECharts' default stand by
  // returning the cursor position unchanged rather than computing nonsense.
  if (!vw || !vh || !tw || !th) return [cx + GAP, cy + GAP];

  const fitsRight = cx + GAP + tw <= vw;
  const fitsLeft = cx - GAP - tw >= 0;

  let x;
  let y;

  if (fitsRight || fitsLeft) {
    // Prefer the right (matches ECharts' default feel); use the left only
    // when the right would overflow.
    x = fitsRight ? cx + GAP : cx - GAP - tw;
    // Vertically, sit just below the cursor unless that overflows.
    y = cy + GAP + th <= vh ? cy + GAP : cy - GAP - th;
  } else {
    // Neither side fits — this is the case ECharts gets wrong. Place the box
    // ABOVE the cursor (preferred: it leaves the plot below visible) or below
    // when there isn't room, and centre it horizontally on the cursor.
    x = cx - tw / 2;
    const fitsAbove = cy - GAP - th >= 0;
    y = fitsAbove ? cy - GAP - th : cy + GAP;
  }

  // Final clamp so the box is always fully on-screen, whichever branch ran.
  x = Math.max(0, Math.min(x, vw - tw));
  y = Math.max(0, Math.min(y, vh - th));
  return [x, y];
}

export default positionTooltip;
