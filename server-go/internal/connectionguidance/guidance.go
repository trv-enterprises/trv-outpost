// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package connectionguidance owns the per-adapter-type "how to build
// query_config for this connection type" cheat sheets that the LLM
// can't infer from training data — they're TRVE-dashboard-specific
// envelope wrapping (Prometheus's query_type/start/step, EdgeLake's
// database param, MQTT's data_path, etc.).
//
// Two consumers today:
//
//  1. The MCP server's `get_connection_type_guidance` tool, served
//     to external agents like Claude Desktop or the dashboard-agent
//     CLI.
//  2. The in-server component-builder agent's `get_connection_type_guidance`
//     tool, served to the AI Builder surface in the dashboard UI.
//
// Both read from the same map below. Keep the strings tight —
// they're served on demand, not front-loaded into every session, so
// verbose prose costs the LLM tokens when it actually fetches.
//
// Adding a new connection type: add an entry keyed by the registry
// TypeID (the same string `list_connection_types` emits). New types
// without an entry fall through to a generic stub via Get().
package connectionguidance

import "strings"

// Get returns the guidance string for the given connection TypeID,
// or a fallback string + ok=false when no guidance is recorded for
// the type. The fallback is intentionally instructive — it points
// the agent at the next-best discovery method rather than just
// returning an error.
func Get(typeID string) (string, bool) {
	g, ok := guidance[typeID]
	if !ok {
		return strings.TrimSpace(genericFallback), false
	}
	return strings.TrimSpace(g), true
}

// List returns every typeID that has dedicated guidance. Useful for
// the agent layer to advertise the option set; not for the agent
// itself to consume.
func List() []string {
	out := make([]string, 0, len(guidance))
	for k := range guidance {
		out = append(out, k)
	}
	return out
}

const genericFallback = `
No specific guidance is recorded for this connection type yet.
Inspect the query_config field on an existing component that uses this type
(list_components then get_component), or look at the adapter's config
schema via get_type_catalog. To introspect actual data shape, run a small
probe with query_connection (passing limit: 1).
`

