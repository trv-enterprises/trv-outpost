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
//
// Lookup tolerates the bare last segment of a dotted TypeID: agents
// (especially external MCP clients) routinely pass "prometheus",
// "tsstore", or "mqtt" instead of the registry's "api.prometheus",
// "store.tsstore", "stream.mqtt". An exact match wins; otherwise we
// match on the suffix after the final dot, but only when that suffix
// is unambiguous across the keyed types.
func Get(typeID string) (string, bool) {
	if g, ok := guidance[typeID]; ok {
		return strings.TrimSpace(g), true
	}
	if resolved, ok := suffixAlias[typeID]; ok {
		return strings.TrimSpace(guidance[resolved]), true
	}
	return strings.TrimSpace(genericFallback), false
}

// suffixAlias maps the unambiguous bare last segment of each keyed
// dotted TypeID back to its full key. Built once from the guidance
// map; suffixes shared by more than one key are omitted so an
// ambiguous alias falls through to the generic fallback rather than
// silently picking one.
var suffixAlias = buildSuffixAlias()

func buildSuffixAlias() map[string]string {
	counts := map[string]int{}
	for k := range guidance {
		counts[suffixOf(k)]++
	}
	out := map[string]string{}
	for k := range guidance {
		s := suffixOf(k)
		if s != k && counts[s] == 1 {
			out[s] = k
		}
	}
	return out
}

