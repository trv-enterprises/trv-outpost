---
sidebar_position: 16
---

# Connection Types

## SQL Database

Connect to relational databases for structured data queries.

**Supported Drivers**: PostgreSQL, MySQL, SQLite

**Configuration**:
- Host, Port, Database name
- Username and Password
- SSL mode (and per-connection TLS skip-verify — see [TLS Skip-Verify](#tls-skip-verify) below)
- Connection pool settings
- Query timeout

**Usage**: Write SQL queries in the chart editor's query configuration. Supports parameterized queries.

## REST API

Connect to HTTP APIs for fetching data.

**Configuration**:
- Base URL
- Default headers
- Authentication: None, Basic (user/pass), Bearer token, API Key
- Retry settings
- Response timeout

**Usage**: Configure HTTP method, path, query parameters, and body in the chart editor. Response data is parsed and mapped to chart fields.

## WebSocket

Real-time streaming connections for telemetry, and optionally
bidirectional for sending commands.

**Configuration**:
- WebSocket URL (ws:// or wss://)
- **Bidirectional** checkbox — when set, the connection gains
  write capability and can power control components. Unidirectional
  WebSocket connections are read-only.
- Reconnect settings (interval, max attempts)
- TLS skip-verify (when using `wss://`) — see [TLS Skip-Verify](#tls-skip-verify)
- **Connection-level parser** — see [Parser Config](#parser-config-websocket--tcp)

**Usage**: Subscribe to messages for real-time chart updates. With
the Bidirectional flag, controls can send commands to devices over
the same socket.

## MQTT

Message broker connections for IoT device communication.

**Configuration**:
- Broker host and port
- Client ID
- Username and Password
- SSL/TLS settings

**Features**:
- Topic discovery: Browse available topics on the broker
- Topic sampling: Preview message payloads and data structure
- Multi-topic subscription
- Bidirectional: Subscribe for state, publish for commands

**Usage**: Primary connection type for control components (plugs, dimmers, toggles). Charts can also subscribe to MQTT topics for real-time data.

## CSV File

Read data from CSV files.

**Configuration**:
- File path
- Delimiter character
- Header row detection
- Encoding
- Watch for changes

**Usage**: Static data sets, configuration files, or regularly updated exports.

## TS-Store

Connect to a TS-Store time-series database.

**Configuration**:
- Protocol (http/https)
- Host and Port
- Pinned store (optional — see below)
- API key

**Pinned vs endpoint-scoped**: the store field is an optional *pin*.
Set it and the connection is bound to exactly that store — every
component on it reads that store, and today's connections keep working
unchanged. Leave it empty and the connection is **endpoint-scoped**: it
identifies just the ts-store server and API key, and each component
chooses its own store from a dropdown in the component editor (the list
shows the stores the key can read). One endpoint-scoped connection can
serve components reading many different stores — like one SQL
connection serving many tables. Streaming transport currently requires
a pinned store; endpoint-scoped streaming is planned.

**Usage**: Time-series data queries for monitoring dashboards. Supports
server-side downsampling: under a dashboard [time-range variable](dashboard-variables.md#range-options),
ts-store charts get a **step** dropdown (both rest and streaming
transports), and the server clamps the step to a point budget so a wide
window at a fine step can't overload the store.

The component editor's query type **Current State (latest per series)**
(rest transport, ts-store v0.19.0+) returns the single newest record for
each distinct value of a field — e.g. one row per container with its
latest CPU and memory. Ideal for a Data View "current status" table or
status tiles: enter the field that identifies the series (like
`container` or `host`) and every series comes back in one request, even
ones that haven't reported recently. The optional substring filter still
applies, and a time-range variable narrows results to series that
reported within the window.

## Prometheus

Connect to a Prometheus metrics server.

**Configuration**:
- Base URL
- Credentials (optional)
- Query timeout

**Features**:
- Schema discovery: Browse available metrics
- Visual PromQL builder
- Label value autocomplete

**Usage**: Infrastructure monitoring dashboards. Supports instant queries and range queries. Under a dashboard [time-range variable](dashboard-variables.md#range-options), range panels pick the window up automatically and get a **step** dropdown for server-side downsampling.

## EdgeLake

Connect to an EdgeLake distributed database network.

**Configuration**:
- Host and Port
- Query timeout

**Features**:
- Cascading schema discovery: Database > Table > Columns
- Distributed query support across network nodes
- Visual query builder

**Usage**: Edge computing and IoT data aggregation dashboards.

## Synology DSM

Connect to a Synology NAS to chart its system, package, service, and storage state.

**Configuration**:
- DSM base URL, including the port (e.g. `https://nas.example:5001`)
- Username and password
- Query timeout
- **Skip TLS verification** — usually required, since DSM ships a self-signed certificate

The account needs administrator privilege for `SYNO.Core.*` reads. A plain user gets a permission error (DSM code 105) on most APIs.

**Features**:
- Schema discovery across the supported DSM APIs
- **DSM API picker** — choose what to read by name; the method, version, and result path are filled in for you
- Polled streaming for live tiles

**Usage**: Home-lab and NAS status dashboards — CPU and memory load, disk health and temperature, which packages and services are running.

**Choosing a query**: Pick an entry from the **DSM API** dropdown in the component editor:

| DSM API | What it returns |
|---|---|
| System Info | Model, serial, firmware, CPU, uptime — one row |
| System Utilization | Live CPU, memory, network, and disk load — one row |
| Installed Packages | Installed packages with running status — one row per package |
| Services | DSM services and whether each is enabled — one row per service |
| Storage Disks | Physical disks with health, temperature, capacity — one row per disk |

A component saved before this picker existed, or one pointing at a DSM API outside this list, keeps working exactly as saved and is labelled **Custom query** in the editor. Selecting a preset replaces it.

## Parser Config (WebSocket / TCP)

WebSocket and TCP socket connections expose a connection-level
parser config so the wire format only has to be described once,
not on every component that reads from the connection.

**Fields**:
- **`data_path`** — JSON path to the array of records inside each
  inbound message (e.g. `data` if the broker emits
  `{ "data": [...] }`).
- **`timestamp_field`** — record field that carries the timestamp.
- **`timestamp_scale`** — multiplier to convert the source unit to
  milliseconds since epoch (e.g. `1` for ms, `1000` for seconds,
  `0.001` for nanoseconds, or `auto` to let the server infer).

A **ts-store preset** pre-fills these fields with the convention
used by the ts-store push transport so a typical ts-store
connection only needs the URL.

The connection editor includes a live **Test** panel that takes a
sample inbound message and shows the records the parser would
extract — useful for confirming `data_path` is correct before
saving.

**MQTT does not use the connection-level parser.** Because a single
broker multiplexes many topics with potentially different shapes,
the parser is configured per component (on the chart, control, or
display that subscribes to a topic), not on the connection.

## TLS Skip-Verify

For connecting to endpoints with self-signed or otherwise
not-yet-trusted TLS certificates (common in homelab / lab
environments).

**Two-gate model — both must be on:**

1. **Deployment-wide kill switch**: `api.allow_insecure_tls` in
   `config.yaml`, or the `DASHBOARD_API_ALLOW_INSECURE_TLS=true`
   env var. Defaults to off. Logged at server boot.
2. **Per-connection toggle**: `insecure_skip_verify` on the
   connection's config, surfaced as a UI toggle in the connection
   editor (only when the URL uses a TLS-capable scheme).

Either gate closed leaves the adapter at the default secure
posture. The server logs a per-call warning when a connection
requests skip-verify but the deployment kill switch is denying.

**Supported on**: REST API, MQTT, WebSocket, TCP socket,
Prometheus, EdgeLake, ts-store.

---
