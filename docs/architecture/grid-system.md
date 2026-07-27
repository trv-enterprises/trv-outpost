# Grid system and fit modes

The dashboard grid is a pixel-based CSS grid with fixed-size cells.
Panels are placed onto that grid by cell coordinates, and the grid is
scaled to the viewport in one of four ways depending on the user's
fit-mode preference.

## Cells

- **Cell size**: 32 × 32 px in both axes (based on Carbon's
  `$spacing-08`), hardcoded in `DashboardViewerPage.jsx` as
  `CELL_WIDTH = CELL_HEIGHT = 32`.
- **Gap**: 4 px between cells (`$spacing-02`).
- **Chrome**: 57 px vertical (the viewer toolbar: 56 px + 1 px border),
  4 px horizontal (padding). Subtracted from the canvas before the cell
  count is computed. The displayed dashboard (view / fullscreen) has no
  app header above the toolbar, so the budget reserves only the toolbar —
  this is what makes the editor's "actual size" a pixel-perfect preview
  of the fullscreen render.

> **Kiosk caveat.** The `/kiosk` surface ([frontend.md](frontend.md)) has
> **no toolbar**, so a dashboard laid out against the 57 px budget has a
> proportional gap there. As a stopgap the kiosk renders in **stretch**
> fit (fill both axes). The proper fix is a per-dashboard "kiosk mode"
> that builds against a different chrome budget (0, or kiosk-specific) —
> when that lands, keep this client constant in sync with the server's
> `gridChromeV` (registry/catalog.go) as noted below.

The available cell grid for a given canvas is:

```
cols = floor( canvas_width                  / 36 )
rows = floor( (canvas_height - 53)          / 36 )
```

(The stride is `cell + gap = 36`; the `-53` is
`chrome_v - gap = 57 - 4`; the horizontal chrome and gap cancel.)

Worked examples:

- 2560 × 1440 → **71 cols × 37 rows**
- 1920 × 1080 → **53 cols × 27 rows**
- 1280 × 720 → **35 cols × 17 rows**

A panel's geometry is stored as `{x, y, w, h}` in cell units. Example
on a 1280 × 720 canvas (35 cols × 17 rows):

```
┌─────────────────────────────────────────────────────────────────┐
│  columns 0..34                                                  │
├─────────────────────────────────────────────────────────────────┤
│ Panel A (x:0,  y:0, w:17, h:12) │ Panel B (x:17, y:0, w:18, h:6)│
│                                 ├───────────────────────────────┤
│                                 │ Panel C (x:17, y:6, w:18, h:6)│
└─────────────────────────────────┴───────────────────────────────┘
```

Note: the older "12-column" framing is a Carbon responsive-breakpoint
convention and is not the runtime grid. Don't conflate them.

## Layout dimension presets

Admins define layout dimension presets in Manage mode. Each preset is
a pair of `max_width` × `max_height` values in pixels; when a
dashboard is created the user picks a preset and the pixel canvas is
stored on `dashboard.settings.layout_dimension`. The cell-count grid
then falls out of canvas ÷ 32 in each axis — there is no
preset-specific column override.

## Fit modes

The dashboard viewer can render the grid at four different scales.
The mode is a per-user preference (`dashboard_fit_mode` stored in
`app_config`) so every dashboard the user opens follows the same
policy.

| Mode              | Scale formula             | Behavior                                                              |
| ----------------- | ------------------------- | --------------------------------------------------------------------- |
| **Actual size**   | `1` (no transform)        | Render at native pixel size, top-left. Scroll in both directions.     |
| **Fit to window** | `min(scaleX, scaleY)`     | Uniform scale, centered. Nothing clipped. Charts stay geometric.      |
| **Fit to width**  | `scaleX`                  | Fill width exactly, scroll vertically if the content is taller.       |
| **Stretch to fill** | `scale(scaleX, scaleY)` | Fills both axes independently. May distort round chart elements.      |

**Fit to window** is the safe default — it preserves aspect ratios so
gauges stay circular, pie charts stay round, and text stays
proportional. It's what most users want most of the time.

**Fit to width** is useful on tall/scrolling dashboards or on devices
where horizontal space is the constrained axis. Vertical overflow
uses an auto-hiding scrollbar (shown on hover, hidden otherwise).

