// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

import PropTypes from 'prop-types';
import './AdornmentLayer.scss';

// Grid geometry — MUST match DashboardGrid.jsx (and server-go
// internal/registry/catalog.go). See adornmentRect below for why this
// layer needs the raw numbers rather than reading a computed style.
const CELL_WIDTH = 32;
const CELL_HEIGHT = 32;
const GAP = 4;

/**
 * adornmentRect — cell rect → native px, hugging the panels and growing
 * OUTWARD into the gutter.
 *
 * A panel at cell {x,y,w,h} occupies:
 *   left = x * stride               right = x * stride + w*CELL + (w-1)*GAP
 * where stride = CELL + GAP. So the content box of the whole cell rect is
 * [x*stride, x*stride + w*stride - GAP].
 *
 * `width`/`height` are that box exactly, and `left`/`top` are shifted up-and-
 * left by the line width. With `box-sizing: content-box` the border is added
 * OUTSIDE the given width, so the line occupies
 * [x*stride - lineWidth, x*stride] — flush against the panel edge, extending
 * away into the gutter — and panel content is never covered, at any width.
 *
 * The offset is the part that is easy to lose. `content-box` alone is not
 * enough: `left`/`top` anchor the element's BORDER box, so without the shift
 * the line's outer edge lands on the panel's edge and the whole line paints
 * inward across the panel. Measured in the browser, that showed up as the
 * element's left edge sitting exactly at the layer's left edge (offset 0)
 * instead of -lineWidth.
 *
 * Equally, do not re-expand `width` by 2*lineWidth "to make room". Under
 * content-box the border is already additive, so that double-counts and the
 * box overshoots its panels on the right/bottom.
 *
 * Why outward rather than centered: the gutter is 4px, so growing outward
 * lets TWO adjacent boxes each take 2px of the same gutter without
 * overlapping — box A's right border sits in the gutter's inner half, box
 * B's left border in the outer half. A centered line would put both on the
 * same centerline and they'd collide.
 *
 * Widths above 2px consume more than half the gutter, so two adjacent boxes
 * at 3px or 4px will overlap each other. That is the author's call — the
 * geometry no longer forces it.
 *
 * These are NATIVE px. The layer is a child of `.dashboard-grid`, which is
 * the element the fit-mode transform scales — so the browser scales the
 * adornment along with the panels for free, in every fit mode and at any
 * edit zoom. No transform math belongs here.
 */
export function adornmentRect(a) {
  const stride = CELL_WIDTH + GAP;
  const strideY = CELL_HEIGHT + GAP;
  const line = a.width || 2;

  // The panels' footprint, shifted UP-AND-LEFT by the line width.
  //
  // With `box-sizing: content-box`, `width`/`height` describe the CONTENT
  // box and the border is added outside it — so the element's total footprint
  // is content + 2*line. But `left`/`top` still anchor the element's border
  // box, so a bare `left: x*stride` puts the line's outer edge at the panel's
  // edge and paints the whole line INWARD across the panel. Subtracting the
  // line width moves that outer edge into the gutter, leaving the line's
  // inner edge flush against the panel — which is the whole point.
  //
  // Net effect at column 0: left = -line, so the line occupies [-line, 0] —
  // outside the grid box entirely, in the container's padding.
  //
  // Two things must stay true together, or the line lands back on the panel:
  // this offset, and `content-box` (with `border-box` the width would absorb
  // the border instead of adding to it).
  return {
    left: a.x * stride - line,
    top: a.y * strideY - line,
    width: a.w * stride - GAP,
    height: a.h * strideY - GAP,
  };
}