func suffixOf(typeID string) string {
	if i := strings.LastIndex(typeID, "."); i >= 0 {
		return typeID[i+1:]
	}
	return typeID
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

Multiple series on ONE chart (the key mapping — get this wrong and every
series collapses into a single merged line):
A PromQL query that yields several series — e.g. sum by (mode)(...),
sum by (device)(...), node_load1/5/15, or a label_replace(...) that
synthesizes a label — returns those series STACKED in one result: the rows
for series A, then the rows for series B, etc., with the distinguishing label
as its OWN COLUMN (the column is named exactly after the PromQL label: "mode",
"device", "instance", or whatever label_replace's dst_label is). It is NOT one
column per series.
To split them into separate lines, set data_mapping like:
    {
      "x_axis": "timestamp",
      "y_axis": ["value"],
      "series": "<label column>"   // e.g. "mode" or "device" — the field is
                                   // named "series", a SINGLE column name
                                   // (string), NOT "series_column", NOT
                                   // "group_by"
    }
The viewer partitions rows by data_mapping.series, one line per distinct value.
If you OMIT series, all the stacked rows render as one zig-zagging line — that's
the "single merged line" symptom. So: whenever a range query has a "by (label)"
clause or a label_replace, the chart's data_mapping.series MUST name that label
column. Verify with query_connection limit=2: if you see a label column
alongside timestamp/value, point "series" at it.
For load1/5/15 specifically there is no shared label — each is a separate
metric. Two options: (a) one y_axis column per metric by aliasing them into
distinct columns, or (b) a single query
label_replace(node_load1,"line","1m","","") or node_load{...} that carries a
"line"/role label, then series:"line". Probe first to see which columns you get.

Discovering metrics/labels — do NOT call get_connection_schema on Prometheus.
A Prometheus instance commonly exposes thousands of metric names; the schema
pull is large enough to blow a small context. Prefer narrow discovery:
  - if your tool surface has list_prometheus_label_values, use it
    (label="__name__" for metric names, label="<label>" for a label's values).
  - otherwise query_connection against the standard label-values shape, e.g.
    raw="count by (__name__)({__name__=~\".+\"})" type="prometheus"
    params:{query_type:"instant"}, to enumerate metric names cheaply.
Then write the PromQL directly and probe the final query with query_connection
limit=1 only to confirm the column shape.
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
- Plain LIMIT N and ORDER BY — BUT the ORDER BY column MUST be in the SELECT
  projection (see the silent-empty trap below)

What FAILS (don't write these):
- ORDER BY a column that is NOT in the SELECT — returns an EMPTY result set
  with NO error (the most dangerous trap: the query "succeeds" with 0 rows, so
  it looks like there's no data). ALWAYS project every column you ORDER BY.
  e.g. "SELECT rul, sensor_11 ... ORDER BY cycle" → 0 rows; add cycle to the
  SELECT ("SELECT cycle, rul, sensor_11 ... ORDER BY cycle") → rows. For a
  time/sequence chart you want that ordering column on the x-axis anyway, so
  projecting it is the right shape regardless.
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

    // Records within a RELATIVE window — a Go DURATION (h/m/s; combine for
    // days, e.g. 240h = 10 days). This is the form to use for "last N days".
    { "raw": "since:240h", "type": "api", "params": { "limit": 5000 } }

    // Records since an ABSOLUTE unix-second timestamp (default cap = 100000)
    { "raw": "since:1779900000", "type": "api", "params": { "limit": 5000 } }

    // Records in an absolute unix-second range (default cap = 100000)
    { "raw": "range:1779900000:1779903600", "type": "api", "params": {} }

    // CURRENT STATE PER SERIES (latest_by, ts-store v0.19.0): the single
    // NEWEST record for each distinct value of a field — e.g. one row per
    // container, each with its latest reading. The right shape for
    // "current value per X" tables (dataview) and status tiles. No window
    // and no aggregation involved; a series is never dropped just because
    // it hasn't reported recently.
    { "raw": "newest", "type": "api", "params": { "latest_by": "container" } }

latest_by notes:
  - params.limit caps DISTINCT SERIES here (unset → up to 1000), not
    rows. Leave it unset unless you want fewer series.
  - Composes with params.filter (narrows the record set first). Raw
    "since:<dur>" bounds the scan — only series that reported inside
    the window come back.
  - Mutually exclusive with aggregation: the adapter automatically
    drops any step/group_by (e.g. from the viewer range picker) when
    latest_by is set, so never combine them yourself.
  - The editor's "Current State (latest per series)" query type writes
    exactly this shape.

  IMPORTANT: since: accepts EITHER a Go duration ("240h", "30m") for a
  relative window OR a unix-SECOND integer for an absolute start. It does NOT
  accept anything else — passing a date string, milliseconds, or a converted
  value in the wrong form fails with: invalid since duration: missing unit.
  For "last N days" prefer the duration form ("240h" for 10 days) — don't
  hand-convert a date to a timestamp.

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

Server-side aggregation you get WITHOUT asking: when the viewer's
range picker is active, the connector forwards a downsampling step
(and partitions it per series via group_by = data_mapping.series on
pivoted charts) to ts-store automatically. Do not try to replicate
downsampling in the query or in component code. What ts-store canNOT
do server-side is per-column predicates or computed math — those stay
client-side via data_mapping.filters, or by pulling a wider
since/range window and aggregating in the component.

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

## Latest-value tiles (number / gauge)

A KPI tile shows the most recent value off the push stream. Use
stream_filter + an aggregation of "last":

    "query_config": { "raw": "<series or empty>", "type": "stream_filter" },
    "data_mapping": { "y_axis": ["cpu.pct"], "aggregation": { "type": "last" } }

(REST-mode equivalent: latest_by, above — one request returns each
series' newest record; the right choice for a whole current-state
table rather than a single tile.)

## Trend charts (line / area) — use a sliding_window

A streaming line/area chart keeps a rolling time window of pushed
records and re-renders as each one arrives. Set a sliding_window in
data_mapping so the chart holds (and backfills) a fixed span instead
of just the newest point:

    "query_config": { "raw": "since:1h", "type": "stream_filter" },
    "data_mapping": {
      "x_axis": "timestamp",
      "y_axis": ["cpu.pct"],
      "sliding_window": { "duration": 3600, "timestamp_col": "timestamp" }
    }

  - sliding_window.duration is in SECONDS (3600 = last hour, 300 = last
    5 min). timestamp_col is the time column to window on — for ts-store
    that is the synthetic "timestamp" field present on every record.
  - raw "since:<dur>" (e.g. "since:1h") backfills that span on first
    paint, then the window filters the rendered span to that same
    duration as live records append (the underlying buffer keeps
    more). Match the since: span to the window duration.
  - Map y_axis to RAW streamed columns (the dotted field names from the
    schema, e.g. cpu.pct, memory.pct) — never compute in the query, there
    is no SQL here. For unit/time DISPLAY on a number tile, map the raw
    column and pick a numberFormat instead of writing custom code:
    "duration" (raw SECONDS → "2d 3h 4m", e.g. uptime.sec), "duration_clock"
    (seconds → HH:MM:SS), or "compact" (large values → 1.2M / 3.4K). Only
    drop to a custom-code component for a conversion none of those cover
    (e.g. bytes→GB as a plain number has no built-in scale yet — use
    "compact" or custom code).

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

Dashboard variable / filtering: a generic REST API has NO standard
filter parameter — do NOT assume a query param like "?location=..."
works. Unless you have PROVEN the API honors a specific param (by
probing query_connection with and without it and seeing the response
actually narrow), apply a dashboard variable CLIENT-SIDE: add a
data_mapping.filter whose value is the literal token
"{{dashboard-variable}}" (e.g. { field: "location", op: "eq", value:
"{{dashboard-variable}}" }) — the viewer substitutes the active value
and filters the fetched rows. Putting the token in the URL silently
no-ops when the API ignores the param (every panel then shows ALL
data). Contrast: ts-store HAS a real source-side params.filter (use it
there); SQL/EdgeLake use the {{dashboard-variable}} token inside the
query. Generic API → client-side filter is the safe default.
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
