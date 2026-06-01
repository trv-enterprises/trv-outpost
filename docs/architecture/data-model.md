# Data model

The dashboard persists everything it knows in MongoDB. This page
describes the shape of each core entity. For collection-level
concerns (indexes, collations, migrations), see
[database.md](database.md).

All entities use UUID string IDs assigned at create time; none rely
on MongoDB's `ObjectId`. Most entities carry `created` and `updated`
timestamps; the ones that don't are explicitly noted.

## Namespace

A namespace is a conflict-domain grouping for connections, components,
and dashboards. Two namespaces can each have a record with the same
name without colliding — uniqueness on those entities is `(namespace,
name)`, not just `name`.

```json
{
  "id": "default",
  "name": "default",
  "description": "Default namespace — legacy records migrate here and new records land here unless an active namespace is selected.",
  "color": "#6f6f6f",
  "created": "2026-04-18T22:10:02Z",
  "updated": "2026-04-18T22:10:02Z"
}
```

- **Collection**: `namespaces`
- **Slug** (`name`): `^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$` — case-sensitive,
  globally unique. The `default` slug is immutable; the server's
  startup seed and the `namespacing_v1` migration depend on it.
- **Color**: hex from a Carbon-safe palette; used by the header
  picker and list-page chips so the same namespace reads as the
  same color across the app.
- **Active namespace** is a per-user preference stored in
  `app_config.settings.active_namespace`. It drives the default for
  newly-created records but is independent from the multi-select
  namespace filter on list pages — users can peek at other
  namespaces without changing where new records land.
- **Rename** is a single PUT that cascades the new slug into every
  referring record (connections, components, dashboards) in the same
  request.
- **Delete** is guarded — returns 409 with per-type usage counts
  when any records still reference the namespace. The user must
  move or delete those records first.

## Dashboard

A dashboard is a named grid layout plus a set of panels, each panel
placing either a component (chart / control / display) or a native
text label onto grid cells.

```json
{
  "id": "9f8b...e4",
  "namespace": "default",
  "name": "Home Kiosk",
  "description": "Main living-room kiosk dashboard",
  "tags": ["home", "kiosk"],
  "panels": [
    {
      "id": "panel-1",
      "x": 0, "y": 0, "w": 6, "h": 8,
      "chart_id": "b2c9...c0"
    },
    {
      "id": "panel-2",
      "x": 6, "y": 0, "w": 6, "h": 4,
      "text_config": {
        "content": "Welcome home",
        "display_content": "title",
        "size": 48,
        "align": "center"
      }
    }
  ],
  "thumbnail": "data:image/png;base64,...",
  "settings": {
    "theme": "dark",
    "refresh_interval": 30,
    "title_scale": 100,
    "scale_percent": 100,
    "is_public": false,
    "allow_export": true,
    "layout_dimension": "default-12col"
  },
  "created": "2026-04-01T12:00:00Z",
  "updated": "2026-04-11T09:14:00Z"
}
```

Panels without `chart_id` and without `text_config` are placeholder
empty panels (common during authoring). The `thumbnail` field is a
captured preview used on list pages. `settings.layout_dimension`
names a preset from the `layouts` collection.

`settings.scale_percent` is the dashboard's **build-scale** (50–200,
default 100). `layout_dimension` is the render *target*; the dashboard
is authored on a derived *design* canvas of `target ÷ (scale/100)`, and
the viewer's `transform: scale()` blows it back up to the target —
uniformly enlarging fonts, lines, and layout while preserving
proportions. 100 = build at target (no enlargement); 120 = build on
`target/1.2` so everything renders 20% bigger. (Distinct from
`title_scale`, which scales only the component title font.) New
dashboards seed `scale_percent` from the chosen preset's
`default_scale` (see Layout presets below).

- **Collection**: `dashboards`
- **Name**: case-insensitive unique within a namespace
  (compound `(namespace, name)` index). The same name can exist
  in multiple namespaces.
- **Grid geometry**: `{x, y, w, h}` are in grid cells, not pixels.
  See [grid-system.md](grid-system.md).

## Component

Charts, controls, and displays are all stored in the `components`
collection with a `component_type` discriminator. The umbrella entity
is **Component**; the word "chart" refers strictly to the chart
sub-type (ECharts visualizations).

```json
{
  "id": "b2c9...c0",
  "version": 3,
  "status": "final",
  "component_type": "chart",
  "namespace": "default",
  "name": "Temperature by Location",
  "title": "Temperature by Location",
  "description": "Last hour, binned per minute",
  "chart_type": "line",
  "tags": ["temperature", "sensors"],
  "connection_id": "a1e4...7b",
  "query_config": {
    "raw": "since:1h",
    "type": "stream_filter",
    "params": { "limit": 500 }
  },
  "data_mapping": {
    "x_axis": "timestamp",
    "y_axis": ["temperature"],
    "series": "location",
    "time_bucket": {
      "interval": 60,
      "function": "avg",
      "value_cols": ["temperature"],
      "timestamp_col": "timestamp"
    }
  },
  "component_code": "const Component = () => { ... }",
  "use_custom_code": false,
  "options": { "legend": { "show": true } },
  "created": "2026-03-12T08:00:00Z",
  "updated": "2026-04-05T16:22:00Z"
}
```

