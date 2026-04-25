---
sidebar_position: 22
---

# MCP Server (External Agents)

TRVE Dashboards exposes a **Model Context Protocol (MCP) server** so external AI agents can introspect connections, create components, and build dashboards through the same tool surface the application's own UI uses. The most common use is connecting **Claude Desktop** to your dashboard server so you can build dashboards conversationally.

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for exposing application capabilities to AI agents as discoverable tools. The dashboard server publishes a tool catalog (list connections, get connection schema, create component, create dashboard, etc.) and any MCP-aware client can call those tools.

## Endpoint

The MCP server is part of the main dashboard server — there is no second binary to run. Two routes:

- `GET  /mcp/sse` — Server-Sent Events stream for client-initiated notifications.
- `POST /mcp/message` — JSON-RPC messages (`initialize`, `tools/list`, `tools/call`, ...).

When you log in to the dashboard UI, an MCP session preamble is already wired into the running server — including the live type catalog, grid contract, and Prometheus query hints — so any agent that connects gets enough context to start building immediately.

## Connecting Claude Desktop

Claude Desktop speaks stdio, not SSE, so we bridge with [`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy):

```bash
# Install once
uv tool install mcp-proxy
# or: pipx install mcp-proxy
```

Then add this entry to your `claude_desktop_config.json`:

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

Replace `localhost:3001` with the host:port your dashboard server is reachable on. Restart Claude Desktop. The dashboard tool surface (about 34 tools) appears in the tools panel.

## What an Agent Can Do

The tool inventory covers the full author workflow:

| Group | Examples |
|-------|----------|
| **Catalog** | `get_type_catalog`, `list_chart_types`, `list_control_types`, `list_display_types` |
| **Connections** | `list_connections`, `get_connection`, `create_connection`, `test_connection`, `query_connection` |
| **Discovery** | `get_connection_schema` (SQL tables, Prometheus metrics), `list_mqtt_topics`, `list_edgelake_tables` |
| **Components** | `list_components`, `get_component`, `create_component`, `update_component`, `delete_component`, `get_component_template` |
| **Dashboards** | `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` |

A typical "build me a dashboard" agent flow:

1. `get_type_catalog` to learn what's possible.
2. `list_connections` to see what data sources already exist (or `create_connection` for a new one).
3. `get_connection_schema` to learn the data shape.
4. `create_component` for each chart, then `get_component_template` + `update_component` to fill in the React component code.
5. `create_dashboard` with panels referencing the new components.

## Authentication

The dashboard's MCP endpoint reads the same `X-User-ID` header as the REST API. Whatever user GUID the MCP client sends becomes the acting user for any records the agent creates. If you expose the endpoint beyond your own machine, treat it like any other authenticated API and put it behind a reverse proxy with the appropriate auth.

## See Also

- [Dashboard Agent](dashboard-agent.md) — a reference MCP client (`cmd/dashboard-agent`) we ship with the project that builds whole dashboards from a one-line natural-language prompt.
- [`docs/mcp.md`](https://github.com/trv-enterprises/trve-dashboard/blob/main/docs/mcp.md) — the developer-facing reference with the full tool inventory, schema details, and contributor notes.
