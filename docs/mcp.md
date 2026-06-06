# MCP server

The dashboard backend exposes a Model Context Protocol (MCP) server so
external agents — Claude Code, Claude Desktop, mcp-proxy clients — can
introspect and build dashboards end-to-end. The endpoints are mounted
on the same process that serves the REST API; there is no second binary
to run.

## Endpoints

```
POST /mcp           Streamable HTTP — canonical, spec-compliant. Use this URL.
POST /mcp/message   Legacy JSON-RPC URL from the SSE-era two-endpoint shape.
                    Still functional; logs a deprecation warning per call.
                    Older clients may still speak this.
GET  /mcp/sse       Legacy SSE event stream. Deprecated by the 2025-03-26
                    MCP spec; SSE-only clients have been refused since
                    ~April 2026. Kept as a soft-landing surface.
```

All three paths share one JSON-RPC dispatcher — same behavior, different
URLs. Notifications (JSON-RPC requests with no `id`, e.g.
`notifications/initialized`) are answered with `202 Accepted` and no
response body per the streamable-HTTP spec.

The protocol version advertised by `initialize` is **`2025-03-26`** —
the revision that introduced Streamable HTTP. The earlier `2024-11-05`
SSE-shaped clients still negotiate successfully via the legacy paths.

## Source of truth

Tool schemas read from the unified type registry at
[`server-go/internal/registry`](../server-go/internal/registry/). The MCP
server, the AI builder, and the `/api/registry/*` endpoints all consume
the same registry, so adding a chart type or control type only requires
touching one place — every consumer updates automatically.

Per-adapter `query_config` envelope guidance lives in
[`server-go/internal/connectionguidance`](../server-go/internal/connectionguidance/),
which both the MCP `get_connection_type_guidance` tool and the in-built
AI component agent's tool of the same name consume.

## Tool inventory

| Group | Tool | Notes |
| --- | --- | --- |
| Catalog | `get_type_catalog` | Returns connection types, chart/control/display subtypes, and device types in one call. **Start here.** |
| Catalog | `list_connection_types`, `list_chart_types`, `list_control_types`, `list_display_types`, `list_device_types` | Per-category catalog slices |
| Connections | `list_connections`, `get_connection`, `create_connection`, `update_connection`, `delete_connection` | Standard CRUD |
| Connections | `test_connection`, `query_connection` | Health-check and ad-hoc query. `query_connection` accepts `limit` to trim rows post-adapter — cheap probe pattern for verifying result shape |
| Guidance | `get_connection_type_guidance` | Per-adapter `query_config` envelope cheat sheet (Prometheus `query_type`/`start`/`step`, EdgeLake `database` param, MQTT `data_path`, …). Call once per connection-type-per-session. |
| Guidance | `list_dashboard_dimensions` | Canvas-size presets configured for this deployment, plus the configured default. Call when the user hasn't picked a canvas size. |
| Discovery | `get_connection_schema` | SQL tables/columns; Prometheus metrics. Errors for connection types without schema discovery. |
| Discovery | `list_mqtt_topics`, `sample_mqtt_topic` | MQTT broker discovery + payload sampling |
| Discovery | `list_edgelake_databases`, `list_edgelake_tables`, `get_edgelake_table_schema` | EdgeLake cascading discovery |
| Discovery | `list_prometheus_label_values` | Prometheus label introspection |
| Components | `list_components`, `get_component`, `list_component_summaries` | Charts/controls/displays — single collection, discriminated by `component_type` |
| Components | `create_component`, `update_component`, `delete_component` | CRUD with chart/control/display sub-configs |
| Components | `get_component_template` | ECharts skeleton + style placeholders per chart_type |
| Components | `list_dashboards_using_component` | Reverse lookup before delete |
| Dashboards | `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` | Dashboards own their panel grid directly — no separate Layout entity |

The agent's typical "build me a dashboard" flow:

1. `list_connections` to see what's already configured (or
   `create_connection` for a new one).
2. `get_connection_type_guidance(type)` once per connection-type to
   learn the `query_config` envelope shape for that adapter.
