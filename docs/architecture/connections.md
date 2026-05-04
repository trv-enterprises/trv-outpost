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

ts-store is a Go-based time-series circular-buffer store (separate
project in `simulators/` for local testing).

- **Config**: base URL, API key, store name, ring size
- **Capabilities**: read, stream (via WebSocket push)
- **Schema**: discovered at runtime by sampling recent objects and
  probing JSON structure
- **Query types**: `newest`, `oldest`, `since:DURATION`,
  `range:START:END` (epoch-nanosecond range)
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
- [Datasource processing](../datasources/DATASOURCE_PROCESSING.md) —
  post-query filtering, aggregation, and column-mapping pipeline
- [ts-store architecture](../datasources/TSSTORE_ARCHITECTURE.md) —
  deep dive on the ts-store circular-buffer adapter
