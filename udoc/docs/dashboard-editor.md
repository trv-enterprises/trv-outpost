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