### `component_type`

| Value     | Meaning                                               |
| --------- | ----------------------------------------------------- |
| `chart`   | ECharts visualization (bar, line, gauge, table, ...)  |
| `control` | Interactive control (button, toggle, dimmer, ...)     |
| `display` | Non-chart visual (Frigate camera, weather, alerts)    |

Each component type uses different sub-documents:

- Charts use `chart_type`, `query_config`, `data_mapping`, `options`,
  and optionally `component_code` + `use_custom_code` for the
  dynamic React code path.
- Controls carry a `control_config` sub-document with
  `control_type`, `target`, `ui_config`, optional `device_type_id`.
- Displays carry a `display_config` sub-document with
  `display_type` and per-type fields (Frigate connection, weather
  topic prefix, alerts severity, etc.).

See [frontend.md](frontend.md) for how each type is rendered and
[connections.md](connections.md) for how `connection_id` is resolved.

### Versioning

Components keep a version history in the database (all three sub-types).
Each version is its own row, sharing a
logical `id` and differing in `version` (1, 2, 3, …) and `status`
(`draft` | `final`). New versions are created **only by the AI
builder flow**, not by every save:

- **`POST /api/components`** creates `(id, version=1, status=final)`.
- **`PUT /api/components/:id`** (manual editor / API client) updates
  the latest version *in place*. The version number does not bump.
  This means manual edits don't accumulate history rows.
- **AI sessions** create a new draft row when an existing component
  is opened for editing — `(id, version=N+1, status=draft)`. The
  prior final stays untouched and dashboards continue to render it.
  All AI-driven edits during the session update the same draft row
  (no row per turn). On **Save** the draft is promoted to
  `status=final` and becomes the latest. On **Discard** the draft
  row is deleted and the prior final remains the latest.
- **List endpoints** (`GET /api/components`, summaries, dashboard
  expand) always return the latest version per `id`. Old finals
  are reachable only through `/api/components/:id/versions` and the
  per-version GET / DELETE endpoints.

- **Collection**: `components`
- **Uniqueness**: `(id, version)` is unique. Multiple versions share
  a logical `id`.
- **Name**: not a unique index in the database because the same name
  is shared across versions. The `ComponentService` enforces
  case-insensitive name uniqueness within a namespace
  (`(namespace, name)`) in application code by querying for an
  existing component with the same name whose logical `id` differs.
  Renaming a component's namespace fans out to every version row of
  that id so list/filter queries stay consistent regardless of which
  version they hit.

## Datasource (connection)

A datasource is an external data or device endpoint. Connection is
the user-facing name; `connection` is the internal name and the
MongoDB collection name.

```json
{
  "_id": "67ff...3a",
  "namespace": "default",
  "name": "Home MQTT Broker",
  "description": "Mosquitto on the services host",
  "type": "mqtt",
  "tags": ["home", "mqtt"],
  "config": {
    "mqtt": {
      "host": "broker.example.local",
      "port": 1883,
      "client_id": "dashboard",
      "username": "dashboard",
      "password": "********",
      "clean_session": true,
      "keepalive": 60
    }
  },
  "health": {
    "status": "healthy",
    "last_check": "2026-04-11T09:15:23Z",
    "last_success": "2026-04-11T09:15:23Z",
    "response_time": 42
  },
  "created_at": "2026-01-15T10:00:00Z",
  "updated_at": "2026-04-10T18:00:00Z"
}
```

- `type` selects the config sub-document (`config.mqtt`, `config.sql`,
  `config.frigate`, ...)
- Secret fields are always replaced with `"********"` on API
  responses — there is no opt-out. The update path resolves masked
  values back to the stored real values via `preserveSecrets`, so a
  client that reads-then-writes without modifying a secret keeps
  the stored value intact; sending a non-masked value overwrites it.
- `health` is maintained by a background sweep; the list-page status
  indicator reads from it.
- `_id` is a UUID string, matching every other top-level entity.
  Pre-v0.14 deployments stored `_id` as an auto-generated `ObjectId`
  here — the migration in `server-go/cmd/migrate-uuid-ids` rewrites
  legacy data to UUIDs and updates component → connection references.
- **Name**: case-insensitive unique within a namespace
  (compound `(namespace, name)` index). The same connection name
  can exist in multiple namespaces.

See [connections.md](connections.md) for the per-type `config`
fields.

## AI session

Short-lived state for an AI Builder conversation. TTL-expired by
MongoDB.

