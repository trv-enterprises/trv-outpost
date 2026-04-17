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
- **MCP server** — both an integrated SSE endpoint and a standalone
  MCP-over-stdio binary — so external AI clients like Claude Desktop
  can introspect and query connections

## High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 React frontend (Vite, port 5173)                 │
│     Carbon Design System · ECharts · React Router                │
│  Design mode     │  View mode       │  Manage mode               │
│  - Connections   │  - Dashboard     │  - Users                   │
│  - Components    │    viewer        │  - Settings                │
│  - Dashboards    │  - Live data     │  - Devices                 │
│  - AI Builder    │  - Fit modes     │                            │
└─────────────────────────────────────────────────────────────────┘
                               │
                               │  REST · SSE · WebSocket
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Go backend (port 3001)                        │
│           Gin · Eclipse Paho · Anthropic SDK · Swaggo            │
│  /api/connections  /api/charts  /api/dashboards  /api/devices    │
│  /api/tags  /api/ai/sessions  /api/frigate  /api/users  ...      │
└─────────────────────────────────────────────────────────────────┘
                               │
               ┌───────────────┼───────────────────────┐
               ▼                                       ▼
        ┌────────────┐                         ┌────────────────┐
        │  MongoDB 7 │                         │  External      │
        │            │                         │  connections   │
        │ Dashboards │                         │  (SQL, REST,   │
        │ Components │                         │  MQTT, ...)    │
        │ Datasources│                         └────────────────┘
        │ Users      │
        │ Devices    │
        └────────────┘
```

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
