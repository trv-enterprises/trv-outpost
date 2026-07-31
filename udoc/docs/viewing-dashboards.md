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

If the dashboard defines [dashboard variables](dashboard-variables.md), their controls appear after the dashboard name. Picking a value re-scopes every panel — repointing them to a different connection, substituting a value into their queries and filters, or (for a **time-range** variable) re-scoping every time-series panel to the picked window, with a step dropdown for connection types that downsample server-side — so one dashboard can serve many sites, systems, or time spans.

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

### Many live panels on one dashboard

Dashboards that stream from **many connections at once** (for example a
fleet overview pulling live data from a dozen hosts) load reliably — all
of a tab's live streams now share a single connection to the server
rather than opening one per data connection. Earlier versions could
leave some panels stuck on "Loading…" indefinitely on large streaming
dashboards viewed over plain `http://`; that limitation is gone.

If you ever *do* see panels stall on "Loading…" on such a dashboard with
an older build, viewing over `https://` (or reloading the tab) is the
quickest workaround.

## Viewing on Mobile

On a phone-sized screen the viewer switches to a **mobile layout** built
for reading, not authoring. Instead of shrinking the whole desktop grid
to fit — which leaves charts and numbers too small to read — it lays out
the dashboard as a **single vertical column**:

- Every panel is shown **full-width, one per row**, and you scroll down
  through them. Panels appear in reading order (top-to-bottom, then
  left-to-right) based on where they sit on the desktop layout.
- **Stacked or Fit.** Stacked (the default) is the column layout described
  here. Some dashboards are built to be read *as a whole* — a wall display, a
  status board where the arrangement itself carries meaning — and for those,
  tap the **fit-to-screen** button in the top bar to switch to **Fit**: the
  real layout, borders and all, scaled down to the screen. The fit-mode menu
  there offers **Stacked (mobile)** to switch back.

  Your choice is remembered and applies to every dashboard until you change
  it. Editing is a desktop activity, so the design controls stay hidden on a
  phone in either mode.
- **Borders group panels.** If a panel sits inside a
  [border](dashboard-editor.md#borders-adornments) on the desktop layout,
  it flows with the rest of that border's panels as a block, rather than
  interleaving with whatever else happens to be at the same height. Groups
  nest, and a group takes its position from where the border sits. Use a
  **Hidden** border to control this order without drawing a box on the
  desktop layout. Nothing about a group is drawn on the phone — it only
  affects the order.
- The design-time grid arrangement (side-by-side panels, exact sizes) is
  **not** preserved on mobile — the column layout is chosen for
  legibility. You don't need to re-author anything; any existing
  dashboard just works.
- A slim bar at the top shows a **back** arrow (to the dashboard list),
  the dashboard name, and a **Refresh** button. Live/streaming charts
  keep updating exactly as they do on desktop.
- **Tap the expand icon** on any chart to open it **fullscreen** —
  edge-to-edge, filling the whole screen. Rotate your phone to landscape
  for a wide chart. Tap the **×** (or press Escape) to return to the
  stack.
- If the dashboard has [variables](dashboard-variables.md), a **gear
  (Variables)** button appears in the top bar. Tap it to open the
  variable controls — the same connection, filter, and time-range pickers
  as on desktop — and your selection re-scopes every panel.
- The header is simplified to the essentials — notifications and your
  account menu. Design and Manage tools are hidden; mobile is
  **view-only**.

To pick a different dashboard, tap the back arrow to return to the
dashboard tile grid — it reflows to a mobile-friendly layout, with the
search box always visible and the namespace / tag / connection filters
tucked behind a **Filters** button to save space.

### Install as an app (Add to Home Screen)

For a dashboard with **no browser UI at all**, install the app on your
home screen — it launches edge-to-edge like a native app:

- **iPhone / iPad (Safari)**: tap **Share → Add to Home Screen**, then
  open from the new icon. On iPhone this is also the only way to get a
  truly fullscreen view — Safari doesn't allow web pages to fullscreen
  chart panels, so the in-browser fullscreen keeps Safari's bars.
  (Android and iPad fullscreen the panel natively in the browser too.)
- **Android (Chrome)**: accept the **Install app** prompt, or use
  **⋮ → Add to Home screen**.

You'll sign in once on first launch — the installed app keeps its own
session, separate from the browser's.

> **Note:** Mobile is a viewing experience. To create or edit dashboards,
> components, or connections, use a desktop browser.