```json
{
  "id": "sess-7f...",
  "component_id": "b2c9...c0",
  "chart_version": 3,
  "status": "active",
  "dashboard_id": "9f8b...e4",
  "panel_id": "panel-1",
  "messages": [
    { "role": "user", "content": "Show me temp by location" },
    { "role": "assistant", "content": "..." }
  ],
  "created": "2026-04-11T09:00:00Z",
  "updated": "2026-04-11T09:05:12Z",
  "expires_at": "2026-04-11T10:00:00Z"
}
```

- **Collection**: `ai_sessions`
- The session edits a specific component version
  (`component_id` + `chart_version`). The draft component itself
  lives in the `components` collection as a draft version (`status:
  "draft"`), keyed by `(component_id, chart_version)` — not embedded
  on the session record. When the user saves, the draft promotes to
  `final`; when they discard, the draft is deleted.
- **TTL**: `expires_at` field indexed with `ExpireAfterSeconds: 0`,
  so MongoDB sweeps expired sessions automatically.
- `status` transitions: `active → completed | cancelled`.

## Device and device type

Devices are instances of device types. Device types carry the
command schemas and default UI bindings; devices reference a type
and bind it to a specific target (MQTT topic, WebSocket endpoint,
etc.).

```json
// device_type
{
  "id": "zigbee-dimmer",
  "name": "Zigbee Dimmer",
  "category": "lighting",
  "protocol": "mqtt",
  "is_built_in": true,
  "supported_types": ["dimmer", "toggle", "slider"],
  "commands": {
    "dimmer": { "template": { "brightness": "{{value}}" } },
    "toggle": { "template": { "state": "{{value}}" }, "value_map": { "true": "ON", "false": "OFF" } }
  },
  "state_query": { "template": { "get": "state" }, "interval_ms": 5000 },
  "response": { "success_path": "$.success", "state_path": "$.brightness" }
}
```

```json
// device
{
  "id": "...",
  "device_type_id": "zigbee-dimmer",
  "connection_id": "67ff...3a",
  "name": "Kitchen lights",
  "room": "Kitchen",
  "target": "zigbee2mqtt/kitchen/set",
  "enabled": true
}
```

- **Collections**: `devices`, `device_types`
- **Name**: case-insensitive unique on both collections
- The `capabilities` metadata on device types (`canWrite`, `canRead`,
  etc.) is used to filter which controls are compatible

## User

```json
{
  "id": "u-...",
  "guid": "admin-a1b2c3",
  "name": "Admin",
  "active": true,
  "role": "admin",
  "created_at": "2026-01-01T00:00:00Z"
}
```

- **Collection**: `users`
- **`guid`**: opaque string used as the value of the `X-User-ID`
  header for auth. Unique across users.
- **`name`**: case-insensitive unique
- **`role`**: `admin`, `designer`, `support` (matches the pseudo
  users seeded on first startup)

## Layout (preset)

Layout presets are pixel-canvas sizes (`max_width`, `max_height`) that
a dashboard's `settings.layout_dimension` picks from. Example preset
keyed by a human name:

```yaml
1920x1080-HD: {max_width: 1920, max_height: 1080, default_scale: 100}
2560x1440-2k: {max_width: 2560, max_height: 1440, default_scale: 120}
```

Each preset may carry an optional `default_scale` (50–200, default
100). New dashboards seed their `settings.scale_percent` from the
chosen preset's `default_scale` (then become independent — editing the
preset later doesn't retroactively re-scale existing dashboards). This
lets an admin say e.g. "4K boards default to 120%." The AI catalog
reports each preset's cols × rows *already computed at its default
scale*, so the agent plans to the adjusted budget without rate-math.

The cell-count grid (cols × rows) is not preset-specific; it's
derived from the canvas dimensions minus a fixed viewer-chrome
budget. See [grid-system.md](grid-system.md) for the exact formula
and worked examples. Admins manage the preset library through Manage
mode.

## App config and settings

`app_config` holds runtime configuration scoped to either
`system` (global) or a specific `user_id`. User-scoped records are
how per-user preferences like `dashboard_fit_mode` are stored.
`settings` is for admin-surfaced configuration items displayed in
Manage mode (default layout preset, tile font size, etc.).

Both collections use programmatic keys, not human names, so neither
gets case-insensitive collation.

## Control schemas

`control_schemas` holds reusable command schemas that can be shared
across device types. Each schema defines `commands`, `state_query`,
and `response` fields that device types can inherit. Useful when
many devices speak the same wire protocol (e.g. JSON-RPC switches).

## Related docs

- [Database](database.md) — indexes, collations, secret masking,
  migrations
- [Connections](connections.md) — per-type `config` sub-documents
- [Frontend architecture](frontend.md) — how components consume these
  shapes at render time
- [API reference](api-reference.md) — endpoint tables for CRUD
