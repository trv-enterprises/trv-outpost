# Connections

"Connection" is the user-facing name for an external data or device
endpoint the dashboard talks to. Internally the code calls them
`connections` and the MongoDB collection is named `connections` for
backwards compatibility. The UI and `/api/connections` endpoints are
the canonical names going forward; `/api/connections` is kept as a
deprecated alias.

Every connection has:

- A unique case-insensitive `name` (scoped by the MongoDB collation
  described in [database.md](database.md))
- A `type` string that chooses the adapter and config shape
- A per-type `config` sub-document with credentials and routing
  details
- Optional `tags` (see the shared tag filtering in the frontend)
- Capability metadata (`canRead`, `canWrite`, `canStream`) contributed
  by the adapter
- A `health` sub-document maintained by a background check sweep

Sensitive fields are always scrubbed on API responses; clients
update them by POST/PUT with new values.

## Adapter registry

Adapters live under `internal/connection/` and are registered at
init time with `internal/registry/`. Each adapter supplies:

- A **type ID** like `"db.postgres"`, `"stream.mqtt"`, `"store.tsstore"`
- A **label** shown in the UI
- A **capability set** (read/write/stream)
- A **config schema** describing each field (name, type, required,
  options, description) — used by the frontend to render the editor
  form without hard-coding per-type UI
- A **factory function** `(config map[string]interface{}) (Adapter, error)`
- Optionally, a **query surface** (`registry.RegisterQuerySurface`)
  describing how queries for the type are AUTHORED — see below

### Query surfaces

