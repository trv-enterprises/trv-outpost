# TRVE Dashboards

A full-stack application for creating, managing, and viewing dynamic
data visualization dashboards with AI-powered component generation,
real-time streaming, and smart device control.

## What it does

- **Dashboards** with a 32-px cell grid, configurable column count,
  and four fit modes (Actual size / Fit to window / Fit to width /
  Stretch to fill)
- **Charts, controls, and displays** composed into dashboards. Chart
  code is stored in the database and evaluated at runtime — no
  build-and-deploy cycle for new components
- **AI Component Builder** for generating chart components via
  Anthropic Claude with SSE streaming
- **Real-time data** over SSE from 10 built-in connection types:
  SQL, REST API, CSV, WebSocket (read-only or bidirectional),
  TCP, MQTT, Prometheus, EdgeLake, ts-store, Frigate NVR
- **Type availability gating** — admins enable / disable connection
  and component types (and bundled integrations like Frigate or
  Weather) per deployment from the Settings UI, propagating to
  pickers, the AI agent, and the MCP catalog
- **Namespaces** — every connection, component, and dashboard
  belongs to a namespace; uniqueness is `(namespace, name)` so two
  namespaces can each have a dashboard called `Home` without
  colliding. The active namespace lives in the header (drives
  defaults for new records); list pages multi-select-filter by
  namespace
- **Dashboard export / import** — bundle one or more dashboards plus
  their referenced components and connections into a single JSON
  file. Re-import to update in place (preserved IDs, same target
  namespace) or to copy into a different namespace (re-minted IDs).
  Import preflight classifies every object as identical / conflict
  / new / blocked and surfaces per-object diffs for review before
  any writes
- **MQTT retained-state replay** so panels repopulate instantly on
  dashboard switches instead of waiting for the next publish
- **Shared tag filtering** across connections, components, and
  dashboards with autocomplete and case-insensitive collation
- **Smart device control** (Zigbee, Caséta) through bidirectional
  MQTT and WebSocket connections, with a capability-based device
  type system
- **Frigate NVR integration** with camera snapshots, live streams,
  and a thumbnail grid of unreviewed alerts
- **Role-based user management** (Admin, Designer, Support)
- **MCP server** — integrated SSE endpoint at `/mcp/sse` so external
  AI clients like Claude Desktop (via [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy))
  can introspect connections, create components, and build whole
  dashboards via a single tool surface
- **Dashboard-builder agent** (`cmd/dashboard-agent`) — a reference
  CLI agent that drives the same MCP tools as an external client
  would, producing a complete dashboard from a one-line natural-
  language prompt. See [examples/dashboard-agent](examples/dashboard-agent/)
  for a walkthrough of a 14-panel Prometheus monitoring dashboard
  built in 12 turns.

## High-level architecture

```
┌─────────────────────────────────────────┐  ┌──────────────────────┐  ┌──────────────────────┐
│      React frontend (Vite, :5173)       │  │  cmd/dashboard-agent │  │  External AI agents  │
│  Carbon · ECharts · React Router        │  │  (CLI, ships in repo)│  │  (Claude Desktop +   │
│ Design mode  │ View mode  │ Manage mode │  │                      │  │   other MCP clients  │
│ - Conns      │ - Viewer   │ - Users     │  │  inputs:             │  │   via mcp-proxy)     │
│ - Components │ - Live data│ - Settings  │  │  --user, --prompt,   │  │                      │
│ - Dashboards │ - Fit modes│ - Devices   │  │  [--connection-id],  │  │  inputs:             │
│ - AI Builder │            │             │  │  [--dimensions], ... │  │  user-driven chat    │
│              │            │             │  │  + ANTHROPIC_API_KEY │  │  + ANTHROPIC_API_KEY │
└──────────────────┬──────────────────────┘  └──────────┬───────────┘  └──────────┬───────────┘
                   │  REST · SSE · WebSocket            │  MCP / SSE              │  MCP / SSE
                   ▼                                    ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Go backend (port 3001)                                       │
│                       Gin · Eclipse Paho · Anthropic SDK · Swaggo                           │
│  /api/connections  /api/charts  /api/dashboards  /api/devices  /api/users                   │
│  /api/tags  /api/ai/sessions  /api/frigate      /mcp/sse  /mcp/message   ...                │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
                                              │
                              ┌───────────────┼────────────────────────┐
                              ▼                                        ▼
                       ┌────────────┐                          ┌────────────────┐
                       │  MongoDB 7 │                          │  External      │
                       │            │                          │  connections   │
                       │ Dashboards │                          │  (SQL, REST,   │
                       │ Components │                          │  MQTT, ...)    │
                       │ Datasources│                          └────────────────┘
                       │ Users      │
                       │ Devices    │
                       └────────────┘
```

`cmd/dashboard-agent` is a reference MCP client we ship with the
repo — it consumes the same `/mcp/sse` surface as Claude Desktop. The
agent calls Anthropic directly for its LLM turns, then issues tool
calls back through MCP to build connections, components, and
dashboards. See [examples/dashboard-agent](examples/dashboard-agent/)
for a full end-to-end run.

For the full architecture — data model, streaming internals,
connection adapters, grid system, API reference, etc. — see the
**[architecture doc set](docs/architecture/ARCHITECTURE.md)**.

## Quick start

### Prerequisites

- Go (version in [`server-go/go.mod`](server-go/go.mod))
- Node.js 18+
- Docker + Docker Compose
- MongoDB 7 (via Docker Compose below)

### Run locally

```bash
# Start MongoDB
docker compose up -d mongodb

# Start the Go backend (Terminal 1)
cd server-go
go build -o bin/server cmd/server/main.go && ./bin/server
# Listens on http://localhost:3001
# Swagger UI at http://localhost:3001/swagger/index.html

# Start the React frontend (Terminal 2)
cd client
npm install
npm run dev
# Dev server at http://localhost:5173
```

Then open <http://localhost:5173>.

See [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) for production
deployment (Docker Compose, Caddy reverse proxy, HTTPS, backup +
restore).

## Application modes

- **Design mode** (`/design/*`) — author connections, components,
  and dashboards. AI Builder lives here as an alternate path to
  component creation.
- **View mode** (`/view/*`) — end-user dashboard runtime with
  real-time data, auto-refresh, fullscreen, and four fit modes.
- **Manage mode** (`/manage/*`) — admin settings, user management,
  device and device-type management.

## Documentation

- **[Architecture doc set](docs/architecture/ARCHITECTURE.md)** —
  start here for anything technical. Sub-documents cover data
  model, backend, frontend, streaming, connections, database, API
  reference, and the grid system.
- [MCP server](docs/mcp.md) — tool inventory, agent flow, and
  Claude Desktop setup via `mcp-proxy`
- [Examples](examples/) — reference runs and demos
  ([dashboard-agent](examples/dashboard-agent/) shows the CLI agent
  building a 14-panel Prometheus dashboard end-to-end)
- [Deployment guide](docs/DEPLOYMENT.md) — production deployment
- [Test plan](docs/TEST_PLAN.md)
- [Project CLAUDE.md](CLAUDE.md) — conventions for contributors
- Historical plans and archived implementation notes live under
  [`docs/plans-archive/`](docs/plans-archive/)

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Acknowledgements

This project bundles third-party assets. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full
attribution and license texts.
