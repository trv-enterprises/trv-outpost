---
sidebar_position: 3
---

# Application Modes

TRVE Dashboards operates in three modes, accessible via the mode toggle in the application header.

## View Mode

The default mode for end users. View dashboards with live data, interact with controls, and navigate between dashboards.

- **Dashboard tile grid** for selecting dashboards (with search, namespace filter, tag filter, and drag-reorder — see [Viewing Dashboards](viewing-dashboards.md))
- **Full dashboard viewer** with real-time data refresh and four [fit modes](viewer-controls.md#fit-modes)
- **Edit mode** for layout changes (requires Design capability)

## Design Mode

For creating and configuring dashboard components. Access requires the Design capability.

Three sections in the sidebar:

| Section | Purpose |
|---------|---------|
| **Connections** | Configure data sources (SQL, API, WebSocket, MQTT, Prometheus, EdgeLake, ts-store, Frigate, ...) |
| **Components** | Create charts, controls, and display components |
| **Dashboards** | View and manage the dashboard list |

## Manage Mode

System administration. Access requires the Manage capability.

Four sections in the sidebar:

| Section | Purpose |
|---------|---------|
| **Users** | Create and manage user accounts and capabilities |
| **Devices** | Manage smart devices and their device-type templates (command schemas) |
| **Namespaces** | Create, edit, and delete [namespaces](namespaces.md) — conflict-domain groupings for connections, components, and dashboards |
| **Settings** | Configure deployment-wide settings (layout presets, default fit mode, type availability, etc.) — see [System Settings](system-settings.md) |

## The Namespace Pill

Across every mode, the application header shows your **active namespace** as a colored pill. The active namespace is the default for any new connection, component, or dashboard you create — it doesn't filter what you see (that's what the per-list namespace filter is for). Click the pill to switch. See [Namespaces](namespaces.md) for the full picture.

## Switching Modes

Click the mode toggle buttons in the header bar. Your current mode is highlighted. The selected mode persists across browser sessions.