var guidance = map[string]string{

	"api.prometheus": `
query_config shape for Prometheus:

    {
      "raw":    "<PromQL expression>",
      "type":   "prometheus",
      "params": {
        "query_type": "instant" | "range",   // default "range"
        "start":      "now-1h",              // range only; accepts "now", "now-30m", "1h" offsets, unix seconds, or RFC3339
        "end":        "now",                 // range only; same accepted forms as start
        "step":       "60s"                  // range only; Go duration string, default "1m"
      }
    }

Pick "instant" for single-current-value queries (gauges, number/stat panels, pie charts) and "range" for time-series (line/area/bar over time).

Return columns:
- range queries: timestamp (unix seconds), value (number), plus one column per PromQL label when the query produces multiple series.
- instant queries: same shape, single row.

To verify the actual return columns before committing, call query_connection with limit=1.
`,

	"sql.postgres": `
query_config shape for SQL (Postgres/MySQL/SQLite all share the same envelope):

    {
      "raw":    "SELECT … FROM … WHERE col = $1 LIMIT 100",
      "type":   "sql",
      "params": { "1": "value-for-$1", "2": 42 }   // positional binding; keys are 1-indexed
    }

Return columns: exactly what your SELECT projects; column types come from the database driver. Use get_connection_schema first to discover tables and columns; never invent column names.
`,
	"sql.mysql": `
See sql.postgres — same query_config envelope. MySQL uses ? placeholders rather than $1/$2 syntactically, but the params map keys are still 1-indexed and the adapter handles the substitution.
`,
	"sql.sqlite": `
See sql.postgres — same query_config envelope and parameter-binding convention.
`,

	"api.edgelake": `
query_config shape for EdgeLake:

    {
      "raw":    "SELECT … FROM … LIMIT 100",       // bare SQL — the adapter wraps it in AnyLog's 'sql <db> format=json "…"' for you
      "type":   "sql",
      "params": {
        "database":   "my_db",                     // required — EdgeLake routes by database
        "distributed": true                        // optional; defaults to the connection's use_distributed_query setting. Pass true to fan out across the cluster (sets the AnyLog "destination: network" header)
      }
    }

Return columns: whatever your SELECT projects. To browse what's available before querying, use list_edgelake_databases → list_edgelake_tables → get_edgelake_table_schema.

Note: distributed=true is for read-time fan-out only. For raw AnyLog commands (run blockchain sync, get status, etc.) use the EdgeLake Terminal extension's /api/edgelake-terminal/execute endpoint — that's a separate surface from query_connection.

# SQL dialect restrictions

EdgeLake's operator-side parser accepts a NARROWER Postgres subset than
the SQL driver type suggests. The connector accepts the query but the
remote AnyLog node parses it, so common Postgres-isms fail late with
"Failed to parse SQL statement" or "Non supported SQL". Probed against
EdgeLake 0.x as of 2026-05-25:

What works:
- Standard projection + aggregation: SELECT col, AVG(col), COUNT(*) … GROUP BY col ORDER BY col
- WHERE col = literal — with int, float, 'string', or 'YYYY-MM-DD HH:MM:SS' literals
- date(timestamp) — day-truncation, returns 'YYYY-MM-DD' text
- trunc(numeric), round(numeric) — integer-coercing scalars
- numeric % integer — but ONLY in the SELECT projection (returns the modulo as a column)
- Plain LIMIT N and ORDER BY

What FAILS (don't write these):
- EXTRACT(MONTH FROM ts) / EXTRACT(YEAR FROM ts) — "Error in SQL Select statement"
- DATE_TRUNC('day', ts) and friends
- CAST(expr AS int), expr::int — "Non supported SQL"
- FLOOR(numeric / N) * N — the standard bucketing idiom is not supported
- mod(col, N) — parse error
- col % N = 0 in a WHERE clause — parse error (modulo works ONLY in projection)
- IN (a, b, c) — parse error; use OR chain instead
- Referencing a projection alias from a WHERE clause — aliases are projection-only
- Scalar subqueries with INTERVAL math (e.g. WHERE ts >= (SELECT MAX(ts)…) - INTERVAL '1 day')

Working substitutions:
- DATE_TRUNC('day', ts) → date(ts)
- FLOOR(x / 2) * 2 (2-unit bins) → round(x) for 1-unit bins, or pre-compute the bin width client-side
- x::int / CAST(x AS int) → trunc(x) or round(x)
- col % N = 0 in WHERE → drop the predicate (over-fetch and trim client-side), or use ORDER BY col LIMIT N to bound the result
- IN (a, b, c) → col = a OR col = b OR col = c
- "last N days" via subquery → call list_edgelake_tables or query MAX(timestamp) first, compute the cutoff client-side, then pass it as a literal in the actual query
`,

	"stream.mqtt": `
query_config shape for MQTT:

    {
      "raw":    "sensors/+/temp",                  // topic glob (MQTT wildcard syntax: + = one segment, # = many)
      "type":   "stream_filter",
      "params": {
        "data_path": "$.payload.value"             // optional JSONPath into the message payload; pulls out the value field if the broker emits JSON
      }
    }

This is a streaming connection — the dashboard subscribes to the topic glob and emits a record per matching message. To learn what topics exist before subscribing, call list_mqtt_topics; to learn the JSON shape of a topic's payload, call sample_mqtt_topic.

Return columns: depends on data_path. With no data_path, you get topic + payload (raw). With a data_path, you get topic + value (extracted).
`,

	"stream.tsstore": `
query_config shape for ts-store push streams:

    {
      "raw":    "<series_name or wildcard>",
      "type":   "stream_filter",
      "params": { }
    }

ts-store is a push-based stream. The dashboard server holds the subscription; components receive records as they arrive. Use get_connection_schema to discover series and inbound payload shapes.
`,

	"api.rest": `
query_config shape for generic REST APIs:

    {
      "raw":    "/path/relative/to/base_url?param=value",
      "type":   "api",
      "params": {
        "method":      "GET" | "POST",             // default GET
        "body":        "{ ... }",                  // optional, JSON string for POST/PUT
        "headers":     { "X-Custom": "value" },    // optional per-call header overrides; merged on top of the connection's default headers
        "data_path":   "$.results"                 // optional JSONPath into the response to extract the array of records
      }
    }

Return columns: derived from the records in data_path (or the top-level response if data_path is empty). Use get_connection_schema if the connection has a recorded schema; otherwise probe with query_connection limit=1 to see the actual response shape.
`,

	"file.csv": `
query_config shape for CSV file connections:

    {
      "raw":    "filter_expression_or_empty",
      "type":   "csv_filter",
      "params": { }
    }

Return columns: the CSV header row (or column_1, column_2 if has_headers=false on the connection). All values are strings unless the connection config sets per-column types.
`,
}
