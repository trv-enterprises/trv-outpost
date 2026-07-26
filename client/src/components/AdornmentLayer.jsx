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
 * The border starts at the first pixel OUTSIDE that box and grows away from
 * the panels. Since `box-sizing: border-box` draws the border inward from
 * the element's edge, the element is simply the content box expanded by the
 * line width on every side:
 *
 *   left  = x*stride - lineWidth        width = w*stride - GAP + 2*lineWidth
 *
 * The line then occupies [x*stride - lineWidth, x*stride] — flush against
 * the panel edge, extending into the gutter.
 *
 * Why outward rather than centered: the gutter is 4px, so growing outward
 * lets TWO adjacent boxes each take 2px of the same gutter without
 * overlapping — box A's right border sits in the gutter's inner half, box
 * B's left border in the outer half. A centered line would put both on the
 * same centerline and they'd collide.
 *
 * Widths above 2px consume more than half the gutter, so two adjacent boxes
 * at 4px or 6px will overlap each other (and at 6px spill onto the far
 * panel). That is the author's call — the geometry no longer forces it.
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

  // Content box of the cell rect (the panels' own footprint), then expanded
  // by the line width on each side so the border grows outward from it.
  return {
    left: a.x * stride - line,
    top: a.y * strideY - line,
    width: a.w * stride - GAP + 2 * line,
    height: a.h * strideY - GAP + 2 * line,
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
              borderColor: a.color || '#0f62fe',
            }}
            onMouseDown={
              interactive && onSelect
                ? (e) => {
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
