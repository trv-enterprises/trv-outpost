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

## Kiosk Mode

For dedicated displays (lobby screens, wall-mounted iPads, NUC + TV),
there are two kiosk options.

### Kiosk status board (`/kiosk`)

The **`/kiosk`** surface is a chromeless, display-only board: no app
header, toolbar, or controls — just the dashboard grid, sized to fill
the whole screen. It rotates through an ordered list of dashboards you
define in the URL.

```
https://your-dashboard/kiosk?dashboards=<entry>,<entry>,…&rotate=30
```

- **`dashboards`** — an ordered list of **entries**. An entry is a
  dashboard ID, optionally pinned to a connection:
  - `<id>` — show the dashboard as-is.
  - `<id>:connection=<connectionId>` — show the dashboard but re-scope
    every panel to the given connection (see
    [Dashboard Variables](#dashboard-variables-connection-scoping) below).
  - The **same dashboard may appear more than once** with different
    connections, so one layout rotates across hosts — e.g. a
    "System Stats" board cycling `server-1 → pi-1 → server-2`.
- **`rotate=<seconds>`** — auto-advance through the entries every N
  seconds (it pauses while the browser tab is hidden). Omit `rotate`
  for a static, single-board display.
- **`show-notifications=T`** — incoming alerts pop as toasts that fade
  out on their own.
- **`show-pinned=T`** — globally **pinned** alerts stay on screen until
  someone unpins them. Use `show-notifications=F&show-pinned=T` for a
  quiet board that still surfaces an operator-pinned, unresolved issue.

The board is display-only: nothing is clickable and it never navigates
away from its rotation.

### Legacy view-mode lock

The regular viewer also supports a **URL-payload lock** that restricts a
normal View-mode session to a dashboard set:

```
https://your-dashboard/?dashboards=<id1>,<id2>,<id3>
```

The View-mode tile grid then shows only the locked dashboards (with a
purple **"Kiosk mode"** badge), prev/next walk only that set, and manual
reorder / "Set as Default" are disabled. Exit with `?clearKiosk=1`.
This keeps the app chrome; use `/kiosk` for a true chromeless board.

### Delivering the URL

To deliver a kiosk URL without exposing a personal launch URL, pair it
with an API key on a system user — see [API Keys](api-keys.md) and the
Control-capability notes in [User Management](user-management.md).

## Dashboard Variables (connection scoping)

A dashboard can carry **variables** that re-scope its components at view
time, so one dashboard serves many hosts/sites. The header shows a
dropdown per variable (in normal view mode), and a kiosk entry can set a
variable from the URL (`:connection=<id>`).

Today the variable does a **connection swap**: selecting a connection
repoints every panel to it (each panel keeps its own connection unless
it follows the variable). Candidate connections are discovered by
**tag** — connections sharing the variable's tags appear in the dropdown.
*(Parameter substitution — feeding a value into queries/filters, and a
time-range variable — is planned.)*

### Tagging matters: real-time vs. query connections

> **Important.** If you have **both** a real-time (WebSocket / streaming)
> and a SQL/API connection to the **same source**, distinguish them with
> tags and use the right one on each component.

The variable picker offers connections by tag, so tagging is how you
keep the streaming and query worlds separate:

- Tag your **real-time / WebSocket** connections (e.g. `ts-store`,
  `websocket`, `realtime`) and use them on your **live charts** — the
  ones that stream and update continuously.
- Tag your **SQL / API** connections (e.g. `sql`, `api`, `history`) and
  use them on components that do **time-range / point-in-time lookups**.

If both point at the same underlying system but aren't distinguished,
the variable can hand a live chart an API connection (or vice versa),
and it won't get the data shape it expects. Consistent, intentional
tagging — and choosing the matching connection on each component — is
what makes connection scoping work cleanly.
