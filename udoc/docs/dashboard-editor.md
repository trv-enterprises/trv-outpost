---
sidebar_position: 6
---

# Live Dashboard Editor

The dashboard editor works directly within the viewer, allowing you to rearrange and resize panels while components continue to render live data.

## Entering Edit Mode

Two ways to enter edit mode:

1. Click the overflow menu (three dots) and select **Edit Dashboard**
2. Navigate from Design Mode dashboards list (automatically enters edit mode)

## Editor Toolbar

When in edit mode, the toolbar changes to show editing controls:

| Control | Description |
|---------|-------------|
| **Dashboard name** | Editable text input — click to rename |
| **Variables** | Define [dashboard variables](dashboard-variables.md) that re-scope the board at view time |
| **Dimension preset** | Dropdown to select layout dimensions (center of toolbar) |
| **Zoom controls** | `-` / `100%` / `+` buttons to zoom the canvas (10%-100%) |
| **Unsaved changes tag** | Blue tag appears when edits have been made |
| **Sub-mode toggle** | Switch between Standard and Compact editing modes |
| **Borders** | Enter adornment mode to draw grouping boxes around panels |
| **Settings gear** | Open the [Dashboard Settings](dashboard-settings.md) modal |
| **Cancel** | Discard changes (prompts confirmation if unsaved) |
| **Save** | Persist all changes to the server |

## Editing Sub-Modes

### Standard Mode (default)

Each panel shows a drag handle header bar at the top with:

- **Panel title** (read-only label showing the component name)
- **Size label** (e.g., "3x4" showing width and height in grid units)
- **Edit icon** (pencil or `+`) — opens a dropdown menu for component editing
- **Delete icon** (trash can) — removes the panel

Components are hidden behind the editing overlay in this mode, giving a clean layout view.

### Compact Mode

No header bar — components render at full size. The entire panel is a drag target. Useful for:

- Seeing exactly how the dashboard will look to viewers
- Making quick position adjustments without the header taking space
- Empty panels show an "Add" button for assigning components

Toggle between modes using the icon button in the toolbar.

## Moving several panels at once

Hold <kbd>Shift</kbd> and drag a box across the canvas. On release, every
panel **completely inside** the box is selected — a panel the box only
clips is left out, so grabbing a group is deliberate rather than a guess.

Selected panels get a blue outline and stay selected until you clear them.
While the selection is live:

| Action | Result |
|--------|--------|
| **Drag inside the selection** | Moves the whole group together |
| **Click empty space** | Clears the selection (that click does nothing else) |
| **Click a panel outside the selection** | Clears the selection and works on that panel |
| **<kbd>Esc</kbd>** | Clears the selection |

The group moves as a rigid block and stops at the canvas edge — it won't
squash together when one panel reaches the boundary. Panels may overlap
after a group move, exactly as they may when dragged one at a time.

A **border** completely inside the selection box travels with the group,
so a framed set of panels keeps its frame. A border that only partly
overlaps the box stays where it is — move it separately in Borders mode.

The selection is a working aid, not saved state: it clears on save, on
switching to Borders, and on leaving the editor.

## Borders (Adornments)

Borders are grouping boxes you draw around related panels — a visual way
to say "these four charts belong together." They are decoration only:
they hold no data, and they never change how a panel behaves.

Click **Borders** in the toolbar to enter adornment mode. Panels dim and
stop responding to clicks, so every mouse action applies to borders.

| Action | How |
|--------|-----|
| **Draw a border** | Drag out a rectangle on the grid, exactly like drawing a panel |
| **Start from one cell** | With nothing selected, click an empty cell — a one-cell border appears around it, ready to extend |
| **Extend** | <kbd>Shift</kbd>-click a cell or panel *outside* the selected border; it grows to take it in |
| **Shrink** | <kbd>Shift</kbd>-click (or double-click) a cell *inside* the selected border — it becomes the border's new corner |
| **Select** | Click a border's edge — this works even when another border is already selected, so it's how you switch between them |
| **Move** | Drag a selected border |
| **Resize** | Drag any edge or the bottom-right corner |
| **Restyle** | With a border selected, use the color / width / line-style controls that appear in the toolbar |
| **Delete** | Press <kbd>Delete</kbd>, or click the trash icon in the style controls |
| **Deselect** | Press <kbd>Esc</kbd>, or click empty grid space |

### Building a border by clicking

Dragging a rectangle is the quickest way to box in panels that are already
next to each other. When the group is a more awkward shape, build it up
instead:

1. Click an empty cell, with no border currently selected. A one-cell
   border appears there. (If something *is* selected, that first click
   just deselects it — click again to start the new box.)
2. <kbd>Shift</kbd>-click each panel you want inside it. The border grows
   to the smallest rectangle containing everything you've clicked — so
   clicking anywhere on a panel takes in that whole panel.