/**
 * AdornmentLayer — renders the dashboard's visual decorations (currently
 * border boxes) as absolutely-positioned overlays above the panels.
 *
 * It is a SIBLING of the panels inside `.dashboard-grid`, never a child of
 * a `.panel-container`. That matters twice over: `.panel-container` sets
 * `overflow: hidden`, which would clip a border drawn inside it; and being
 * a sibling means a panel moved onto an adornment merely overlaps it —
 * there is no stored relationship to invalidate or repair.
 *
 * Adornments render ABOVE panel bodies by design. A panel dragged onto a
 * border therefore draws the line over the panel edge, which is visible and
 * obviously wrong. The alternative (below panels) lets the panel's opaque
 * background silently swallow that segment, so the box renders with a gap
 * in it and reads as a rendering bug instead of a layout mistake.
 *
 * In view mode the layer is inert (`pointer-events: none`) so it can never
 * intercept a click meant for a chart. The editor turns pointer events back
 * on only while adornment mode is active.
 *
 * Even then, only the border BAND is hittable — never the interior. The
 * element is a full rect, so a solid hit target would swallow every click
 * inside it, making it impossible to draw a nested box or select anything
 * the border surrounds. The interior therefore stays `pointer-events: none`
 * and the edges are covered by hit strips (see `edgeHitStrips`), so clicks
 * in the middle fall through to the grid underneath.
 */
function AdornmentLayer({
  adornments,
  interactive = false,
  selectedId = null,
  onSelect = null,
  renderChrome = null,
}) {
  if (!adornments || adornments.length === 0) return null;

  return (
    <div className={`adornment-layer ${interactive ? 'is-interactive' : ''}`}>
      {adornments.map((a) => {
        const rect = adornmentRect(a);
        const isSelected = interactive && selectedId === a.id;

        return (
          <div
            key={a.id}
            className={`adornment adornment--${a.kind || 'border'} ${isSelected ? 'is-selected' : ''}`}
            style={{
              left: `${rect.left}px`,
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              height: `${rect.height}px`,
              borderStyle: a.line_style || 'solid',
              borderWidth: `${a.width || 2}px`,
              // Carbon red50 — matches ADORNMENT_DEFAULT_COLOR in
              // DashboardViewerPage. Distinct from the blue edit chrome.
              borderColor: a.color || '#fa4d56',
            }}
            onMouseDown={
              interactive && onSelect
                ? (e) => {
                    // A SHIFT press is always the grid's extend gesture, never
                    // a move or resize. Let it fall through untouched.
                    //
                    // This matters most on a small border: the edge strips
                    // (9px) and grips (10px) together cover essentially all of
                    // a 1x1 box (~36px), so without this a shift-click on the
                    // seed box you just created can never reach the grid — the
                    // chrome swallows it and starts a resize instead. Shift is
                    // unambiguous, so there is nothing to disambiguate here.
                    if (e.shiftKey) return;
                    // Likewise the second press of a DOUBLE-click: that's the
                    // grid's shrink gesture. Starting a resize on it would
                    // both fight the shrink and, on a small box, make the
                    // gesture unreachable for the same coverage reason.
                    if (e.detail >= 2) return;
                    // Only edge strips and grips are hittable — a mousedown
                    // reaching here came from one of them. Claim it so it
                    // never reaches the grid's draw-new handler underneath.
                    e.stopPropagation();
                    onSelect(a, e);
                  }
                : undefined
            }
          >
            {/* Edge hit strips — the ONLY hittable part of an unselected
                border. Rendered always (not just when selected) so a border
                can be picked up by its edge on the first click. The interior
                stays transparent to the mouse, so clicking inside a border
                draws a nested box or selects the panel underneath. */}
            {interactive && (
              <>
                <span className="adornment-hit adornment-hit--top" />
                <span className="adornment-hit adornment-hit--left" />
                <span className="adornment-hit adornment-hit--right" />
                <span className="adornment-hit adornment-hit--bottom" />
              </>
            )}
            {isSelected && renderChrome ? renderChrome(a) : null}
          </div>
        );
      })}
    </div>
  );
}

AdornmentLayer.propTypes = {
  adornments: PropTypes.arrayOf(
    PropTypes.shape({
      id: PropTypes.string,
      kind: PropTypes.string,
      x: PropTypes.number,
      y: PropTypes.number,
      w: PropTypes.number,
      h: PropTypes.number,
      color: PropTypes.string,
      width: PropTypes.number,
      line_style: PropTypes.string,
    })
  ),
  // Edit-mode only: allow selection + chrome. View/kiosk pass nothing.
  interactive: PropTypes.bool,
  selectedId: PropTypes.string,
  onSelect: PropTypes.func,
  renderChrome: PropTypes.func,
};

export default AdornmentLayer;
