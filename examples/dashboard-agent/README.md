# Example: dashboard-agent builds a Prometheus monitoring dashboard

A reference run of [`cmd/dashboard-agent`](../../server-go/cmd/dashboard-agent)
driving the MCP server to produce a complete, working monitoring
dashboard end-to-end. This is the artifact that validates the
agent-as-MCP-client pattern — same tool surface any external agent
(Claude Desktop via `mcp-proxy`, any future MCP client) would use.

![Rendered Prometheus dashboard built by the agent](./prometheus-dashboard.png)


## What went in

**Command (v0.9.0+, API-key auth — preferred):**

```bash
export DASHBOARD_API_KEY=trve_…   # issued from Manage Mode → API Keys
caffeinate -s go run ./cmd/dashboard-agent \
  --connection-id 697a702e130b47674f259b99 \
  --dimensions 2560x1440 \
  --dashboard-name "Node Exporter Monitoring (agent)" \
  --prompt "Build a node-exporter monitoring dashboard on the Prometheus connection from the runtime context. Show at least 12 charts filling the canvas; more are fine if the layout stays readable and there's additional node-exporter data worth surfacing. Give each chart a concise title."
```

The CLI also accepts `--api-key trve_…` as a flag if you'd rather not
use the env var. The legacy `--user <guid>` flag still works and uses
the unauthenticated `X-User-ID` identity-assertion path — keep it for
local dev, but for any real deployment issue an API key.

**Inputs summary:**