Most types are authored through a raw query box plus, for a few, a
bespoke builder component hardcoded in `ComponentEditor.jsx`. That
works while the raw string is the whole query, but it breaks down for
an adapter whose `query_config.params` carry **required dispatch
fields**: the editor renders no input for them, so a component built
from scratch sends them empty and the query fails. (This was issue
#226 for Synology, where a bare call returns DSM error 120.)

A `QuerySurface` lets the adapter declare its own authoring UI as
data, next to its `Register` call:

```go
registry.RegisterQuerySurface("api.synology", registry.QuerySurface{
    Kind:    registry.QuerySurfaceCatalog,
    Label:   "DSM API",
    Presets: []registry.QueryPreset{{
        ID: "packages", Label: "Installed Packages",
        Raw: "SYNO.Core.Package",
        Params: map[string]interface{}{"method": "list", "version": 2, ...},
    }},
})
```

The adapter is the only place that knows what a valid query for it
looks like, so it is where that gets said. `TypeInfo.query_surface`
then rides along on `GET /api/registry/connections`, and the editor
renders whichever surface it finds — keyed on "this type declared
one," not on a type name, so a new adopter needs no editor change.

`Kind` is the forward-compatibility seam. Today only
`catalog` exists (a fixed list of named presets, each carrying the
full raw+params tuple so dispatch mechanics are never rendered as user
inputs). A type with modes or dependent fields can declare a new kind
and grow its own renderer without disturbing what already ships.
Types that declare nothing serve a nil field and keep the raw box.

The adapter interface is deliberately small. An adapter implements
whichever of these fit its capabilities:

- `Query(ctx, query) (*ResultSet, error)` — point-in-time read
- `Stream(ctx) (<-chan Record, error)` — continuous read
- `Write(ctx, payload) error` — command / publish
- `Schema(ctx) (*Schema, error)` — introspection (optional)

The `ResultSet` returned by `Query` is normalized: `{ columns:
[]string, rows: [][]interface{}, metadata: map }`. This is the same
shape across SQL, REST, CSV, Prometheus, EdgeLake, and ts-store, so
the React data layer and chart components don't care which type
they're rendering.

## Built-in types

### `db.postgres` / `db.mysql` / `db.sqlite` / `db.mssql` / `db.oracle`

Generic SQL adapter backed by Go's `database/sql` plus per-dialect
drivers (`lib/pq`, `go-sql-driver/mysql`, `mattn/go-sqlite3`, etc.).

- **Config**: host, port, database, username, password, ssl mode,
  query timeout, connection pool size
- **Capabilities**: read, query. No streaming.
- **Schema discovery**: lists tables and columns via
  `information_schema`.
- **Query type**: raw SQL with parameter substitution (`$1`, `?`,
  etc. per dialect).

The visual SQL query builder (`client/src/components/SQLQueryBuilder.jsx`)
uses the discovered schema to offer column selection, filtering, and
ordering without typing raw SQL.

### `api.rest`

HTTP/JSON REST API adapter.

- **Config**: base URL, method, path template, headers, auth (Bearer,
  Basic, API-Key, or none), retry policy, response extraction path
- **Capabilities**: read. Writes are possible but not currently
  exposed through the UI.
- **Secrets**: bearer tokens and API keys are masked via
  `SanitizeForAPI`.

### `api.prometheus`

Prometheus-specific adapter with a visual PromQL query builder.

- **Config**: Prometheus server URL, optional basic auth
- **Capabilities**: read, schema discovery
- **Schema**: lists metric names and label values via
  `/api/v1/labels` and `/api/v1/label/:name/values`
- **Query type**: both instant and range PromQL queries
- **Editor**: `PrometheusQueryBuilder.jsx` composes PromQL from a
  metric dropdown + label filter chips instead of raw text

### `api.edgelake`

EdgeLake / AnyLog distributed-database adapter.

- **Config**: EdgeLake node URL, credentials
- **Capabilities**: read, schema discovery (cascading: databases →
  tables → columns)
- **Schema endpoints**: `/api/connections/:id/edgelake/databases`,
  `/.../tables`, `/.../schema`
- **Editor**: `EdgeLakeQueryBuilder.jsx` drives a visual builder for
  SELECT queries against discovered tables

### `api.synology`

Synology DSM adapter — reads system, package, service and storage
state off a NAS.

- **Config**: DSM base URL (including port), username, password,
  timeout, `insecure_skip_verify` (DSM ships a self-signed cert).
  Deliberately **no** `session` field: DSM 7 validates that parameter
  against known app names and answers 402 for anything else.
- **Capabilities**: read, stream (polled), schema discovery
- **Session handling**: DSM issues a SID that expires on an
  unpublished schedule. Rather than predict expiry, a call that fails
  with a session error triggers exactly one re-login + retry. The SID
  is runtime state and is never persisted.
- **Query**: `raw` is the DSM API name (e.g. `SYNO.Core.Package`);
  `params` carry the dispatch tuple `method` / `version` /
  `result_path` / `additional`. All four must be right or DSM errors
  or returns an unchartable shape — so they are supplied by the
  catalog, never typed by a user.
- **Editor**: a **query surface** of kind `catalog` (see above). The
  author picks a DSM API by name; the preset supplies the tuple.
- **Catalog**: `connection.SynologyCatalog` in `synology.go` is the
  single source of truth. Both the editor picker (via the query
  surface) and the schema prober in `connection_service.go` derive
  from it, so they cannot drift. Adding an API is a one-place edit.
- **Result shape**: a `result_path` resolving to an ARRAY gives one
  row per element (tall); an OBJECT gives a single wide row with
  dot-joined column names.

#### DSM API limits

Observed against a live DSM 7 box on 2026-07-31. These are properties
of DSM, not of the adapter — re-verify after a DSM major upgrade.

- **`additional` is per-API, and failure is silent.**
  `SYNO.Core.Package` honors it: without `["status","description"]`
  a package row carries only `additional.install_type`; with it, the
  `additional` object gains `status` and `description`.
  `SYNO.Core.Service` ignores it entirely — same request with and
  without the parameter returns byte-identical data, no error, no
  `additional` key on any row. Passing it there is a no-op, so a
  missing `Additional` on the services catalog entry is correct
  rather than an oversight.
- **`SYNO.Core.Service` version changes the name field.** v1 does not
  exist (error 103). v2 and v3 both return the same 20 rows and the
  same `enable_status`, but differ in one column:

  | version | name column                | `ssh-shell` value                     |
  |---------|----------------------------|---------------------------------------|
  | v3      | `display_name_section_key` | `firewall:firewall_service_opt_ssh`   |
  | v2      | `display_name`             | `SSH`                                 |

  v3's value is an i18n lookup key that needs DSM's translation
  tables to resolve; v2 returns the label already resolved. The
  catalog currently dispatches v3. Switching to v2 trades the key for
  a human-readable label but **renames the column**, which breaks
  components binding `display_name_section_key`.
- **`method` is per-API too.** Package uses `list`; Service uses
  `get` and answers 103 for `list`. Don't assume a method carries
  across APIs.
- **`enable_status` is configuration, not run-state.** Values are
  `enabled` / `disabled` / `static`, where `static` means "not
  user-togglable" — **not** "running". DSM exposes no per-service
  run-state anywhere in this API family: `SYNO.Core.Service.Info`
  does not exist (confirmed against the full 632-API
  `SYNO.API.Info` enumeration), `SYNO.Core.Service.PortInfo` rejects
  both `get` and `list`, and `SYNO.Core.Service.Conf` returns a
  single global `service_fw_target_interface` field. Determining
  whether a daemon is actually up requires probing it off-box — see
  [synology-service-runstate.md](../design-notes/synology-service-runstate.md).

### `file.csv`

Local file or HTTP URL CSV reader.

- **Config**: file path or URL, has_header flag, delimiter, optional
  column type hints, watch_changes flag
- **Capabilities**: read
- **Detection**: URL-mode checks the URL with an HTTP HEAD; local
  mode uses `os.Stat`. Both paths are exercised by `Test connection`.

### `stream.websocket` / `stream.websocket-bidir`

Generic WebSocket adapters. Read-only and bidirectional variants are
distinct registry types with different capabilities; the connection
editor surfaces this as a single "WebSocket" protocol with a
**Bidirectional** checkbox. When the checkbox is set, the saved
connection resolves to `stream.websocket-bidir` and gains write
capability for control commands.

- **Config**: URL, optional headers, parser config (see below),
  message format (`json` or `text`), reconnect policy, bidirectional
  flag
- **Capabilities**: read, stream — plus write when bidirectional
- **Message formats**: `json` (default — payloads are unmarshaled
  and the parser config applies) or `text` (payload lands verbatim
  in `data`, parser bypassed). Binary frames carrying JSON parse
  transparently because the adapter ignores the frame type and tries
  `json.Unmarshal` on the raw bytes; non-JSON binary protocols
  (MessagePack, protobuf) are not supported in the generic adapter.
- **Connection-level parser** (`json` mode only): `data_path` re-roots
  the record at a nested key, `timestamp_field` lifts a timestamp
  out of the envelope, and `timestamp_scale` (`ns` / `ms` / empty
  for auto-detect) normalizes numeric timestamps to Unix seconds.
  The parser is connection-level because point-to-point streams
  carry one shape — every consumer benefits from one-time unwrap.
  Charts on broker-style connections (MQTT) keep their own
  per-component parser instead.
- **Writes**: `POST /api/controls/:id/execute` sends commands
  through the WebSocket when bidirectional.

### `stream.tcp`

Raw TCP socket adapter. Same parser/format affordances as the
WebSocket adapter (`json` / `text` message format, connection-level
JSON parser config). Read-only; no write side.

UDP support was removed in v0.6 — real-world dashboard telemetry is
overwhelmingly MQTT/WebSocket/REST, and the legacy connected-socket
implementation couldn't receive unsolicited packets in any case.
If a future need for unsolicited UDP arrives it should be a
purpose-built listening adapter, not the legacy dial-then-read
shape.

### `stream.mqtt`

MQTT broker adapter. Eclipse Paho v2 (`autopaho`) for the transport.

- **Config**: broker host + port, client ID, TLS, username, password,
  keepalive, clean session flag, topic discovery scope
- **Capabilities**: read, write, stream
- **Topic discovery**: `GET /api/connections/:id/mqtt/topics` walks
  the broker's tree of topics the client is subscribed to, with a
  sample-mode option that captures a few messages for each topic so
  the UI can preview shapes. `MQTTTopicSelector.jsx` renders this
  as a tree picker.
- **Publishing**: `POST /api/controls/:id/execute` routes through
  the connection's MQTT client to publish a command. Controls use
  this to drive smart devices.
- **Streaming**: handled by `streaming/mqtt_stream.go` with the
  per-topic retained-state cache described in
  [streaming.md](streaming.md).

### `store.tsstore`

ts-store is a Go-based time-series circular-buffer store (the
simulators live in the [trv-outpost-sim](https://github.com/trv-enterprises/trv-outpost-sim)
repo for local testing).

- **Config**: base URL, API key, store name, ring size
- **Capabilities**: read, stream (via WebSocket push)
- **Schema**: discovered at runtime by sampling recent objects and
  probing JSON structure
- **Query types**: `newest`, `oldest`, `since:DURATION`,
  `range:START:END` (epoch-nanosecond range). A `latest_by` param
  (ts-store v0.19.0) turns a `newest` query into a newest-record-
  per-distinct-value lookup — "current state per series" in one
  request. It is mutually exclusive with `step`/`agg_window` server-
  side, so the adapter suppresses any range-picker step (and
  `group_by`) when it is set; a relative range still bounds the scan
  via `since`, and `limit` caps distinct series (unset → ts-store's
  1000-group default).
- **Streaming**: `streaming/tsstore_stream.go`, described in
  [streaming.md](streaming.md)
- **Push direction**: ts-store can also push data into the dashboard
  via `GET /api/streams/inbound/:datasourceId` — an inbound WebSocket
  endpoint the ts-store server dials into

### `frigate`

Frigate NVR (Network Video Recorder) adapter. Frigate is an
open-source video surveillance system with AI-based object detection.
Frigate is registered as an **integration** (see below) so the
connection type plus the Frigate display types can be enabled or
disabled as a single bundle.

The `frigate` connection type is special: it doesn't have a
registered Go adapter (every request proxies through
`internal/handlers/frigate_handler.go`). It surfaces in the type
catalog because the Frigate integration declares
`OwnedConnectionType: "frigate"`.

- **Config**: base URL (HTTP API), go2rtc URL (live stream),
  username, password
- **Capabilities**: read, schema (camera discovery)
- **Proxied endpoints** (all under
  `/api/frigate/:connection_id/...`):
  - `cameras` — list configured cameras
  - `snapshot/:camera` — current still image
  - `events/:camera` — recent detection events
  - `event/:event_id/clip` — MP4 clip (Range-aware for scrubbing)
  - `event/:event_id/snapshot` — detection-event still
  - `reviews` — Frigate review segments (defaults to `reviewed=0`)
  - `review/:review_id/thumbnail` — WebP thumbnail (requires
    `?camera=` query)
  - `reviews/viewed` — mark one or more reviews as reviewed
  - `info` — Frigate system info
  - `live/:camera` — live video proxy via go2rtc

All Frigate requests are proxied through the backend because browsers
can't hit the Frigate host directly (CORS + network segmentation).

## Integrations and type availability

Some types ship as part of a named **integration** that bundles a
connection type with one or more component subtypes (e.g., Frigate
bundles the `frigate` connection with the `frigate_camera` and
`frigate_alerts` displays; Weather bundles the `weather` display
type). Admins can toggle entire integrations on or off from
**Manage → Settings → Type Availability** so deployments without a
given integration don't see its types in pickers, the AI agent's
prompt and tool enums, or the MCP catalog.

Disabling an integration **does not break existing components** —
only creation, AI suggestions, and MCP catalog visibility are
filtered. Dashboards that already use a now-disabled type continue
to render and stream as before. The Frigate proxy routes stay live
regardless of toggle state for the same reason.

The settings system maintains two keys:

- `enabled_types` — the admin's allowlist (per-category arrays plus
  `integrations`).
- `known_types` — server-maintained ledger of every type seen across
  upgrades. New types added in a release auto-enable on first boot
  while admin-disabled items persist.

Filter logic: a type tagged with an integration is enabled only when
that integration is enabled AND its ID appears in the per-category
list. The filter is consumed by the registry HTTP handlers, the AI
agent's catalog provider (rebuilds prompt + tools per message), and
the MCP `list_*_types` tools.

## Testing and health

`POST /api/connections/test` takes a full connection config (or an
ID to resolve masked secrets from the DB) and tries to connect,
authenticate, and issue a minimal probe. For SQL it's `SELECT 1`;
for REST it's a `HEAD` on the base URL; for MQTT it's a connect +
subscribe to `$SYS/#` briefly; for ts-store it's a stats call; for
Frigate it's `GET /api/config`; and so on.

The test result includes `{ success, status, message, response_time_ms }`
so the UI can show both a pass/fail and a latency number.

`POST /api/connections/:id/health` runs the same test against a
stored connection, without taking credentials off the wire. The
background health sweep uses this to keep `connection.health`
current for the list page's status indicators.

## Related docs

- [Database](database.md) — where connections and their health data
  are persisted
- [Streaming](streaming.md) — how read-streams become SSE frames
- [API reference](api-reference.md) — full endpoint tables
- [Aggregation and filtering](aggregation-and-filtering.md) —
  where filtering/aggregation runs (source vs server vs client)
