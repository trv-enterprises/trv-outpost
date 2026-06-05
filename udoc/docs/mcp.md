---
sidebar_position: 22
---

# MCP Server (External Agents)

TRV Outpost exposes a **Model Context Protocol (MCP) server** so external AI agents can introspect connections, create components, and build dashboards through the same tool surface the application's own UI uses. The two supported clients are **Claude Code** (the CLI, direct HTTP) and **Claude Desktop** (via a local stdio bridge).

## What is MCP?

The [Model Context Protocol](https://modelcontextprotocol.io/) is an open standard for exposing application capabilities to AI agents as discoverable tools. The dashboard server publishes a tool catalog (list connections, get connection schema, create component, create dashboard, etc.) and any MCP-aware client can call those tools.

## Endpoint

The MCP server is part of the main dashboard server — there is no second binary to run.

- **`POST /mcp`** — the canonical Streamable HTTP endpoint. JSON-RPC 2.0 bodies in, JSON-RPC responses out. New clients should use this URL.
- `POST /mcp/message` — legacy JSON-RPC path from the SSE-era two-endpoint shape. Still functional; logs a deprecation warning on each call. Older MCP clients may speak this path.
- `GET /mcp/sse` — legacy SSE event stream. The 2025-03-26 MCP spec replaced HTTP+SSE with Streamable HTTP and SSE-only clients started being refused around April 2026. Kept as a soft-landing surface; do not depend on it.

When you log in to the dashboard UI, the MCP session preamble is wired up automatically — the live type catalog, grid contract, and discovery flow are returned by `initialize`. Any agent that connects gets enough context to start building immediately, and can fetch per-connection-type query envelope shapes on demand via `get_connection_type_guidance`.

## Connecting Claude Code (recommended)

Claude Code speaks streamable HTTP natively from `.mcp.json` — no bridge needed. Drop the following at the project root (or at `~/.claude.json` to make it global):

```json
{
  "mcpServers": {
    "dashboard": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer ${TRVE_DASHBOARD_KEY}" }
    }
  }
}
```

Replace `127.0.0.1:3001` with the host:port your dashboard server is reachable on. `${TRVE_DASHBOARD_KEY}` expands from your shell env at connection time, so the file itself stays credential-free and safe to commit.

Then run `claude` from a directory containing the file. Inside the session:

- `/mcp` — lists connected MCP servers and shows whether tools enumerate.
- `/status` — confirms which auth mode the CLI is in (subscription vs. API key).

If you point Claude Code at a self-signed HTTPS dashboard server in dev, add `{"env": {"NODE_TLS_REJECT_UNAUTHORIZED": "0"}}` to `~/.claude/settings.json`. (`.mcp.json` doesn't accept a per-server env block for HTTP entries, so the override is process-wide — dev only.)

## Connecting Claude Desktop (via mcp-remote bridge)

Claude Desktop does **not** read remote `url` entries from `claude_desktop_config.json` — adding one is silently ignored, and a known bug can clobber the rest of the file. To reach a remote MCP server from Desktop you must run a local stdio bridge that translates Desktop's stdio expectations into HTTP calls to the dashboard.

The recommended bridge is [`mcp-remote`](https://github.com/geelen/mcp-remote) — install-on-demand via `npx`, auto-negotiates streamable HTTP vs legacy SSE, no separate install step required.

**Prerequisites:** Node.js LTS installed (so `npx` is on PATH).

**Config file location:**
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

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
        "--header", "Authorization:Bearer ${TRVE_DASHBOARD_KEY}"
      ]
    }
  }
}
```

The `--allow-http` flag is required because `mcp-remote` defaults to refusing plaintext HTTP. Without it, the connection fails silently with no useful error in Desktop's logs.

**Self-signed HTTPS on localhost (alternative):**

```json
{
  "mcpServers": {
    "dashboard": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://127.0.0.1:3001/mcp",
        "--header", "Authorization:Bearer ${TRVE_DASHBOARD_KEY}"
      ],
      "env": { "NODE_TLS_REJECT_UNAUTHORIZED": "0" }
    }
  }
}
```

`${TRVE_DASHBOARD_KEY}` expands from the host shell env, keeping the credential out of the file itself.

**After editing the config**, fully **quit and restart** Claude Desktop — closing the window is not enough; you need a real process restart for it to re-read the config.

**Verification:** open a Claude Desktop chat and ask something that requires a dashboard tool ("list my dashboard connections" works). The tool call appears in Desktop's tool inspector. If tools don't appear: check that Node is installed, the dashboard server is running on the expected port, the bearer token is valid, and the correct localhost flag is set (`--allow-http` for HTTP, `NODE_TLS_REJECT_UNAUTHORIZED=0` for self-signed HTTPS).

### Alternative bridges

If you prefer not to depend on `npx` resolving `mcp-remote` on each start, two alternatives:

- [`sparfenyuk/mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy) — Python stdio↔HTTP bridge. Pass `--transport=streamablehttp` to force the modern transport. Bills as the more configurable option.
- [`@pyroprompts/mcp-stdio-to-streamable-http-adapter`](https://www.npmjs.com/package/@pyroprompts/mcp-stdio-to-streamable-http-adapter) — Node stdio relay; takes `URI`, optional `MCP_NAME`, optional `BEARER_TOKEN` via env.

For most users `mcp-remote` is the right default; the alternatives are for cases where you want an owned bridge under version control rather than an npx dependency.

## What an Agent Can Do

The tool inventory covers the full author workflow:

| Group | Examples |
|-------|----------|
| **Catalog** | `get_type_catalog`, `list_chart_types`, `list_control_types`, `list_display_types` |
| **Connections** | `list_connections`, `get_connection`, `create_connection`, `test_connection`, `query_connection` (now accepts `limit`) |
| **Discovery** | `get_connection_schema`, `list_mqtt_topics`, `sample_mqtt_topic`, `list_edgelake_databases` → `list_edgelake_tables` → `get_edgelake_table_schema`, `list_prometheus_label_values` |
| **Guidance** | `get_connection_type_guidance` (per-adapter `query_config` envelope cheat sheets), `list_dashboard_dimensions` (canvas presets) |
| **Components** | `list_components`, `get_component`, `create_component`, `update_component`, `delete_component`, `get_component_template` |
| **Dashboards** | `list_dashboards`, `get_dashboard`, `create_dashboard`, `update_dashboard`, `delete_dashboard` |

A typical "build me a dashboard" agent flow:

1. `list_connections` to see what data sources exist (or `create_connection` for a new one).
2. `get_connection_type_guidance(type)` once per connection-type to learn how to build `query_config` for that adapter.
3. The discovery tool for the connection type (`get_connection_schema`, `list_mqtt_topics`, etc.) to learn columns/topics/metrics.
4. Optionally `query_connection` with `limit: 1` to verify return-column shape before committing.
5. `get_component_template(chart_type)` for the ECharts skeleton, then `create_component` with the resolved `query_config` and `data_mapping`.
6. `create_dashboard` with panels referencing the new components.

## Prompts (slash commands)

The server advertises one MCP **prompt** — `dashboard-builder` — which Claude Code and Claude Desktop both surface as a slash command. Picking it injects an opinionated builder persona (role + conventions + build flow), so a Claude Code or Desktop user can opt into the autonomous-builder behavior without the framing polluting other MCP sessions.

Use the slash command when you want the model to act as a *dashboard builder* (multi-step, namespace-disciplined, one-component-per-chart). Skip it for ad-hoc questions and free-form exploration.

## Authentication

MCP endpoints require authentication, same as `/api/*`. Two credential channels:

1. **API key (preferred)** — `Authorization: Bearer trve_…`. Create a key from **Manage Mode → API Keys**; the plaintext token is shown exactly once at creation, then only the bcrypt hash and a short prefix are stored. Each key inherits the full capability set of its owning user.
2. **Legacy `X-User-ID` header** — used only at the `/api/auth/session` bootstrap to trade an identity assertion for an access JWT. The middleware on `/mcp/*` does NOT accept `X-User-ID` directly; you must bootstrap to a JWT first, or use an API key for direct access.

API keys are what you want for both Claude Code and Claude Desktop. Generate one, drop it into `$TRVE_DASHBOARD_KEY` in your shell, and reference it via `${TRVE_DASHBOARD_KEY}` in the config files above.

## See Also

- [`docs/mcp.md`](https://github.com/trv-enterprises/trv-outpost/blob/main/docs/mcp.md) — the developer-facing reference with the full tool inventory, schema details, and contributor notes.
- [Connection Types](connection-types.md) — what each adapter expects in `query_config`.
