---
title: Extensions overview
sidebar_position: 1
---

# Extensions

Extensions are optional, add-on features that live under Design mode
at `/design/extensions/*`. Each extension is independently toggled
by an admin in **Manage → Settings**; when an extension is off, both
its sidebar entry and its backing API surface disappear.

Today there are two extensions:

- **[ts-store Alerts](./tsstore-alerts.md)** — central management
  page for ts-store alert rules across every ts-store connection in
  the deployment.
- **[EdgeLake Terminal](./edgelake-terminal.md)** — an interactive
  AnyLog/EdgeLake command shell against any EdgeLake connection.

## Why extensions?

The core dashboard surface (Layouts, Connections, Components,
Dashboards) covers what every deployment needs. Extensions cover
features that only matter to a subset of deployments — if you don't
use ts-store, the ts-store Alerts UI is noise; if you don't use
EdgeLake, the terminal is noise. Toggles let admins keep the
sidebar focused on what their users actually do.

## How toggling works

Each extension has a boolean admin setting,
`extensions.<name>.enabled`. The setting defaults to **on** when a
new extension ships — so upgrading the dashboard always lights up
the latest extensions for review, never silently hides one.

When the setting is off:

- The sidebar entry under **Design → Extensions** hides.
- The route at `/design/extensions/<name>` redirects to `/design`.
- The backing API endpoint (`/api/<name>/*`) returns **403
  extension_disabled**, with a message pointing back to Manage →
  Settings.

The third bullet matters: the server enforces the toggle on its
own, independent of the UI. A disabled extension's API is gone
from the running deployment, not just hidden from view.

If every extension is disabled, the **Extensions** group in the
sidebar disappears entirely.

## Where extensions live in the codebase

If you're building a new one:

- Add a settings key `extensions.<name>.enabled` to
  `server-go/config/user-configurable.yaml`.
- Add a `RequireExtensionEnabled` middleware on the route group:
  ```go
  group := api.Group("/<name>")
  group.Use(middleware.RequireExtensionEnabled(
      settingsService, "extensions.<name>.enabled", "<Display Name>",
  ))
  ```
- Add the entry to `client/src/config/extensions.js`. The sidebar
  reads from this list and filters by the same setting.
- Wire the route in `client/src/App.jsx`.

See `client/src/config/extensions.js` for the canonical shape.
