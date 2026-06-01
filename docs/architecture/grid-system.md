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

## Related docs

- [Frontend architecture](frontend.md) — `DashboardViewerPage` is the
  component that owns the grid + fit mode logic
- [API reference](api-reference.md) — `/api/config/user/:user_id` is
  where the fit mode preference lives