| Flag                | Required?     | Value                                                                                                |
| ------------------- | ------------- | ---------------------------------------------------------------------------------------------------- |
| `--api-key` *or* `--user` | yes     | API key (preferred; resolves the user from the Bearer token) **or** legacy GUID identity assertion   |
| `--connection-id`   | this run only | `697a702e130b47674f259b99` — `TRV-SRV-001 K3S Prometheus` (an existing connection in the user's deployment) |
| `--dimensions`      | optional      | `2560x1440` → 71 cols × 37 rows at 32 × 32 px cells                                                  |
| `--dashboard-name`  | optional      | `Node Exporter Monitoring (agent)`                                                                   |
| prompt              | yes           | ~65-word natural-language brief; **no** grid math, PromQL, or type hints — everything is left to the model to infer from the MCP initialize preamble |

A note on `--connection-id`: this run pre-pinned an existing
Prometheus connection so the agent didn't have to choose one. **It's
not a hard requirement** — if you omit it, the agent calls
`list_connections` and either picks a sensible match for the prompt
or asks the user via `request_clarification`. The agent also has the
MCP tools to *create* a new connection if the prompt calls for one
the deployment doesn't have yet (see "Connection creation" below).

**Nothing else was provided.** No chart-type list, no canvas dimensions
math, no PromQL examples, no panel geometry. The agent computed all of
that from the MCP preamble's catalog + Grid contract section +
connection-discovery tools.

### Connection creation (capability, not exercised here)

The `create_connection` MCP tool is part of the standard surface and
the agent will use it when a prompt references a data source the
deployment doesn't have. This run did not exercise that path — we
already had the Prometheus connection in place, so the agent just
referenced it. The connection-creation flow is **not yet thoroughly
tested end-to-end** through the agent; treat it as a capability worth
exploring, not a guaranteed-stable feature.

## What came out

**Dashboard**: `f207aac2-d7e8-472a-98ae-f83d8c09459b` — 14 panels
arranged in 4 rows, zero panel overlap, filling the 71 × 37 canvas
exactly (cols 0–70, rows 0–36).

**Components**: 14 new chart records in the `default` namespace, all
bound to the Prometheus connection. Layout and chart-type choices:

| Row  | Panels                                                                          | Chart types                |
| ---- | ------------------------------------------------------------------------------- | -------------------------- |
| 0–7  | CPU Usage · Memory Usage · Load Avg · Disk Used                                 | 4 × gauge (instant query)  |
| 8–16 | CPU Usage by Mode (stacked) · Memory Used (excl. cache)                         | 2 × area (range)           |
| 17–25| Disk Read Throughput · Disk Write Throughput                                    | 2 × area (range)           |
| 26–31| Network Receive Rate · Network Transmit Rate · System Load (1m)                 | 3 × line (range)           |
| 32–36| Hardware Temperature · Open File Descriptors · Context Switches / sec           | 2 × line + 1 × area (range)|

**Full panel and query manifest:**

```
p1   gauge   x= 0 y= 0 w=17 h= 8  CPU Usage     100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)
p2   gauge   x=18 y= 0 w=17 h= 8  Memory Usage  100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
p3   gauge   x=36 y= 0 w=17 h= 8  Load Avg (1m) node_load1
p4   gauge   x=54 y= 0 w=17 h= 8  Disk Used     100 * (1 - sum(node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs"})
                                                         / sum(node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs"}))
p5   area    x= 0 y= 8 w=35 h= 9  CPU by Mode   sum by (mode) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) * 100
p6   area    x=36 y= 8 w=35 h= 9  Mem (excl.)   node_memory_MemTotal_bytes - node_memory_MemFree_bytes
                                                  - node_memory_Cached_bytes - node_memory_Buffers_bytes
p7   area    x= 0 y=17 w=35 h= 9  Disk Read     rate(node_disk_read_bytes_total[5m])
p8   area    x=36 y=17 w=35 h= 9  Disk Write    rate(node_disk_written_bytes_total[5m])
p9   line    x= 0 y=26 w=23 h= 6  Net RX        sum(rate(node_network_receive_bytes_total{device!="lo"}[5m]))
p10  line    x=24 y=26 w=23 h= 6  Net TX        sum(rate(node_network_transmit_bytes_total{device!="lo"}[5m]))
p11  line    x=48 y=26 w=23 h= 6  Load 1m       node_load1
p12  line    x= 0 y=32 w=23 h= 5  HW Temp       node_hwmon_temp_celsius
p13  line    x=24 y=32 w=23 h= 5  Open FDs      node_filefd_allocated
p14  area    x=48 y=32 w=23 h= 5  Ctx Switches  rate(node_context_switches_total[5m])
```

## How the agent got there

The run executed **12 turns** against Claude Sonnet 4.6, burning **38
tool calls**:

| Tool                     | Calls | What it did                                              |
| ------------------------ | ----- | -------------------------------------------------------- |
| `get_connection`         | 1     | Confirm the Prometheus connection type + URL             |
| `get_connection_schema`  | 2     | Discover available metrics (filtered by `node_` prefix)  |
| `get_component_template` | 4     | Fetch React skeletons for gauge, area, line, and a ref   |
| `create_component`       | 14    | Create each chart record with query config + metadata    |
| `update_component`       | 15    | Fill in `component_code` on each chart (one retry)       |
| `create_dashboard`       | 1     | Assemble the 14 panels into the final grid layout        |
| `yield_final_answer`     | 1     | Return the dashboard ID                                  |

The flow matches the canonical pattern documented in the MCP initialize
preamble:

1. Identify the connection type and discover what data is available.
2. Plan panel placement against the grid contract (71 × 37 cells for
   this canvas).
3. Create each component, then pull the appropriate chart-type
   template, fill in the column names (`timestamp`, `value`, label
   columns from `sum by (...)`), and call `update_component` with the
   rendered React source.
4. Create the dashboard referencing the 14 component IDs.

One `429 rate_limit_error` hit at turn 11 and resolved on retry after
73 seconds of backoff.

## Why this run mattered

Earlier iterations of this agent shipped with three known problems
this run validated are fixed:

1. **Grid-contract mismatch** — prior runs assumed a "12-column grid"
   (Carbon responsive-breakpoint convention) and produced panels ~1/4
   the intended size. The corrected `cols = canvas / 36`,
   `rows = (canvas - 105) / 36` formula now lives in the MCP preamble
   and the agent sized panels correctly on the first pass.
2. **Ghost panels** — prior runs created chart records with empty
   `component_code` because `create_component` doesn't auto-fill React
   source. The `get_component_template` tool + the per-chart
   three-step flow (create → fetch template → update with filled code)
   closes that gap.
3. **Broken time-range queries** — prior runs used `params.start:
   "-1h"`, which the Prometheus adapter rejected with
   `"unrecognized time format"`. The adapter now accepts bare
   durations (`-1h`, `-30m`, `1h`) as synonyms for `now-1h`, etc., and
   the preamble documents the accepted syntax.

## Reproducing

Prerequisites:

- A running dashboard server (`go build -o bin/server ./cmd/server && ./bin/server`)
- An Anthropic API key in `ANTHROPIC_API_KEY` or `DASHBOARD_ANTHROPIC_API_KEY`
- A dashboard API key (issued from **Manage Mode → API Keys**) exported as `DASHBOARD_API_KEY`, owned by a user with `design` capability. (`--user <guid>` still works for the legacy identity-assertion path.)

If you want to reproduce this exact node-exporter dashboard, you'll
also need a Prometheus connection that's scraping
`node_exporter` — pass its connection ID via `--connection-id`. To
exercise the agent against a different data source, swap the prompt
and either pass a matching connection or omit `--connection-id` and
let the agent pick (or create) one.

Run the CLI:

```bash
export DASHBOARD_API_KEY=trve_…             # one-time setup — preferred
go run ./cmd/dashboard-agent \
  --connection-id <your-connection-id>      `# optional` \
  --dimensions 2560x1440                    `# optional` \
  --prompt "Build a node-exporter monitoring dashboard ..."
```

Or, with the legacy GUID path:

```bash
go run ./cmd/dashboard-agent \
  --user <your-user-guid> \
  --connection-id <your-connection-id> \
  --prompt "Build a node-exporter monitoring dashboard ..."
```

Each run writes a markdown transcript to `docs/agent-runs/` with the
full prompt, all tool calls, and the final answer. Disable with
`--no-log`.

## Related

- [`server-go/cmd/dashboard-agent/main.go`](../../server-go/cmd/dashboard-agent/main.go) — CLI entry point
- [`server-go/internal/agent/dashboard/`](../../server-go/internal/agent/dashboard/) — agent core + MCP client
- [`docs/mcp.md`](../../docs/mcp.md) — MCP server tool inventory
- [`docs/architecture/grid-system.md`](../../docs/architecture/grid-system.md) — cell-grid math and fit modes
