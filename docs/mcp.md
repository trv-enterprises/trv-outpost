# MCP server

The dashboard backend exposes a Model Context Protocol (MCP) server over
SSE so external agents — most notably Claude Desktop — can introspect and
build dashboards end-to-end. The endpoint is mounted at:

```
http://<host>:3001/mcp/sse        (SSE event stream)
http://<host>:3001/mcp/message    (JSON-RPC message ingress)
```

The same Go process serves the MCP endpoint and the REST API, so there's
no second binary to run. The earlier stdio-only `cmd/mcp-server` binary
has been removed — use [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)
to bridge stdio clients (like Claude Desktop) to the SSE endpoint.

## Source of truth

Tool schemas read from the unified type registry at
[`server-go/internal/registry`](../server-go/internal/registry/). The MCP
server, the AI builder, and the `/api/registry/*` endpoints all consume
the same registry, so adding a chart type or control type only requires
touching one place — every consumer updates automatically.

## Tool inventory

| Group | Tool | Notes |
| --- | --- | --- |
| Catalog | `get_type_catalog` | Returns connection types, chart/control/display subtypes, and device types in one call. **Start here.** |
| Catalog | `list_connection_types`, `list_chart_types`, `list_control_types`, `list_display_types`, `list_device_types` | Per-category catalog slices |
| Connections | `list_connections`, `get_connection`, `create_connection`, `update_connection`, `delete_connection` | Standard CRUD |
| Connections | `test_connection`, `query_connection` | Health-check and ad-hoc query |
| Discovery | `get_connection_schema` | SQL tables/columns; Prometheus metrics. Errors for connection types without schema discovery. |
| Discovery | `list_mqtt_topics`, `sample_mqtt_topic` | MQTT broker discovery + payload sampling |
| Discovery | `list_edgelake_databases`, `list_edgelake_tables`, `get_edgelake_table_schema` | EdgeLake cascading discovery |
| Discovery | `list_prometheus_label_values` | Prometheus label introspection |
| Components | `list_components`, `get_component`, `list_component_summaries` | Charts/controls/displays — single collection, discriminated by `component_type` |
| Components | `create_component`, `update_component`, `delete_component` | CRUD with chart/control/display sub-configs |
| Components | `list_dashboards_using_component` | Reverse lookup before delete |
| Dashboards | `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` | Dashboards own their panel grid directly — no separate Layout entity |

The agent's typical "build me a dashboard" flow:

1. `get_type_catalog` to learn what's possible
2. `list_connections` to see what's already configured (or
   `create_connection` for a new one)
3. `get_connection_schema` (or `list_mqtt_topics` /
   `list_edgelake_tables` / etc) to understand the data shape
4. `create_component` for each chart/control/display
5. `create_dashboard` with panels referencing the new component IDs

## Claude Desktop setup

Claude Desktop speaks stdio, not SSE, so we bridge with `mcp-proxy`:

```bash
# Install once
uv tool install mcp-proxy
# or: pipx install mcp-proxy
```

Then add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trve-dashboard": {
      "command": "/Users/you/.local/bin/mcp-proxy",
      "args": ["http://localhost:3001/mcp/sse"]
    }
  }
}
```

Replace `localhost:3001` with the host:port your dashboard backend runs
on. If you expose the endpoint beyond your machine, point at the public
URL — but see the **authentication** note below first.

## Authentication

As of v0.9.0, `/mcp/sse` and `/mcp/message` are gated by the same
authentication middleware as `/api/*`. Every MCP request must carry one
of the supported credential channels:

1. **`Authorization: Bearer trve_…`** — the API key path (preferred).
   Issue a key from **Manage Mode → API Keys** in the UI; the
   plaintext token is shown exactly once at creation. Each key
   inherits the full capability set of its owning user.
2. **`X-User-ID: <user-guid>`** — the legacy identity-assertion path.
   Still accepted for migration and local dev under
   `npm run dev`, but should not be used in any deployment that
   exposes port 3001 to the network — it's an unauthenticated user
   ID, not a credential.

When both headers are present, the Bearer token wins.

For Claude Desktop wired through `mcp-proxy`, set the header in the
proxy launcher:

```jsonc
{
  "mcpServers": {
    "trve-dashboard": {
      "command": "/Users/you/.local/bin/mcp-proxy",
      "args": [
        "--headers", "Authorization=Bearer trve_…",
        "http://localhost:3001/mcp/sse"
      ]
    }
  }
}
```

For curl-style probing:

```sh
curl -H "Authorization: Bearer trve_…" http://localhost:3001/mcp/message \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

A request with no recognised credential gets a 401 from the
middleware before reaching the MCP handler.
