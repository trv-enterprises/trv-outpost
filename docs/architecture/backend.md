# Backend architecture

The backend is a single Go binary (`cmd/server`) plus an auxiliary
MCP server binary (`cmd/mcp-server`). It talks to MongoDB for
persistence, to external data sources via adapters, and to the
browser over REST, SSE, and a few WebSocket endpoints.

## Layered architecture

```
           ┌───────────────────────────────────────────────┐
           │  Gin HTTP router + middleware (Port 3001)     │
           │  - CORS, auth (X-User-ID), static serving     │
           └────────────────────┬──────────────────────────┘
                                │
           ┌────────────────────▼──────────────────────────┐
           │  Handlers                                     │
           │  handlers/*, streaming SSE handler, MCP SSE   │
           │  - parse request, invoke service, write resp  │
           └────────────────────┬──────────────────────────┘
                                │
           ┌────────────────────▼──────────────────────────┐
           │  Services                                     │
           │  service/*                                    │
           │  - validation, tag normalization, dup checks  │
           │  - secret masking resolution                  │
           └────────┬───────────────┬────────────────────┬─┘
                    │               │                    │
                    │               │                    │
    ┌───────────────▼──┐   ┌────────▼─────────┐   ┌──────▼──────┐
    │ Repositories     │   │ Datasource       │   │ Streaming   │
    │ repository/*     │   │ adapters         │   │ engine      │
    │ - MongoDB CRUD   │   │ datasource/*     │   │ streaming/* │
    │ - index creation │   │ - per-type shims │   │ - per-ds    │
    │                  │   │ - Query/Stream/  │   │   stream    │
    │                  │   │   Write          │   │ - SSE fan   │
    └──────────┬───────┘   └──────────┬───────┘   └──────┬──────┘
               │                      │                   │
               ▼                      ▼                   ▼
           MongoDB 7            External endpoints      Subscriber
                                (SQL, REST, MQTT,       channels
                                 Frigate, ts-store,      (back to
                                 ...)                    SSE handler)
```

**Handlers** own HTTP concerns — parsing, validation of surface shape,
writing responses. They don't touch MongoDB or external endpoints
directly.

**Services** own business logic — tag normalization, duplicate-name
checks, secret masking/unmasking, cross-entity references (e.g.
"can't delete a chart that a dashboard references"). Most services
accept a context and a request struct, return a response struct.

**Repositories** are the only layer that talks to MongoDB. They own
the collection handle, the index set, and the aggregation pipelines
for any non-trivial queries. Repositories don't know about HTTP or
services.

**Datasource adapters** implement the `Streamer` / `Queryable` /
`Writable` interfaces for each external source type. They don't know
about MongoDB or HTTP — they're pure adapters over external wire
protocols. See [connections.md](connections.md).

**Streaming engine** owns long-lived per-datasource streams and fans
messages out to SSE subscribers. See [streaming.md](streaming.md).

This separation is strict enough that the repository tests can run
against an in-memory MongoDB without spinning up any HTTP machinery,
and the service tests can run against repository mocks without any
MongoDB at all.

## Directory layout

```
server-go/
├── cmd/
│   ├── server/               Main HTTP server binary
│   └── mcp-server/           Standalone MCP-over-stdio server (for
│                             external AI clients like Claude Desktop)
├── config/
│   ├── config.go             Viper loader
│   └── config.yaml           Base config (env-override-able)
├── docs/                     Generated swagger docs
└── internal/
    ├── agent/                Agentic workflow scaffolding
    ├── ai/                   AI Builder (session, tools, system prompt)
    ├── api/                  Shared API helpers
    ├── database/
    │   ├── mongodb.go        Client setup, shared index helpers
    │   ├── migrations.go     Startup migration framework
    │   └── collation.go      Case-insensitive collation constants
    ├── datasource/           Per-type adapters (SQL, REST, CSV, MQTT,
    │                         Prometheus, EdgeLake, TSStore, Frigate,
    │                         WebSocket, TCP)
    ├── handlers/             HTTP + SSE + WebSocket handlers
    ├── hub/                  ChartHub — real-time chart broadcasts
    ├── mcp/                  MCP server tool registry + handlers
    ├── middleware/           Auth middleware (X-User-ID resolver)
    ├── models/               Data model structs + request/response DTOs
    ├── registry/             Connection type registry (TypeID system)
    ├── repository/           MongoDB access per collection
    ├── service/              Business logic per entity
    ├── streaming/            SSE stream manager, MQTT + TSStore
    │                         streams, ring buffer, aggregators
    └── version/              Version info for /version endpoint
```

