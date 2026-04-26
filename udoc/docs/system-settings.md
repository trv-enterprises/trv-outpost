---
sidebar_position: 18
---

# System Settings

Configure deployment-wide settings from **Manage Mode → Settings**. Requires the Manage capability.

## Available Settings

| Setting | Category | Description |
|---------|----------|-------------|
| **Layout Dimensions** | Layout | Available canvas presets for dashboards. Each preset defines a max width and height in pixels. |
| **Default Layout Dimension** | Layout | The preset selected by default when creating new dashboards. |
| **Tile Font Size** | Appearance | Font size for compact tile-control labels (xs / sm / md / lg). |
| **Default Number Chart Value Size** | Appearance | Default font size (px) for the value in newly-created Number charts. Authors can override per-chart. |
| **Default Dashboard Fit Mode** | Dashboard | Fit mode applied to any dashboard a user has not explicitly set. One of `actual`, `window`, `width`, `stretch`. Per-user, per-dashboard preferences always override this default — no user's pick affects another user. |
| **Dashboard Command Topic** | Dashboard | MQTT topic the dashboard subscribes to for voice/kiosk commands (default `dashboard/cmd`). |
| **Dashboard Command Connection** | Dashboard | MQTT connection used for the dashboard command topic. Pick from configured MQTT connections. |
| **Dashboard Config Refresh Interval** | Dashboard | How often (seconds) viewers re-fetch the dashboard record from the server to pick up edits made by another user. Default 300 (5 min). Polling is paused while a user is editing the dashboard they're viewing, gated on tab visibility, and only triggers a re-render when the server reports an actual change. Set to 0 to disable. |
| **Default Browser User** | Auth | User GUID assigned to browser-mode visitors who haven't been given an identity by URL parameter or prior session. Empty (default) means visitors hit a "sign-in not configured" stub. **Identity assertion only — anyone hitting the bare URL becomes this user.** Use only for single-user homelab deployments or when there's a separate access-control layer (VPN, reverse proxy) in front of the dashboard. See [Logging In & User Selection](getting-started.md). |
| **Type Availability** | Availability | Hierarchical picker that toggles which integrations and which connection / chart / control / display subtypes are available for creation, AI suggestions, and the MCP catalog. Existing dashboard components keep rendering even when their type is disabled. |

## Editing Settings

1. Click the **Edit** button next to a setting
2. A custom editor modal opens for that setting type
3. Modify the value
4. Click **Save**

### Layout Dimensions Editor

Manages the list of available canvas presets:

- Each preset has a name, max width, and max height in pixels
- Add new presets for specific screen sizes
- Remove presets no longer needed
- Common presets ship by default: 1728 × 1117 (Mac), 1920 × 1080 (HD), 2560 × 1440 (2K), 3840 × 2160 (4K)

The cell-count grid (cols × rows) for any preset is derived from the canvas pixels, not stored on the preset. See [Grid & Layout System](grid-layout.md).

### Type Availability Editor

A hierarchical view of every integration the deployment knows about, with checkboxes to enable or disable individual subtypes.

- Disabling an integration disables all its types as a group.
- Disabled types are hidden from creation pickers, AI Builder enums, and the [MCP](mcp.md) catalog.
- Existing dashboards using disabled types still render — this control gates *creation*, not *runtime*.
- New types added in upgrades auto-enable on first boot. Admin disables persist across upgrades.

### Default Dashboard Fit Mode Editor

A radio selector with the four fit modes (Stretch to fill, Fit to window, Fit to width, Actual size) and a one-line description of each. The chosen value is the deployment-wide default applied to dashboards that no user has explicitly set a fit mode on. Per-user per-dashboard choices always win over this default. See [Dashboard Navigation & Controls](viewer-controls.md#fit-modes) for fit-mode behavior.

## Hidden vs Editable Settings

- **Editable settings** — Stored in the database, modified through the UI, persist across restarts.
- **Hidden settings** — Reload from the YAML config file on each server restart. These are system-level (validation rules, allowed package imports, etc.) not intended for UI modification.

## Configuration File

Settings are seeded from `server-go/config/user-configurable.yaml` on first server start. After initial seeding, editable settings live in MongoDB and take precedence over the YAML file.
