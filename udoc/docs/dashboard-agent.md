---
sidebar_position: 23
---

# Dashboard-Builder Agent

The **dashboard-builder agent** is a command-line tool that drives the dashboard's [MCP server](mcp.md) end-to-end to build a complete dashboard from a one-line natural-language prompt. It ships in the repo at `server-go/cmd/dashboard-agent/` and consumes the same MCP surface that Claude Desktop or any other external MCP client would.

The agent is a **reference implementation** — useful for quickly bootstrapping new dashboards, demoing the MCP architecture, and validating that the tool surface stays usable end-to-end. It's not the only way to use the MCP server; it's the example that proves the pattern.

## What It Does

You give it a connection ID (or let it pick one) and a natural-language prompt. It:

1. Connects to the MCP server and reads the live tool catalog.
2. Inspects the connection to learn what data is available.
3. Plans the dashboard layout against the canvas you specified.
4. Creates each chart component, fetches the appropriate React template, fills in the actual column names, and uploads the rendered code.
5. Creates the dashboard with the panels arranged on the grid.
6. Hands back the dashboard ID.

The whole run typically takes 8–12 turns of LLM dialogue (a few minutes wall-clock at default rate limits) and produces a fully-working dashboard you can immediately open in the viewer.

## Quickstart

Prerequisites:

- Dashboard server running locally
- An Anthropic API key in `ANTHROPIC_API_KEY` or `DASHBOARD_ANTHROPIC_API_KEY`
- A user GUID with the `design` capability

```bash
go run ./cmd/dashboard-agent \
  --user <your-user-guid> \
  --connection-id <your-connection-id>   `# optional` \
  --dimensions 2560x1440                  `# optional` \
  --prompt "Build a node-exporter monitoring dashboard ..."
```

The agent prints the dashboard ID on stdout and a turn-by-turn transcript on stderr. Each run also writes a markdown file to `docs/agent-runs/` with the prompt, the runtime context, and the full transcript inside a code-fenced block. Disable file logging with `--no-log`.

## Inputs

| Flag | Required? | Notes |
|------|-----------|-------|
| `--user` | yes | Acting user GUID. Records are created as this user. |
| `--prompt` | yes | The natural-language brief — what kind of dashboard to build. |
| `--connection-id` | optional | Pin the agent to a specific connection. If omitted, the agent calls `list_connections` and picks one (or asks the user via clarification). |
| `--dimensions` | optional | Canvas size as `WxH`, e.g. `2560x1440`. Drives the cell-grid math the agent uses to size and place panels. |
| `--dashboard-name` | optional | If empty, the agent picks a name from the prompt. |
| `--server` | default `http://localhost:3001` | The dashboard server. |
| `--model` | default `claude-sonnet-4-6` | Claude model ID. |
| `--max-turns` | default `50` | Cap on the agentic loop. |
| `--log-dir` | default `docs/agent-runs/` | Where transcript files land. |
| `--no-log` | optional | Disable transcript file logging. |

## Worked Example

A real run that produced a 14-panel Prometheus monitoring dashboard from this 65-word prompt:

> "Build a node-exporter monitoring dashboard on the Prometheus connection from the runtime context. Show at least 12 charts filling the canvas; more are fine if the layout stays readable and there's additional node-exporter data worth surfacing. Give each chart a concise title."

The agent picked chart types (gauges + areas + lines), wrote the PromQL itself (including non-trivial aggregations like `sum by (mode) (rate(node_cpu_seconds_total[5m]))`), filled the React templates with the right column names, and arranged 14 panels in a 4-row layout that filled the 2560 × 1440 canvas exactly with no overlaps.

See [`examples/dashboard-agent/`](https://github.com/trv-enterprises/trve-dashboard/tree/main/examples/dashboard-agent) for the full panel manifest, screenshot, and tool-call breakdown.

## When to Use the Agent vs. Other Tools

| Use case | Best tool |
|----------|-----------|
| Build a single chart inside an existing dashboard | The in-app [AI Component Builder](ai-builder.md) |
| Bootstrap a whole new dashboard from a prompt | The dashboard-builder agent |
| Authoring conversation in a chat UI you control | Claude Desktop via [MCP](mcp.md) |
| Programmatic dashboard creation in CI / scripts | The dashboard-builder agent or direct MCP calls |

The in-app AI Builder is component-scoped and tightly integrated with the editor (live preview, single-component focus). The dashboard-builder agent is dashboard-scoped, runs from a CLI, and can produce many components plus the dashboard in one shot.

## Limitations

- **Connection creation** is part of the MCP tool surface and the agent will use it if a prompt asks for a data source the deployment doesn't have, but this path is not yet thoroughly tested. Treat new-connection creation as an exploratory feature.
- **Touch / mobile** — the agent is a CLI, no UI yet. A chat interface that wraps it is on the roadmap.
- **Rate limits** — Anthropic Tier 1 (30,000 input tokens/min) constrains what a single run can do. We've added prompt caching and tool-result trimming to help; expect 1–2 short rate-limit pauses on a 12-panel run, more on larger dashboards. Higher tiers reduce or eliminate this.