Empty directories under `internal/` (`services/`, `tasks/`) are
scaffolding from earlier plans that were not adopted — they're not
wired in and can be ignored.

## Startup sequence

`cmd/server/main.go` does this, in order:

1. Load config via Viper (YAML + env overrides)
2. Connect to MongoDB
3. Instantiate all repositories
4. Run database migrations (`database.RunMigrations(ctx, db)`)
5. Create per-collection indexes (`mongodb.CreateIndexes(ctx)`
   and per-repo `CreateIndexes`)
6. Instantiate services
7. Seed built-in data (pseudo-users, built-in device types)
8. Start the stream manager, chart hub, inbound WebSocket handler
9. Initialize the AI agent if the Anthropic key is set
10. Wire handlers and register Gin routes (under `/api/*` plus
    `/mcp/*` and a few top-level routes)
11. Listen on port 3001

Order (4) before (5) is load-bearing — the collation migration
rebuilds collections, which drops their indexes, so indexes must be
created after migrations complete. See [database.md](database.md).

## Services in brief

- **DatasourceService** — create, update, delete, list, test, health
  check. Normalizes tags on write, masks/unmasks secrets on the
  test path.
- **ChartService** — create, update, delete, list. Manages the
  version chain (`status: "draft"` vs `"final"`). Enforces
  case-insensitive name uniqueness at the application layer because
  the DB uniqueness can't be applied (multiple versions share a
  name).
- **DashboardService** — create, update, delete, list with filters.
  Also offers `ListWithDatasources` which joins dashboards ➝ their
  panels ➝ referenced charts ➝ referenced datasources in a single
  aggregation for the list-page sidebar.
- **UserService** — CRUD, auth lookup by GUID, pseudo-user seeding.
- **ConfigService** — system + per-user runtime config.
- **SettingsService** — admin-facing settings.
- **DeviceService** / **DeviceTypeService** — device CRUD, command
  dispatch, discovery via connection.
- **AISessionService** — session creation, message routing, save,
  cancel, auto-expiry.

## Configuration

Base config in `config/config.yaml`. Overridable via environment
variables with the `DASHBOARD_` prefix — for example
`DASHBOARD_MONGODB_URI`, `DASHBOARD_ANTHROPIC_API_KEY`. See
[docs/DEPLOYMENT.md](../DEPLOYMENT.md) for the common env vars
needed in production.

Secrets live in environment variables only. The config.yaml file
in source control contains no credentials.

## MCP server

Two MCP surfaces exist:

1. **Integrated SSE endpoint** at `GET /mcp/sse` inside the main
   server. This is what the internal AI Builder uses to call tools
   during a chart-generation session.

2. **Standalone MCP-over-stdio binary** at `cmd/mcp-server/main.go`.
   This binary is designed for external AI clients like Claude
   Desktop to connect to and call the same tool set. It shares the
   `internal/mcp/` tool registry with the main server so the two
   surfaces stay in sync.

The tool registry lives in `internal/mcp/` and exposes
connection-introspection, query, and command execution tools. Each
registered tool has a schema and a handler; the handler calls into
the usual service layer.

## Related docs

- [Data model](data-model.md) — entity schemas the repositories
  persist
- [Database](database.md) — index strategy, migrations, collations
- [Streaming](streaming.md) — the streaming engine and client-side
  consumers
- [Connections](connections.md) — per-type adapter details
- [API reference](api-reference.md) — full endpoint tables
- [AI chart editor architecture](AI_CHART_EDITOR_ARCHITECTURE.md) —
  AI Builder internals (separate doc)
- [Datasource processing](../datasources/DATASOURCE_PROCESSING.md) —
  deep dive on how raw connection results flow through filters,
  aggregation, and column mapping before reaching the frontend
