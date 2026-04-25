---
sidebar_position: 5
---

# Dashboard Navigation & Controls

## Keyboard Navigation

Switch between dashboards without using the mouse:

| Shortcut | Action |
|----------|--------|
| **Alt + Right Arrow** | Next dashboard |
| **Alt + Left Arrow** | Previous dashboard |

Navigation order matches the order of tiles on the **View Mode** tile grid (most-recently-updated by default, or your saved manual order if you've rearranged tiles). A brief overlay shows the dashboard name and position (e.g., "Main Dashboard 2 of 5").

Keyboard navigation is disabled while in edit mode and while previewing a design-mode preview.

## Fullscreen Mode

Click the fullscreen icon in the toolbar or press **F11**. In fullscreen:

- The back button is hidden
- All toolbar controls remain accessible
- Press **Escape** or click the minimize icon to exit

## Fit Modes

Click the **fit mode** icon in the toolbar to pick how the dashboard scales to fit your viewport. There are four modes; pick whichever feels right for the dashboard you're looking at:

| Mode | Behavior |
|------|----------|
| **Fit to window** | Uniform scale, centered. Preserves aspect ratio so gauges stay round and pies stay circular. Nothing is clipped. *Safe default for most dashboards.* |
| **Fit to width** | Scale to fill the viewport width exactly. Scroll vertically if the dashboard is taller. Useful for tall, content-heavy dashboards. |
| **Stretch to fill** | Fill both axes independently. Maximizes screen real estate for tile/text-heavy dashboards but may distort round chart elements. |
| **Actual size** | Render at native pixel dimensions (32 × 32 px cells). Scrollbars appear if the dashboard exceeds the viewport. Useful as a debugging mode. |

Your fit mode is **per-dashboard, per-user** — opening different dashboards restores each one's own choice. New dashboards default to the system-wide setting (configured by an admin in [System Settings](system-settings.md), default `Stretch to fill`).

## Auto-Refresh

Dashboards can auto-refresh their data at a configurable interval:

- The green tag in the toolbar shows the interval (e.g., "Data refresh: 30s")
- Set to 0 to disable auto-refresh
- Configure via the [Dashboard Settings](dashboard-settings.md) modal in edit mode
- Auto-refresh pauses while in edit mode

## Save Thumbnail

Capture the current dashboard view as a thumbnail image for the tile grid:

1. Open the dashboard in the viewer (not edit mode)
2. Click the overflow menu
3. Select **Save Thumbnail**

The thumbnail captures the live state of all components including charts, controls, and displays.