**Stretch to fill** is the legacy behavior — the old "reduce to fit"
boolean preference. It fills both axes which looks great for
text/tile-heavy dashboards where nothing is shape-sensitive, but it
distorts gauges and pies whenever the viewport aspect doesn't match
the grid aspect. Kept for back-compat and for dashboards where the
distortion doesn't matter.

**Actual size** mostly exists as a reference mode for debugging
layouts — content renders at native pixel size and may overflow the
viewport.

### Preference migration

Older builds stored a single boolean `dashboard_reduceToFit`:

- `true` → mapped to `"stretch"` (the exact old behavior)
- `false` → mapped to `"actual"`
- Unset → defaults to `"window"` (the safe new default)

Both keys are written on save for one release's worth of
back-compatibility; the old boolean is eventually removed.

## Edit mode vs view mode

Edit mode uses its own `zoom` CSS transform independent of the fit
mode. The fit-mode transform is short-circuited when
`isEditMode === true` so the two scale systems don't interact. Edit
mode also draws an extra grid-boundary overlay to show where the
current layout preset's bounds are.

## Title scale

Each dashboard has a `settings.title_scale` value (50–200, default
100) that scales the panel titles by a percentage of the base size.
It's implemented as a CSS custom property (`--title-scale`) on the
grid root, multiplied into the chart-header font size via
`calc(0.875rem * var(--title-scale, 1))`.

## Adornments (decorations in the gutter)

Adornments are purely visual decorations drawn *over* the panel grid.
There are two kinds: `border` — a rectangle that draws its line in the
4 px gutter between panels, growing outward from the panels' edge (see
below) — and `panel_border`, which restyles a single panel's own border
inward. They are stored in their
own `adornments` array on the dashboard record, **not** in `panels`:
they reference no component, render no data, and must never appear in
panel counts, component-usage lookups, or export dependency walks.

Geometry is a cell rect `{x, y, w, h}` in the same units as a panel.
The renderer (`AdornmentLayer.jsx`) anchors the line to the panels'
own edge and grows it **outward** into the gutter.

### Building a border rect

Two ways to get to the same rect, because dragging is awkward once the
target group isn't already a tidy block:

- **Drag** — the original gesture. Press, drag ≥ `ADORNMENT_MIN_DRAW_CELLS`
  (2) cells in either axis, release.
- **Click / shift-click / double-click** — click bare grid to commit a
  1×1 seed; <kbd>Shift</kbd>-click to union the rect with the click
  target; double-click inside to collapse it.

Plain click is deliberately **not** overloaded three ways. With a
selection live it deselects; only from a clean slate does it seed. The
alternative — always seeding — makes clearing a selection drop a stray
1×1, which is exactly the move needed to get from one border to another.
Switching between borders needs no gesture of its own: edge hit strips
render for *every* border, not just the selected one, so clicking another
border's edge selects it directly.

The union target is the whole **panel** rect when a panel is under the
cursor, otherwise the single cell. That's what makes "shift-click the
panels you want" work in one click per panel rather than one per edge
cell.

<kbd>Shift</kbd>-click has ONE rule: it sets the boundary to the clicked
cell. Outside the rect that's a union (grow); inside it's a collapse
(shrink). Splitting those across two different gestures made the inside
click a silent no-op — a union with a cell already contained changes
nothing — which reads as a broken gesture rather than a deliberate one.

