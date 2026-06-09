# TRV Outpost

A full-stack application for creating, managing, and viewing dynamic
data visualization dashboards with AI-powered component generation,
real-time streaming, and smart device control, built by a technologist
that has been building complex system for over 40 years. This was my first
large development using Claude Code to assist me in the development, 
testing, and documentation. 

The dashboards have visualization, control and display. Control and Display are
dependant on specific technologies in my homelab. These areas will be more generalized
in the future. The component types can be turned off. The Vissulaization layer on
the otherhand was the primary motivation to this repo and should be able to be used
in most any environment.

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
- **Dashboard Assistant** — an in-app chat agent that builds whole
  dashboards from a one-line natural-language prompt: it probes the
  connection, plans the layout, creates the components, and assembles
  the dashboard. The same capability is available to external agents
  through the MCP server. See [examples/dashboards](examples/dashboards/)
  for a walkthrough of a multi-panel Prometheus monitoring dashboard
  built from a single prompt.

## High-level architecture

```
┌────────────────────────────────────────────────────┐  ┌──────────────────────┐
│            React frontend (Vite, :5173)            │  │  External AI agents  │
│       Carbon · ECharts · React Router              │  │  (Claude Desktop +   │
│  Design mode  │ View mode  │ Manage mode           │  │   other MCP clients  │
│  - Conns      │ - Viewer   │ - Users               │  │   via mcp-proxy)     │
│  - Components │ - Live data│ - Settings            │  │                      │
│  - Dashboards │ - Fit modes│ - Devices             │  │  inputs:             │
│  - AI Builder + Dashboard Assistant (chat)         │  │  agent-driven        │
│  - Component "Edit with AI"                        │  │  + deployment key    │
└────────────────────────┬───────────────────────────┘  └──────────┬───────────┘
                         │  REST · SSE · WebSocket                  │  MCP / SSE
                         ▼                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                Go backend (port 3001)                                       │
│                       Gin · Eclipse Paho · Anthropic SDK · Swaggo                           │
│  /api/connections  /api/components  /api/dashboards  /api/devices  /api/users               │
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

AI-assisted building runs server-side: the **Dashboard Assistant**
(in-app chat) and the in-editor **Component AI agent** call Anthropic
with a tool surface over `/api/ai/sessions`, while **external agents**
(Claude Desktop, etc.) reach the same component/dashboard tools through
the MCP endpoints. See [examples/dashboards](examples/dashboards/) for a
full end-to-end run.

For the full architecture — data model, streaming internals,
connection adapters, grid system, API reference, etc. — see the
**[architecture doc set](docs/architecture/ARCHITECTURE.md)**.

## Quick start

### Option 1 — Docker (try it without installing anything else)

If you have Docker, you can have the dashboard running in one
command. Pulls the published images from `ghcr.io`; no source build,
no language toolchains required.

```bash
git clone https://github.com/trv-enterprises/trv-outpost
cd trv-outpost
docker compose -f docker-compose.deploy.yml up -d
```

Open <http://localhost> (Caddy serves the SPA on port 80; the
self-signed HTTPS cert on 443 also works if you accept the warning).

To customize anything — pin a specific release, set an Anthropic key
to enable the AI Builder, enable Clerk sign-in, change ports — copy
`.env.example` to `.env` and edit. The defaults are tuned for "I want
to see the dashboard on my laptop right now."

### Option 2 — Native (run Go + React directly for development)

For active development on the codebase. Starts the Go server and
Vite dev server with hot reload.

#### Prerequisites
- Go (version in [`server-go/go.mod`](server-go/go.mod))
- Node.js 18+
- Docker + Docker Compose (for the bundled MongoDB)

```bash
# Start MongoDB only
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
deployment options (HTTPS via Let's Encrypt, building images from
source, backup + restore).

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
  ([dashboards](examples/dashboards/) shows a multi-panel Prometheus
  dashboard built from a single natural-language prompt)
- [Deployment guide](docs/DEPLOYMENT.md) — production deployment
- [Test plan](docs/TEST_PLAN.md)
- [Project CLAUDE.md](CLAUDE.md) — conventions for contributors
- Historical plans and archived implementation notes live under
  [`docs/plans-archive/`](docs/plans-archive/)

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting,
the scanning tools used (`npm audit`, `govulncheck`, `gitleaks`),
and the project's known security posture.

## License

Apache 2.0 — see [LICENSE](LICENSE).

## Acknowledgements

This project bundles third-party assets. See
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md) for full
attribution and license texts.
