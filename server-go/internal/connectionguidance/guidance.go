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
//     to external agents like Claude Desktop and other MCP clients.
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

Choose query_type by the chart's X-AXIS, not its chart type:
  - "instant" → ONE snapshot. Use whenever the x-axis is a LABEL/category
    (deployment, pod, instance, mode) or there is no x-axis at all
    (gauge, number/stat, pie). A BAR chart of "current value per
    deployment" is INSTANT — its x-axis is the deployment label, not
    time. Returns one row per series.
  - "range" → a TIME SERIES. Use only when the x-axis is TIME (a
    line/area/bar trending a value OVER TIME). Returns one row per
    (series × timestamp).

Common mistake: defaulting a bar chart to "range" because it's a bar
chart. If the bars are categories (deployments, nodes, modes) and you
want their CURRENT values, that's "instant" — a range query turns 7
bars into 7×N rows with repeating timestamps and renders as garbage.

ALWAYS set query_type explicitly. Omitting it defaults to "range",
which is wrong for every label-axis / single-value chart.

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

	"store.tsstore": `
ts-store does NOT speak SQL. query_connection takes a small DSL on
the "raw" field, not a SQL string. Writing SQL silently downgrades
to "newest" and you get 10 rows — the WHERE clause is ignored. Use
the shapes below, or for live data switch the connection's
transport to "streaming" and use stream_filter (see below).

The query_config.type field is documentary for ts-store (dispatch
is by the connection's type, not the query's). Use "api" for REST-
mode connections and "stream_filter" for streaming-mode — that's
what the editor and tooling expect.

# REST mode (transport: rest or unset)

query_config shapes:

    // Latest N records (default cap = 10 rows)
    { "raw": "newest", "type": "api", "params": { "limit": 100 } }

    // Oldest N records (default cap = 10 rows)
    { "raw": "oldest", "type": "api", "params": { "limit": 100 } }

    // All records since a unix-second timestamp (default cap = 100000)
    { "raw": "since:1779900000", "type": "api", "params": { "limit": 5000 } }

    // Records in a unix-second range (default cap = 100000)
    { "raw": "range:1779900000:1779903600", "type": "api", "params": {} }

Implicit row caps when params.limit is unset:
  - newest / oldest / default → 10
  - since:* / range:*         → 100000

ALWAYS pass an explicit params.limit when you care about the row
count. The default cap on "newest" is 10 — small enough to surprise
you if you assumed otherwise.

Server-side filtering (optional, any raw mode):
  - params.filter            — substring match against record JSON
  - params.filter_ignore_case — case-insensitive variant (bool)

NOTE: filter is a plain SUBSTRING over the whole record, NOT a
field-scoped predicate. In practice ts-store records carry very few
label fields, so a general substring (e.g. a location/host value)
reliably isolates one source without false matches.

ts-store counts MATCHES, not candidates: "newest" with limit=1000 and
a filter returns up to 1000 records THAT MATCH (it scans more behind
the scenes). This is why source-side filter is the right tool when one
stream interleaves many values (e.g. many machines): a client-side
filter on an unfiltered "newest 1000" leaves only ~1000/M rows for the
selected value, but params.filter returns the full 1000 for it.

Dashboard variable: set params.filter to the literal token
"{{dashboard-variable}}" to bind the source-side filter to the active
dashboard variable — the server substitutes the chosen value at query
time. Prefer this over a client-side variable filter for ts-store so
filtered panels get complete per-value history (incl. backfill).

Anything richer (per-column predicates, math, GROUP BY) must be
done client-side via data_mapping.filters or by pulling a wider
window with since/range and aggregating in the component.

# Streaming mode (transport: streaming)

Live push connections (the dashboard server holds a websocket to
ts-store, components receive records as they arrive):

    {
      "raw":    "<series_name or wildcard or empty>",
      "type":   "stream_filter",
      "params": { }
    }

A given ts-store connection is either REST or streaming based on
its config.transport — they are not interchangeable. To convert,
edit the connection.

# Discovering columns

Call get_connection_schema first — the adapter handles all three
ts-store store data_types:
  - "schema" stores: returns the formal schema endpoint's columns
  - "json" / unset:  samples 10 newest records and unions their keys
  - "text" stores:   returns an empty column list (text payload has
                     no fields — render the raw message)

Return columns from query_connection match what get_connection_schema
shows, plus a synthetic "timestamp" column on every record.

# Common pitfall (do not do this)

  // WRONG — SQL is silently downgraded to "newest" / 10 rows
  { "raw": "SELECT * FROM x WHERE ts >= NOW() - INTERVAL '1 hour'",
    "type": "tsstore" }

There is no SQL parser in the ts-store adapter. The "type" field
above is also not real ("tsstore" isn't a supported query type id).
Use newest/oldest/since:/range: with params.limit instead.
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