3. To pull it back in, <kbd>Shift</kbd>-click a cell *inside* the border
   (double-click does the same thing). The cell you click becomes a
   corner: the nearer left/right edge and the nearer top/bottom edge both
   move in to meet it.

So <kbd>Shift</kbd>-click has one rule — **it sets the boundary to where
you clicked**. Outside the border that grows it; inside, it shrinks it.

While you hold <kbd>Shift</kbd>, every panel the border would end up
crossing is outlined, so you can see what a click will take in before you
commit to it.

When you start a drag from the narrow gap *between* two panels, the box
starts on the side you drag **toward** — drag right and the panel to the
left is left out, drag left and it's the one on the right. That makes it
possible to start a border exactly on an edge instead of guessing which
cell the gap belongs to. The thin margin just outside the outermost
panels works the same way, so a border can start on the canvas edge.

With several borders on a dashboard, click any border's **edge** to make
it the selected one — that works whether or not something else is
selected, so you can go straight from extending one border to extending
another. The style controls in the toolbar always act on the currently
selected border.

Because a border is always a rectangle, extending it to reach one panel can
sweep in another that happens to sit between them. That's expected — a
rectangle can't route around an obstacle, and the alternatives all produce
shapes that are harder to predict than the overlap you can see. Move the
panel or the border if the result isn't what you wanted.

Click **Done** to leave adornment mode and return to editing panels.
Borders save with the rest of the dashboard when you click **Save**.

### How borders line up

A border hugs the panels it surrounds and draws outward into the gap
*between* panels, so it never covers any content. A new border reuses the
last style you picked, so a set of matching boxes takes one style choice,
not one per box.

Line widths are 1–4 px. The gap between panels is 4 px, so **two boxes
sitting side by side can each use 2 px and meet exactly without
overlapping** — useful when you want to outline two adjacent groups.
At 3 px or 4 px, two adjacent boxes will overlap each other; that's
allowed, just something to expect.

If you move a panel on top of a border, the line simply draws across the
panel. Nothing breaks — move either the panel or the border to fix it.

## Dashboard Variables

Click **Variables** (next to the dashboard name) to define a
[dashboard variable](dashboard-variables.md) — a header dropdown that re-scopes
every panel at view time, so one dashboard can serve many sites or systems.
Variables either **swap the connection** each panel reads from, or **substitute
a value** into panel queries and filters. See
[Dashboard Variables](dashboard-variables.md) for the full setup, including
automatic value discovery from the connection.

## Dimension Presets

The dimension dropdown in the center of the toolbar sets the grid boundary — the maximum area available for placing panels. Red dashed lines show the boundary edges.

Presets are configured by administrators in [System Settings](system-settings.md) and correspond to screen resolutions (e.g., 1728x1117 MAC, 1920x1080 HD, 3840x2160 4K).

Changing the dimension preset is saved with the dashboard.

## Asking the AI Assistant to build a dashboard

The Dashboard Assistant builds dashboards from a plain-language request
(e.g. *"Build me a 2K dashboard for my system stats"*). By default it builds
for **legibility** — a clean overview with readable, sensibly-sized panels —
because most dashboards are meant to be glanced at, not studied up close. If you
want a **denser** board with more components, say so explicitly:

- **Ask for density:** *"build a dense dashboard"* or *"pack it"* tells the
  Assistant to use more, smaller panels.
- **Name a panel count:** *"use about 24 panels"* or *"give me 30 components"*
  sets the target directly — this is the most reliable way to control density.
- **Ask for breadth:** *"cover every useful signal"* (e.g. saturation, error,
  and restart metrics, not just CPU/memory/disk/network) pushes it past the
  headline few.
- **Use scale for a bigger surface:** *"build a 4K dashboard at 150% scale"*
  builds against a larger effective canvas. Combine with a density request for a
  wall-display board: *"a dense 4K board at 150%."*

You can also start from one of the suggestion chips in the Assistant's welcome
screen and edit the prompt before sending.

### Asking for data analysis

The Assistant can also analyze the data behind your connections, not just build
panels for it. Questions like *"anything weird in my power data this month?"*,
*"is the garage temperature trending up?"*, or *"does CPU usage track
network traffic?"* make it run a server-side statistical pass (summary
statistics, anomaly detection, correlation, or trend fitting) over up to 50,000
rows and interpret the result — far more data than it could read directly. The
analysis is read-only and runs through the same access rules as any other
query. If the result was truncated, the Assistant is told so and will say so.

## Zoom

Use the zoom controls to shrink the canvas for an overview or detailed work:

- Click `-` to zoom out (minimum 10%)
- Click the percentage label to reset to 100%
- Click `+` to zoom in (maximum 100%)

Zoom does not affect the saved dashboard — it's purely for editing convenience.

## Saving Changes

Click **Save** to persist:

- Panel positions and sizes
- Dashboard name
- Component assignments
- Dimension preset
- All settings from the settings modal

Click **Cancel** to discard. If you have unsaved changes, a confirmation dialog asks whether to discard or keep editing.

---