3. The discovery tool for the type (`get_connection_schema`,
   `list_mqtt_topics`, etc.) to learn columns/topics/metrics.
4. Optionally `query_connection` with `limit: 1` to verify return-column
   shape before committing.
5. `get_component_template(chart_type)` for the ECharts skeleton, then
   `create_component` with the resolved `query_config` and
   `data_mapping`.
6. `create_dashboard` with panels referencing the new components.

## Prompts

The server advertises one MCP **prompt** — `dashboard-builder` — a
role-and-conventions persona for building dashboards end-to-end (text
in `internal/mcp/dashboard_builder_prompt.go`). Clients that support
`prompts/get` (Claude Code, Claude Desktop) surface this as a slash
command and inject the persona into the conversation when picked.

## Claude Code setup

Claude Code speaks streamable HTTP natively from `.mcp.json` — no bridge
needed:

```json
{
  "mcpServers": {
    "dashboard": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer ${OUTPOST_DASHBOARD_KEY}" }
    }
  }
}
```

Use `${VAR}` expansion to keep credentials out of the file. Inside a
session, `/mcp` lists connected servers and `/status` shows auth mode.

Note `"type": "http"` specifically — not `"sse"`, and prefer literal
`"http"` over `"streamable-http"` (the alias is accepted but has been
reported to occasionally fall back to SSE).

For self-signed HTTPS dashboards in dev, set
`NODE_TLS_REJECT_UNAUTHORIZED=0` in `~/.claude/settings.json`'s `env`
block — Claude Code's HTTP entries don't accept per-server env.

## Claude Desktop setup

Claude Desktop does NOT read remote `url` entries from
`claude_desktop_config.json` — adding one is silently ignored, and a
known bug can clobber the rest of the file. Reach the remote server via
a local stdio bridge instead. The recommended bridge is
[`mcp-remote`](https://github.com/geelen/mcp-remote):

**Plain HTTP on localhost (typical dev):**

```json
{
  "mcpServers": {
    "dashboard": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "http://127.0.0.1:3001/mcp",
        "--allow-http",
        "--header", "Authorization:Bearer ${OUTPOST_DASHBOARD_KEY}"
      ]
    }
  }
}
```

`--allow-http` is required for plain HTTP — without it the bridge
refuses the URL silently.

**Self-signed HTTPS on localhost:**

```json
{
  "mcpServers": {
    "dashboard": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://127.0.0.1:3001/mcp",
        "--header", "Authorization:Bearer ${OUTPOST_DASHBOARD_KEY}"
      ],
      "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
    }
  }
}
```

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

After editing, fully **quit and restart** Claude Desktop (not just close
the window).

Alternatives if you'd rather own the bridge rather than depend on
on-demand `npx`:
- [`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy)
  (Python). Pass `--transport=streamablehttp` to force the modern
  transport.
- [`@pyroprompts/mcp-stdio-to-streamable-http-adapter`](https://www.npmjs.com/package/@pyroprompts/mcp-stdio-to-streamable-http-adapter)
  (Node). Takes `URI`, optional `MCP_NAME`, optional `BEARER_TOKEN`.

## Authentication

MCP endpoints are gated by the same auth middleware as `/api/*`.

1. **`Authorization: Bearer trve_…`** — the API key path (preferred).
   Issue a key from **Manage Mode → API Keys** in the UI; the plaintext
   token is shown exactly once at creation. Each key inherits the full
   capability set of its owning user.
2. **JWT access token** — minted at `/api/auth/session` by trading any
   of the inbound credentials (Clerk JWT, API key, `X-User-ID`,
   `?user_id=`). The middleware on `/mcp/*` accepts the JWT directly;
   it does NOT accept raw `X-User-ID` headers, so bootstrap once before
   you start MCP traffic if you're not using an API key.

A curl probe:

```sh
curl -H "Authorization: Bearer trve_…" \
  -H "Content-Type: application/json" \
  http://localhost:3001/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A request with no recognised credential gets a 401 from the middleware
before reaching the MCP handler.
