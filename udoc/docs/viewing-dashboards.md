---
sidebar_position: 4
---

# Viewing Dashboards

## Dashboard Selection

Navigate to **View Mode** to see the dashboard tile grid. Each tile shows:

- Thumbnail preview of the dashboard layout (or a placeholder icon)
- Dashboard name and description
- A small **copy icon** next to the name — click to copy the dashboard's UUID to the clipboard. Useful for [Kiosk Mode](modes.md#kiosk-mode) URLs and deep-link sharing.
- Tags indicating auto-refresh interval, panel count, and the data sources the dashboard pulls from
- A **star icon** if it's your default dashboard
- A **three-dot overflow menu** with the **Set as Default** action when the dashboard isn't already your default

Click a tile to open the dashboard in the viewer. The page header shows a `Dashboards` title and, when applicable, a **Reset order** button (see Reordering below).

If you arrived with a **`?dashboards=…` URL**, the grid is locked to
that dashboard set with a purple **"Kiosk mode"** badge — see
[Kiosk Mode](modes.md#kiosk-mode) for what's different.

### Search and Filters

The toolbar above the tile grid has three controls that combine:

- **Search** — substring match against dashboard name and description.
- **Namespace filter** — multi-select dropdown. Empty selection means "all namespaces"; pick one or more to narrow the grid. See [Namespaces](namespaces.md) for what namespaces are and when to use them.
- **Tag filter** — multi-select dropdown of every tag in use across dashboards. OR semantics: a dashboard matches if it has at least one of the selected tags.

The three filters AND together — a tile is shown only if it passes the search, the namespace filter, and the tag filter.

### Tile Order

By default, tiles appear in **most-recently-updated order** — the same as the design-mode dashboard list. New dashboards land at the top.

Your manual drag-and-drop order is shared with the **Design-mode dashboards list** when its sort is also set to "Manual (drag to reorder)" — change the order in one place, the other sees it on next load.

You can drag tiles to rearrange them:

1. Click and hold any tile.
2. Drag over another tile. A blue bar appears on the left or right edge depending on which half of the target tile your pointer is over — drop on the left half to land *before* the target, drop on the right half to land *after* it.
3. Release to drop. Your chosen order is saved per-user and persists across sessions.

A few notes:

- **Drag-reorder is desktop-only.** Touch devices don't support tile reordering for now; use a desktop browser to set the order.
- **Click vs drag.** Just-clicking a tile (no drag distance) navigates as usual. Right after a drop, the *just-dropped* tile briefly suppresses click-through so the drop doesn't accidentally navigate you away.
- **New dashboards** still come in at the front of the list, even if you've manually rearranged your other tiles. Anything you haven't explicitly placed sorts into the most-recently-updated section ahead of pinned tiles, so a brand-new dashboard surfaces immediately.
- **Reset order.** When you have a manual order saved, a **Reset order** ghost button appears in the page header. Clicking it discards your sequence and reverts the grid to most-recently-updated.

## Setting a Default Dashboard

Your default dashboard loads automatically when you open the application.

There are two paths to set it:

- **From the tile grid** — click the three-dot overflow menu on any non-default tile, then **Set as Default**.
- **From the dashboard viewer** — open the dashboard, click the overflow menu in the toolbar, then **Set as Default**.

The star icon appears next to the dashboard name in the tile view. Each user has their own default dashboard preference.

## Dashboard Viewer

The viewer renders all dashboard panels with live data. Components refresh automatically based on the dashboard's configured refresh interval.

### Toolbar

The toolbar at the top of the viewer provides:

| Control | Description |
|---------|-------------|
| **Back arrow** | Return to the dashboard tile grid |
| **Dashboard name** | Displayed in the header |
| **Refresh tag** | Shows the auto-refresh interval (e.g., "Data refresh: 30s") |
| **Last refresh** | Timestamp of the most recent data refresh |
| **Refresh button** | Manually refresh all components |
| **Fullscreen** | Toggle browser fullscreen mode |
| **Fit mode picker** | Choose how the dashboard scales — see [Fit Modes](viewer-controls.md#fit-modes) |
| **Overflow menu** | Additional actions (Edit, Save Thumbnail, Set as Default) |

### Interacting with Components

- **Charts** — Display data visualizations that update automatically.
- **Controls** — Buttons, toggles, sliders, and plugs that send commands to connected devices via MQTT or WebSocket.
- **Displays** — Special components like camera feeds, weather widgets, and dataview tables.
- **Double-click** a chart panel to open a data modal showing the raw data table behind the visualization.

See [Dashboard Navigation & Controls](viewer-controls.md) for keyboard navigation, fullscreen, fit modes, auto-refresh, and thumbnail capture.