Shrink moves **both** the nearer horizontal edge and the nearer vertical
edge in to the clicked cell, making it a corner. Ties resolve toward
left/top. Double-click does the same thing (shared `collapseToCorner`, so
the two can't drift). The edge grips remain the single-edge, precise
path; both click gestures are the coarse one.

**The outer boundary needs overlay strips, not padding.** The grid box
ends exactly at the last cell (`cols*32 + (cols-1)*4`), so there is no
grid surface above row 0, left of column 0, or past the last row/column
— nothing to press, so a border can't be *started* on the outer edge.

Padding cannot fix this. The `cols`/`rows` formulas floor a near-exact
fit, so the leftover canvas is whatever the modulo happens to be — **4 px
at 2560 wide**, 12 px at 1920, 24 px at 3840. A symmetric 4 px ring needs
8 px horizontally, which usually isn't there; adding it overflows the
canvas or gets squeezed to nothing. Any fix that consumes layout space
has the same problem, and taking it from `VIEWER_CHROME_H` instead would
cost a whole column and reflow existing dashboards.

The press is instead handled on `.dashboard-grid-container`, whose 4 px
padding is the band just outside the grid. In adornment mode that element
takes the same `onGridMouseDown` and wears `cursor: crosshair`, and
`getGridPosition`'s existing clamp resolves the out-of-range coordinate to
the boundary cell.

Handling it on the CONTAINER rather than on overlay strips is the whole
trick. An earlier attempt floated hit-strips above the grid's outer cells;
they intercepted edge-grip drags and shift-clicks near the boundary,
trading an inconvenience for two broken gestures. The container sits
*below* the grid, so panels, borders, and grips all claim the event first
by normal bubbling — the container only ever sees presses that missed
everything else.

### Panel multi-select

<kbd>Shift</kbd>-drag on the grid is a marquee; on release, panels **fully
enclosed** by it become `selectedPanelIds`. Dragging any member then moves
the whole set.

Three details that are easy to get wrong:

- **`startDragging` passes shift-presses through.** Panels normally claim
  their own mousedown, so without that passthrough a marquee could never be
  started on top of a panel.
- **Batch moves apply one delta to a grab-time snapshot**, not to live
  panel state — applying deltas incrementally lets rounding accumulate and
  the group drifts apart over a long drag.
- **Clamping is group-wide.** The delta is limited by whichever member hits
  an edge first, keeping the group rigid; clamping each panel independently
  squashes the group against the boundary.

An outside click *deselects only* — the click after it draws or selects
normally. Always-deselect-and-act meant a slightly-missed click both lost
the selection and left a stray 1-cell panel behind. Same two-stage rule the
border gestures use.

The selection is transient: cleared on save, on entering adornment mode
(shift is the marquee in normal mode but extend/shrink in adornment mode —
one modifier can't mean both), on `enterEditMode` (which re-seeds every
panel, so a surviving selection would point at the pre-revert set), and on
leaving edit mode.

### Line weight under non-uniform fit

"stretch" scales the grid by `scale(sx, sy)` with **different factors per
axis**, and a CSS border scales with everything else — so a 4 px line
renders `4*sx` on the sides and `4*sy` on top and bottom. `AdornmentLayer`
corrects this by normalizing each axis against the **mean** of the two:

```
lineX = width * (mean / sx)      lineY = width * (mean / sy)
```

Normalize against the mean, **not** by dividing by `sx`/`sy` outright. The
divide-outright version renders each axis at exactly the nominal width, but
when a scale factor is below 1 it makes the line *thicker in grid
coordinates* — two adjacent boxes then eat the shared 4 px gutter from both
sides and the gap between them closes. That shows up even at ratios near 1,
where the gutter itself has barely shrunk. Borders must scale WITH the
canvas like everything else; only the axis *difference* is the artifact.

The position offset uses the same per-axis values, so the line's inner edge
stays flush against the panel instead of drifting by the scale difference.
Both factors are 1 in every uniform mode, making the whole thing a no-op
there. Panel borders (`panel_border`) are plain CSS borders on grid items
and are still subject to the original distortion.

**Gutter presses resolve by drag direction.** `getGridPosition` floors,
so a press in the 4 px gap between cells lands on whichever cell the
pixel math picks — arbitrary from the author's point of view, and it
makes starting a border *on* an edge feel like a coin flip.
`getGridPositionDetailed` additionally reports whether the press was in
the gutter (the tail of the 36 px stride, `>= 32/36`), and the draw
excludes the cell BEHIND the drag: drag right from a gutter and the box
starts on the right-hand cell. Resolved per-axis, and only once the drag
has a direction to read — which is why the flags are stored at mousedown
and applied in `handleMouseMove` rather than resolved up front.
`getGridPosition` itself is deliberately unchanged: it's shared with
panel dragging, which grabs a panel body and never a gutter.

Three collisions this gesture set has to resolve, all in
`handleAdornmentGridMouseDown` / `handleMouseUp`:

- A click on a **panel** attaches a `panel_border` and returns before the
  seed branch, so the two click meanings never overlap.
- A double-click arrives as two full mousedown/mouseup pairs. A press
  inside the *selected* border sets a transient `noSeed` flag and keeps
  the selection, so the first press of a shrink can't deselect the target
  or litter a 1×1 inside it. `e.detail >= 2` short-circuits the second
  press. `noSeed` is gesture state only — the committed record is built
  field-by-field and never carries it.
- The panel expand-modal double-click (`DashboardGrid.jsx`) is suppressed
  while `adornmentMode` is on, since adornment mode owns that gesture.
- **A border's own chrome must not swallow the build gestures.** The edge
  hit strips (9 px) plus the grips (10 px) cover essentially ALL of a 1×1
  box (~36 px), and `AdornmentLayer` `stopPropagation()`s every mousedown
  that reaches it. So on a freshly seeded box, a shift-click or
  double-click hit a grip and became a resize — the grid handler that
  implements extend/shrink never ran, and the gesture looked dead. Both
  are unambiguous (shift never means resize; a double-click never means
  drag), so `AdornmentLayer` lets `e.shiftKey` and `e.detail >= 2` fall
  through untouched. Any future gesture routed through the grid needs the
  same passthrough, or it will be unusable on small borders.

Extending across an unrelated panel is **allowed**. A rectangle can't
route around an obstacle, and every alternative (splitting the box,
skipping the panel, auto-shrinking) produces geometry that's harder to
predict than a visible overlap. While <kbd>Shift</kbd> is held the panels
the union would cross are outlined (`adornment-extend-preview`) so the
overlap is visible *before* the click. That cue is preview-only — nothing
about overlap is stored on the adornment.

The cell rect's content box — the panels' footprint — is
`[x * stride, x * stride + w * stride - GAP]`, where
`stride = CELL + GAP`. Since `box-sizing: border-box` draws the border
*inward* from the element's edge, the element is that content box
expanded by the line width on every side:

```
left  = x * stride - lineWidth    width  = w * stride - GAP + 2 * lineWidth
top   = y * stride - lineWidth    height = h * stride - GAP + 2 * lineWidth
```

The line then occupies `[x*stride - lineWidth, x*stride]` — flush
against the panel edge, extending away from it.

**Why outward rather than centered on the gutter:** the gutter is 4 px,
so growing outward lets two *adjacent* boxes each take half of the same
gutter without colliding. Box A's right border occupies the inner 2 px,
box B's left border the outer 2 px — they meet exactly and never
overlap. A gutter-centered line would put both on the same centerline.

Because nothing is being centered, there is **no parity constraint** —
odd widths are fine. Widths above 2 px consume more than half the
gutter, so adjacent boxes at 3–4 px overlap each other; that is the
author's call, not something the geometry forbids. The allowed set is
duplicated in `models.AdornmentWidths` (Go) and `ADORNMENT_WIDTHS`
(`DashboardViewerPage.jsx`) — keep them in lockstep.

Two properties fall out of the layer being an absolutely-positioned
**sibling** of the panels inside `.dashboard-grid`:

- The fit-mode transform is applied to `.dashboard-grid` itself, so
  adornments scale with the panels automatically in every fit mode and
  at any edit zoom. No transform math lives in the adornment code.
- `.panel-container` sets `overflow: hidden`, which would clip a border
  drawn inside a panel. As a sibling it is never clipped.

Adornments render **above** panel bodies (z-index 8, between the panel
layer at 1 and a dragged panel at 10). That is deliberate: a panel moved
onto a border then visibly crosses the line. Drawing *below* panels
would let the panel's opaque background silently swallow that segment,
so the box would render with a gap in it and read as a rendering bug
rather than a layout mistake. There is no stored relationship between a
panel and an adornment, so an overlap is fixed by moving either one.

View-mode grid extent folds in adornment extent as well as panel
extent — otherwise a border drawn past the rightmost or bottom panel
would fall outside the fit-tight box and be clipped.

## Related docs

- [Frontend architecture](frontend.md) — `DashboardViewerPage` is the
  component that owns the grid + fit mode logic
- [API reference](api-reference.md) — `/api/config/user/:user_id` is
  where the fit mode preference lives
