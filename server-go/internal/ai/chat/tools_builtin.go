// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trv-enterprises/trve-dashboard/internal/ai/toolops"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// RegisterBuiltinTools wires the chat agent's Tier-A toolset. Every
// tool here goes through the shared `toolops` layer so MCP and the
// chat agent stay in lock-step on what each operation actually does.
//
// Tier-A is the always-loaded set — schemas inline on every turn.
// Step 5 will add the Tier-B / describe_tool pattern for less-used
// operations.
func RegisterBuiltinTools(reg *ToolRegistry, ops *toolops.Toolset) {
	// ─── Identity / context ───
	reg.Register(Tool{
		Name:        "get_current_user",
		Description: "Returns the calling user's profile (name, GUID, and capabilities). Use this to greet the user by name and to know what they're allowed to do.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapGetCurrentUser(ops),
	})

	reg.Register(Tool{
		Name:        "list_namespaces",
		Description: "List every namespace in the deployment. Namespaces are the conflict-domain grouping on connections / components / dashboards — uniqueness of name is per-namespace.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListNamespaces(ops),
	})

	// ─── Connections ───
	reg.Register(Tool{
		Name:        "list_connections",
		Description: "List configured connections (SQL, API, MQTT, EdgeLake, etc), filtered/sorted/paginated server-side. By default returns ALL matching connections (up to a 1000 cap). Returns name, type, and ID for each (secrets masked). total + has_more indicate truncation.",
		Tier:        TierA,
		InputSchema: listObjectSchema(map[string]interface{}{
			"namespace": map[string]interface{}{"type": "string", "description": "Filter by namespace"},
			"name":      map[string]interface{}{"type": "string", "description": "Filter by name (case-insensitive substring)"},
			"type":      map[string]interface{}{"type": "string", "description": "Filter by connection type"},
			"tags":      map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Filter by tags (OR semantics)"},
		}, "name, created_at, updated_at, type, namespace"),
		Handler: wrapListConnections(ops),
	})

	// Tier B: schema only loaded after describe_tool. Each
	// connection's full config can be large and is only needed when
	// the model is doing something specific to a single connection.
	reg.Register(Tool{
		Name:        "get_connection",
		Description: "Get the full configuration for a single connection by ID. Returns `{connection, guidance, guidance_type}` — the `guidance` field is the per-type cheat sheet for how to build query_config against this adapter (limits, DSL caveats, escape hatches). Read it before calling query_connection — adapter conventions are NOT inferrable from the generic query_connection schema alone.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{
					"type":        "string",
					"description": "Connection ID",
				},
			},
			"required": []string{"id"},
		},
		Handler: wrapGetConnection(ops),
	})

	// Tier B: schema discovery (SQL tables/columns, Prometheus
	// metrics/labels, ts-store sample-and-union, etc). Bundles the
	// per-type guidance with the schema so the model learns both
	// "what columns exist" and "how to write query_config" in one
	// fetch.
	reg.Register(Tool{
		Name:        "get_connection_schema",
		Description: "Discover the schema of a connection — tables and columns for SQL; metrics and labels for Prometheus; sampled JSON keys for ts-store. Returns `{schema, guidance, guidance_type}`; read the `guidance` for the query-config conventions this adapter actually accepts before calling query_connection. Returns success-with-error in `schema.error` for connection types that don't support schema discovery.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "Connection ID"},
			},
			"required": []string{"connection_id"},
		},
		Handler: wrapGetConnectionSchema(ops),
	})

	// Tier B: EdgeLake catalog browse. EdgeLake doesn't support generic
	// schema discovery (get_connection_schema returns success-with-error for
	// it); its guidance tells the agent to drill down database → table →
	// column with these three tools instead. They were MCP-only before, so the
	// chat Assistant read guidance pointing at tools it couldn't call and
	// failed "what EdgeLake databases do I have" — now it can enumerate them.
	reg.Register(Tool{
		Name:        "list_edgelake_databases",
		Description: "List the databases available on an EdgeLake connection. The first hop for EdgeLake — call this to answer \"what data is on this connection\" before list_edgelake_tables.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "EdgeLake connection ID"},
			},
			"required": []string{"connection_id"},
		},
		Handler: wrapListEdgeLakeDatabases(ops),
	})

	reg.Register(Tool{
		Name:        "list_edgelake_tables",
		Description: "List the tables in an EdgeLake database (the second hop after list_edgelake_databases). EdgeLake routes every query by database, so you need a database name first.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "EdgeLake connection ID"},
				"database":      map[string]interface{}{"type": "string", "description": "Database name (from list_edgelake_databases)"},
			},
			"required": []string{"connection_id", "database"},
		},
		Handler: wrapListEdgeLakeTables(ops),
	})

	reg.Register(Tool{
		Name:        "get_edgelake_table_schema",
		Description: "Get column information for an EdgeLake table (the leaf of database → table → column). Use the columns to build a query_config before calling query_connection.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "EdgeLake connection ID"},
				"database":      map[string]interface{}{"type": "string", "description": "Database name"},
				"table":         map[string]interface{}{"type": "string", "description": "Table name (from list_edgelake_tables)"},
			},
			"required": []string{"connection_id", "database", "table"},
		},
		Handler: wrapGetEdgeLakeTableSchema(ops),
	})

	// Tier B: type-shopping. Use when no specific connection is
	// selected yet — e.g. "what would a Postgres connection look
	// like before I create one." For the more common
	// "I've picked a connection and want to query it" path, the
	// guidance bundled on get_connection / get_connection_schema is
	// usually what you want.
	reg.Register(Tool{
		Name:        "get_connection_type_guidance",
		Description: "Fetch the query_config conventions for a connection adapter type (e.g. `store.tsstore`, `api.prometheus`, `sql.postgres`). Use this when picking a type to create, or when you need conventions for a type and don't have a specific connection ID in hand. For an existing connection prefer `get_connection` / `get_connection_schema` — they bundle the same guidance with the actual connection / column data.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"type": map[string]interface{}{"type": "string", "description": "Connection type id (matches the `type_id` from get_type_catalog)."},
			},
			"required": []string{"type"},
		},
		Handler: wrapGetConnectionTypeGuidance(ops),
	})

	reg.Register(Tool{
		Name:        "query_connection",
		Description: "Execute an ad-hoc query against a connection. Pass `connection_id`, `raw` (the query string), `type` (sql / api / csv_filter / stream_filter), and optional `params`. Pass `limit` to cap rows returned — useful when you only need to verify the result shape before building a chart. `limit: 1` is the common shape-probe pattern. NOTE: adapters interpret `raw` and `params` differently — some have a custom DSL or implicit row caps. Call `get_connection` or `get_connection_type_guidance` FIRST and read the bundled `guidance` field; relying on the generic schema alone gets you silently-downgraded results on adapters like ts-store.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "Connection ID to query"},
				"raw":           map[string]interface{}{"type": "string", "description": "The query string (SQL, API path, filter expression, etc)"},
				"type":          map[string]interface{}{"type": "string", "description": "Query type — sql, api, csv_filter, stream_filter"},
				"params":        map[string]interface{}{"type": "object", "description": "Optional query parameters"},
				"limit":         map[string]interface{}{"type": "integer", "description": "Cap rows returned. Use small (1-5) for shape probes; omit for full results."},
			},
			"required": []string{"connection_id", "raw"},
		},
		Handler: wrapQueryConnection(ops),
	})

	reg.Register(Tool{
		Name:        "analyze_dataset",
		Description: "Run a server-side statistical analysis over a connection's data and get back a compact summary — the server fetches the rows (up to 50k) and does the math in Go, so PREFER this over query_connection for any question about the shape, health, or behavior of data too big to read row-by-row (\"anything weird in my power data?\", \"is temperature trending up?\", \"does A track B?\"). Analyses: `summary` (per-column mean/stddev/min/max/last/distinct/percentiles/histogram; optional `group_by` for per-group stats, optional `timestamp_column` for the data's time range), `anomaly` (rolling z-score outlier windows; needs `column`, works best with `timestamp_column`), `correlation` (Pearson between `column_a`/`column_b`, optional `max_lag` row-shift scan), `trend` (regression slope + R² plus hour-of-day/day-of-week means; needs `column`, `timestamp_column`). EXCEPTION for plain summary/group_by stats on `sql` or EdgeLake connections: push the aggregation into the query itself (AVG/COUNT/GROUP BY via query_connection) — the database computes exact answers with less data moved; use this tool's summary mainly for sources that can't aggregate in-query (api, ts-store, csv, streams). anomaly/correlation/trend can't be pushed into a query and are appropriate on ANY source. IMPORTANT: `max_rows` trims AFTER the source returns — it does not limit the fetch. On sql/edgelake ALWAYS bound the query yourself in `raw` (a LIMIT and/or a time-window filter, ideally with ORDER BY on the time column): an unbounded SELECT can pull an entire table into server memory, and trimming an unordered result biases the analysis toward arbitrary rows. Query fields (`raw`, `type`, `params`) work exactly like query_connection — read the connection's `guidance` first.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id":    map[string]interface{}{"type": "string", "description": "Connection ID to fetch data from"},
				"raw":              map[string]interface{}{"type": "string", "description": "The query string (SQL, API path, filter expression, etc) — same semantics as query_connection"},
				"type":             map[string]interface{}{"type": "string", "description": "Query type — sql, api, csv_filter, stream_filter"},
				"params":           map[string]interface{}{"type": "object", "description": "Optional query parameters"},
				"analysis":         map[string]interface{}{"type": "string", "enum": []string{"summary", "anomaly", "correlation", "trend"}, "description": "Which canned analysis to run"},
				"columns":          map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "summary only: columns to summarize (default: all, capped at 20)"},
				"column":           map[string]interface{}{"type": "string", "description": "anomaly/trend: the numeric column to analyze"},
				"column_a":         map[string]interface{}{"type": "string", "description": "correlation: first numeric column"},
				"column_b":         map[string]interface{}{"type": "string", "description": "correlation: second numeric column"},
				"timestamp_column": map[string]interface{}{"type": "string", "description": "Time column (RFC3339 or epoch, seconds or millis). Sorts the series and enables time-based output (window timestamps, per-second slope, hour/day buckets, summary time_range)"},
				"group_by":         map[string]interface{}{"type": "string", "description": "summary only: compute per-group stats keyed on this column's values (top 20 groups by row count; columns capped at 5 when grouped)"},
				"sensitivity":      map[string]interface{}{"type": "number", "description": "anomaly: z-score threshold, default 3.0 (lower = more sensitive, range 1-10)"},
				"max_lag":          map[string]interface{}{"type": "integer", "description": "correlation: scan row shifts up to ±max_lag for the strongest correlation (0 = no scan)"},
				"max_rows":         map[string]interface{}{"type": "integer", "description": "Cap rows ANALYZED (default and max 50000). Trims after the source returns — not a fetch limit; bound sql/edgelake queries in `raw` with LIMIT / a time window"},
			},
			"required": []string{"connection_id", "raw", "analysis"},
		},
		Handler: wrapAnalyzeDataset(ops),
	})

	// Write surface for connections — Tier-B because the type-specific
	// config shape is detailed and only relevant when the model is
	// actually creating a connection. The model will load this via
	// describe_tool after consulting get_type_catalog for the
	// connection types it can use.
	reg.Register(Tool{
		Name:        "create_connection",
		Description: "Create a new connection (SQL, API, MQTT, EdgeLake, etc). Returns the persisted record including its assigned ID. Pass the type_id from get_type_catalog (e.g. \"db.postgres\", \"stream.mqtt\", \"store.tsstore\") and a type_config object whose keys match that type's config_schema. The legacy `type`/`config` fields work too but type_id/type_config is preferred. Defaults: namespace=\"default\" when omitted.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name":        map[string]interface{}{"type": "string", "description": "Unique connection name (per namespace)"},
				"description": map[string]interface{}{"type": "string", "description": "Free-form description"},
				"namespace":   map[string]interface{}{"type": "string", "description": "Namespace slug; empty = \"default\""},
				"type_id":     map[string]interface{}{"type": "string", "description": "Dotted type id from get_type_catalog (e.g. \"db.postgres\", \"stream.mqtt\")"},
				"type_config": map[string]interface{}{"type": "object", "description": "Configuration object matching the type's config_schema"},
				"tags":        map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Optional tags"},
			},
			"required": []string{"name", "type_id"},
		},
		Handler: wrapCreateConnection(ops),
	})

	// ─── Components ───
	reg.Register(Tool{
		Name:        "list_components",
		Description: "List components (charts/controls/displays), filtered/sorted/paginated server-side. By default returns ALL matching components (up to a 1000 cap); use filters + page_size to narrow. The result's total + has_more indicate whether it was truncated.",
		Tier:        TierA,
		InputSchema: listObjectSchema(map[string]interface{}{
			"namespace":      map[string]interface{}{"type": "string", "description": "Filter by namespace"},
			"name":           map[string]interface{}{"type": "string", "description": "Filter by name (case-insensitive word-prefix match)"},
			"chart_type":     map[string]interface{}{"type": "string", "description": "Filter by chart subtype (bar, line, etc)"},
			"component_type": map[string]interface{}{"type": "string", "enum": []string{"chart", "control", "display"}, "description": "Filter by component type"},
			"status":         map[string]interface{}{"type": "string", "enum": []string{"draft", "final"}, "description": "Filter by status"},
			"connection_id":  map[string]interface{}{"type": "string", "description": "Filter by connection ID"},
			"tags":           map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Filter by tags (OR semantics)"},
		}, "name, updated, created, component_type, chart_type, status, namespace"),
		Handler: wrapListComponents(ops),
	})

	reg.Register(Tool{
		Name:        "get_component",
		Description: "Get the latest version of a component (chart / control / display) by ID. Returns its full configuration including query_config, data_mapping, and any inline component_code. Use this when the model needs to inspect a component before referencing it from a dashboard.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Component ID"},
			},
			"required": []string{"id"},
		},
		Handler: wrapGetComponent(ops),
	})

	reg.Register(Tool{
		Name:        "create_component",
		Description: "Create a chart, control, or display. Returns the persisted record including its assigned ID. For charts, prefer structured config (chart_type + query_config + data_mapping) over custom code — the server's codegen produces the React component from the structured fields. Set use_custom_code=true and supply component_code only when the structured config genuinely cannot represent what the user asked for. Defaults: component_type=\"chart\", namespace=\"default\". Reference the chart_types / control_types / display_types lists from get_type_catalog for valid type identifiers.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"component_type":  map[string]interface{}{"type": "string", "description": "\"chart\" (default), \"control\", or \"display\""},
				"namespace":       map[string]interface{}{"type": "string", "description": "Namespace slug; empty = \"default\""},
				"name":            map[string]interface{}{"type": "string", "description": "Unique component name (per namespace)"},
				"title":           map[string]interface{}{"type": "string", "description": "Display title (defaults to name when empty)"},
				"description":     map[string]interface{}{"type": "string", "description": "Short human-readable description of what this component shows and its data source — ALWAYS set it (e.g. \"CPU utilization % over time from the TRV-SRV-001 system-stats stream\"). Surfaces on the components list + helps future users/agents understand the component."},
				"chart_type":      map[string]interface{}{"type": "string", "description": "For charts: bar, line, pie, scatter, gauge, area, banded_bar, dataview, custom"},
				"connection_id":   map[string]interface{}{"type": "string", "description": "Connection ID this component reads from (omit for connection-less components)"},
				"query_config":    chartQueryConfigSchema(),
				"data_mapping":    chartDataMappingSchema(),
				"control_config":  map[string]interface{}{"type": "object", "description": "Control-specific config (control_type + UI fields) — only for component_type=control"},
				"display_config":  map[string]interface{}{"type": "object", "description": "Display-specific config — only for component_type=display"},
				"component_code":  map[string]interface{}{"type": "string", "description": "Inline React component code; only set with use_custom_code=true"},
				"use_custom_code": map[string]interface{}{"type": "boolean", "description": "true = use component_code; false (default) = let the server's codegen produce code from the structured fields"},
				"options":         chartOptionsSchema(),
				"tags":            map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Lowercase hyphenated tags for findability — ALWAYS set these. Cover the data source/integration (e.g. \"edgelake\", \"node-exporter\", \"system-stats\"), the host/dataset (e.g. \"trv-srv-001\", \"machine-telemetry\"), and the metric/topic shown (e.g. \"cpu\", \"memory\", \"temperature\"). Share the source/host tags across all components in one build so they group."},
			},
			"required": []string{"name"},
		},
		Handler: wrapCreateComponent(ops),
	})

	reg.Register(Tool{
		Name:        "update_component",
		Description: "Modify an existing component in place (charts, controls, displays). PREFER THIS over rewriting a chart as custom code: get_component first to see its current config, then patch only the fields that change. Only the fields you set are touched — omit the rest. For charts, changing chart_type / data_mapping / query_config / options keeps the component spec-driven and re-renders automatically; you do NOT need to (and should not) set component_code for a config chart. Set use_custom_code=true + component_code only when the structured config genuinely cannot express the request. Do not call this on a component the user is actively editing (see the active-edit rule).",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id":              map[string]interface{}{"type": "string", "description": "Component ID to update (required)."},
				"title":           map[string]interface{}{"type": "string", "description": "Display title."},
				"description":     map[string]interface{}{"type": "string"},
				"chart_type":      map[string]interface{}{"type": "string", "description": "For charts: bar, line, pie, scatter, gauge, area, banded_bar, dataview, custom. Changing this re-syncs the rendered chart."},
				"connection_id":   map[string]interface{}{"type": "string", "description": "Connection ID this component reads from."},
				"query_config":    chartQueryConfigSchema(),
				"data_mapping":    chartDataMappingSchema(),
				"control_config":  map[string]interface{}{"type": "object", "description": "Control-specific config — only for component_type=control"},
				"display_config":  map[string]interface{}{"type": "object", "description": "Display-specific config — only for component_type=display"},
				"component_code":  map[string]interface{}{"type": "string", "description": "Inline React component code; only set together with use_custom_code=true"},
				"use_custom_code": map[string]interface{}{"type": "boolean", "description": "Set true to switch this chart into custom-code mode (destructive: config fields stop driving the render). Leave unset to keep it spec-driven."},
				"options":         chartOptionsSchema(),
				"tags":            map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Lowercase hyphenated tags (source/integration + host/dataset + metric/topic). Set when creating tagged content or when the user asks to retag."},
			},
			"required": []string{"id"},
		},
		Handler: wrapUpdateComponent(ops),
	})

	reg.Register(Tool{
		Name:        "delete_component",
		Description: "Delete a component (chart/control/display) by ID — all versions. Use this to clean up components you replaced or no longer need (e.g. orphaned/unplaced ones). BLOCKED if any dashboard still references it: the error names the referencing dashboards — remove those panel references first (update_dashboard) then retry. Confirm with the user before deleting components they didn't ask you to remove.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Component ID to delete"},
			},
			"required": []string{"id"},
		},
		Handler: wrapDeleteComponent(ops),
	})

	// ─── Dashboards ───
	reg.Register(Tool{
		Name:        "list_dashboards",
		Description: "List dashboards, filtered/sorted/paginated server-side. By default returns ALL matching dashboards (up to a 1000 cap). Pass component_id to find dashboards that use a specific component. total + has_more indicate truncation.",
		Tier:        TierA,
		InputSchema: listObjectSchema(map[string]interface{}{
			"namespace":     map[string]interface{}{"type": "string", "description": "Filter by namespace"},
			"name":          map[string]interface{}{"type": "string", "description": "Filter by name (partial match)"},
			"is_public":     map[string]interface{}{"type": "boolean", "description": "Filter by public status"},
			"component_id":  map[string]interface{}{"type": "string", "description": "Only dashboards that reference this component"},
			"connection_id": map[string]interface{}{"type": "string", "description": "Only dashboards using any component bound to this connection"},
			"tags":          map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Filter by tags (OR semantics)"},
		}, "name, updated, created, namespace"),
		Handler: wrapListDashboards(ops),
	})

	reg.Register(Tool{
		Name:        "get_dashboard",
		Description: "Get a dashboard by ID, including its panels array. Use this to inspect a dashboard's composition before modifying it (e.g. \"add panel 4 with the new voltage chart\").",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Dashboard ID"},
			},
			"required": []string{"id"},
		},
		Handler: wrapGetDashboard(ops),
	})

	reg.Register(Tool{
		Name:        "create_dashboard",
		Description: "Create a new dashboard. Returns the persisted record including its assigned ID. Panels are positioned on a 32×32-px grid via integer cell coords {x, y, w, h}; canvas size derives from settings.layout_dimension. Each panel references a component by component_id (which you must create FIRST via create_component). Defaults: namespace=\"default\".\n\nThe `settings.layout_dimension` value must match one of the preset names returned by `get_type_catalog` in the `layout_dimensions` array. Each entry tells you the cols × rows cell budget for panel coordinates — call get_type_catalog first if you need to pick a size. Keep all panel x+w ≤ cols and y+h ≤ rows for whichever preset you choose.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"namespace":   map[string]interface{}{"type": "string", "description": "Namespace slug; empty = \"default\""},
				"name":        map[string]interface{}{"type": "string", "description": "Unique dashboard name (per namespace)"},
				"description": map[string]interface{}{"type": "string"},
				"panels":      dashboardPanelsSchema(),
				"settings":    dashboardSettingsSchema(),
				"tags":        map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Lowercase hyphenated tags for findability — ALWAYS set these, mirroring the source/host tags you put on the dashboard's components (e.g. [\"system-stats\", \"trv-srv-001\"]) so the dashboard groups with its components on the list pages."},
				"metadata":    map[string]interface{}{"type": "object"},
			},
			"required": []string{"name"},
		},
		Handler: wrapCreateDashboard(ops),
	})

	reg.Register(Tool{
		Name:        "update_dashboard",
		Description: "Update an existing dashboard. Only the fields you provide are changed; omit a field to leave it untouched. When `panels` is provided it REPLACES the entire panel array — call get_dashboard first if you only want to add or modify a subset. Use this to add dashboard variables to an existing dashboard: fetch it, then patch `settings` with `variables_enabled` + `variables` (see create_dashboard's settings schema and the system prompt's \"Dashboard variables\" section). Do NOT call this on a dashboard the user is actively editing (mode: EDIT in the current view) — your write would overwrite their unsaved local changes; tell them to commit or discard first.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id":          map[string]interface{}{"type": "string", "description": "Dashboard ID to update"},
				"name":        map[string]interface{}{"type": "string", "description": "New name (unique per namespace)"},
				"namespace":   map[string]interface{}{"type": "string", "description": "Move the dashboard to a different namespace; omit to leave unchanged"},
				"description": map[string]interface{}{"type": "string"},
				"panels":      dashboardPanelsSchema(),
				"settings":    dashboardSettingsSchema(),
				"tags":        map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Replaces the existing tag list"},
				"metadata":    map[string]interface{}{"type": "object"},
			},
			"required": []string{"id"},
		},
		Handler: wrapUpdateDashboard(ops),
	})

	reg.Register(Tool{
		Name:        "delete_dashboard",
		Description: "Delete a dashboard (the panel grid) by ID. The components it referenced are NOT deleted (they may be reused elsewhere) — delete any now-orphaned components separately with delete_component. Confirm with the user before deleting a dashboard they didn't ask you to remove.",
		Tier:        TierB,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{"type": "string", "description": "Dashboard ID to delete"},
			},
			"required": []string{"id"},
		},
		Handler: wrapDeleteDashboard(ops),
	})

	// Tier B: the catalog is big (every type with config + metadata)
	// and isn't relevant to most conversations. Load it on demand.
	reg.Register(Tool{
		Name:        "get_type_catalog",
		Description: "Returns the unified catalog of every type the dashboard knows about: connection types, chart subtypes, control subtypes, display subtypes, device types. Call this when planning to build something so you know what's available.",
		Tier:        TierB,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapGetCatalog(ops),
	})

	// ─── Meta: result store ───
	// get_full_result fetches the verbatim content of a tool result
	// that was stored server-side because it was too large to inline
	// (the result-store layer; see internal/ai/chat/result_store.go).
	// Most of the time the inline summary already answers the
	// question — only call this when you genuinely need the full
	// payload, because retrieving it can consume significant
	// context.
	reg.Register(Tool{
		Name:        "get_full_result",
		Description: "Retrieve a previously-stored large tool result by its result_id. PREFER passing a `filter` to extract just the slice you need — returning the whole payload can re-blow context. result_id looks like `r_abc12345` and is in the summary of any large tool call.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"result_id": map[string]interface{}{
					"type":        "string",
					"description": "The result ID returned in the summary of a large tool call (e.g. r_abc12345).",
				},
				"filter": map[string]interface{}{
					"type": "string",
					"description": "Optional gjson PATH to extract only what you need (this is gjson syntax, NOT jq). " +
						"Leave empty to get the whole result. Syntax: dot-path with `#` for arrays. " +
						"Examples — list results `{connections:[...],count}`: `connections.#.name` (all names), " +
						"`connections.#(type==\"sql\").name` (names where type==sql), `connections.0` (first), `count`. " +
						"Query results `{columns:[...],rows:[[...]]}`: `columns`, `rows.0` (first row), `rows.#`(row count). " +
						"Use the field names from the summary you already received. A wrong path returns an error listing the valid top-level keys.",
				},
			},
			"required": []string{"result_id"},
		},
		Handler: wrapGetFullResult(),
	})

	// ─── Meta: tier-B schema loader ───
	// describe_tool fetches the input schema for a Tier-B tool. The
	// agent then keeps that schema in context for subsequent turns
	// in the same conversation, so describe_tool only costs one
	// round-trip per Tier-B tool the model uses.
	//
	// The result is returned via the tool result, AND the agent
	// marks the requested tools as "revealed" so the next turn's
	// Tools list includes their schemas (the dispatcher does this
	// via DispatchEnv.RevealTierB — wired in agent.go).
	reg.Register(Tool{
		Name:        "describe_tool",
		Description: "Fetch the input schema for one or more Tier-B tools listed in the system prompt's 'Additional tools' section. Pass a single name or a list of names. After this call, the named tools become directly invocable in this conversation. Don't describe a tool you don't intend to use — it costs context to load schemas.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"names": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Names of Tier-B tools to load. Accept a list even for a single tool.",
				},
			},
			"required": []string{"names"},
		},
		Handler: wrapDescribeTool(reg),
	})
}

// emptyObjectSchema is the JSON-schema for tools that take no input.
func emptyObjectSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
	}
}

// listObjectSchema builds an object schema from the given property map and
// appends the shared sort + pagination properties every list tool accepts
// (#21). sortFields is the human-readable allowlist shown in the sort
// description. The result advertises the FULL queryable surface so the
// agent can filter/sort/page precisely instead of pulling everything.
func listObjectSchema(props map[string]interface{}, sortFields string) map[string]interface{} {
	if props == nil {
		props = map[string]interface{}{}
	}
	props["sort"] = map[string]interface{}{"type": "string", "description": "Sort field. One of: " + sortFields + ". Omit for the default."}
	props["direction"] = map[string]interface{}{"type": "string", "enum": []string{"asc", "desc"}, "description": "Sort direction. Omit for the default."}
	props["page"] = map[string]interface{}{"type": "integer", "description": "1-based page number (default 1)."}
	props["page_size"] = map[string]interface{}{"type": "integer", "description": "Records per page. Omit or 0 = all matching, up to a server cap of 1000. The result's total + has_more tell you whether it was truncated."}
	return map[string]interface{}{"type": "object", "properties": props}
}

// chartQueryConfigSchema returns the inline JSON-schema for
// ChartQueryConfig (models/dashboard.go). Inlining the field names
// is what stops the model from inventing plausible-but-wrong keys
// like `query` / `query_type` (observed in the 2026-05-26 export —
// fields were silently dropped during JSON unmarshal and the chart
// shipped with an empty query).
func chartQueryConfigSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "How to query data for this chart. Field names are exact — extra keys are silently ignored.",
		"properties": map[string]interface{}{
			"raw": map[string]interface{}{
				"type":        "string",
				"description": "The query string. SQL statement for sql; API path/endpoint for api; filter expression for stream_filter / csv_filter.",
			},
			"type": map[string]interface{}{
				"type":        "string",
				"description": "Query mode: sql, api, csv_filter, stream_filter.",
				"enum":        []string{"sql", "api", "csv_filter", "stream_filter"},
			},
			"params": map[string]interface{}{
				"type":        "object",
				"description": "Optional query parameters (named bind vars for sql, query-string params for api, etc). ts-store REST connections also take limit / filter / filter_ignore_case / latest_by here, plus store (REQUIRED on an endpoint-scoped ts-store connection — one with no pinned store_name; ignored when the connection pins a store) — see get_connection_type_guidance for the shapes.",
			},
		},
	}
}

// chartDataMappingSchema returns the inline JSON-schema for
// ChartDataMapping (models/dashboard.go). Same motivation as
// chartQueryConfigSchema — the model was using `value` instead of
// `y_axis` for gauges, and the field was silently dropped.
func chartDataMappingSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "Column → axis mapping for this chart. For a single-value chart like gauge, set y_axis to a one-element array of the value column name (e.g. y_axis: [\"temp\"]).",
		"properties": map[string]interface{}{
			"x_axis":        map[string]interface{}{"type": "string", "description": "Column name for the X axis (categories/time)."},
			"x_axis_label":  map[string]interface{}{"type": "string", "description": "Display label for the X axis. Empty = no axis name (typical for time-series)."},
			"x_axis_format": map[string]interface{}{"type": "string", "description": "Format for X values: chart, chart_time, chart_date, chart_datetime, short, long."},
			"y_axis": map[string]interface{}{
				"type":        "array",
				"items":       map[string]interface{}{"type": "string"},
				"description": "Column name(s) for the Y axis (values), as plain strings. Always an array even for a single column (e.g. [\"temp\"]) — gauge / number-tile charts read y_axis[0]. For multiple series pass multiple column names (e.g. [\"cpu\", \"mem\"]). Per-column STACKING and dual-axis are set via options/multiple_y_axis, NOT by making entries objects: set multiple_y_axis=true for left/right split, and options.chartStacked=true to stack.",
			},
			"multiple_y_axis":          map[string]interface{}{"type": "boolean", "description": "Dual Y-axis mode. Off (default): all y columns share one axis (N columns allowed). On: the first two y columns split across left/right axes; pair with options.yAxisRange.right."},
			"y_axis_label":             map[string]interface{}{"type": "string", "description": "AXIS label — rendered vertically along the Y axis. Single-axis charts only: dual-axis charts render NO axis labels (the legend and axis colors identify each side), so this is ignored there. NOT a series/legend label; use y_axis_labels for those."},
			"y_axis_labels":            map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Per-SERIES labels, index-aligned to y_axis — shown in the legend. These name the value-sets, not the axis; the axis label is y_axis_label (single-axis only)."},
			"y_axis_colors":            map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Per-series color override, index-aligned to y_axis. Each entry is a Carbon palette NUMBER (\"1\"-\"14\"), a Carbon NAME (e.g. \"purple70\"), a hex (\"#6929c4\"), or \"\" for auto. Use to give a series a specific color (line/area/bar). NOT for pivot charts (series set) — those auto-color. Omit to keep the default palette."},
			"series":                   map[string]interface{}{"type": "string", "description": "Column that distinguishes series (e.g. \"location\" splits one column into per-location lines)."},
			"group_by":                 map[string]interface{}{"type": "string", "description": "Client-side grouping column."},
			"accumulator_columns":      map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "boolean"}, "description": "Line/area only. PER-COLUMN delta transform: a boolean array index-aligned to y_axis — true at position i plots that column's DELTA (value[i]-value[i-1]) instead of the raw value, for monotonically-increasing counters (odometers, packet/request totals, kWh meters). Lets you delta one series and leave another raw. Prefer this over custom code or a SQL LAG()/Prometheus rate(). First point is a gap. Omit = none."},
			"y_axis_conversions":       map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}, "description": "Line/area only. PER-SERIES unit conversion, index-aligned to y_axis. Converts a series' values BEFORE plotting, so the axis, thresholds and tooltip all read the converted unit — use this instead of doing unit math in the query or asking for a second stored column. Entry is null for no conversion, or {\"dimension\",\"from\",\"to\"} using: temperature (c/f/k), pressure (pa/hpa/kpa/bar/psi/inhg), distance (mm/cm/m/km/in/ft/mi), mass (g/kg/lb/oz), speed (mps/kph/mph/kn). Example — a column stored in Celsius shown as Fahrenheit: [{\"dimension\":\"temperature\",\"from\":\"c\",\"to\":\"f\"}]. For arithmetic the tables don't cover, use {\"dimension\":\"custom\",\"scale\":100,\"offset\":0,\"symbol\":\"%\"} (value*scale+offset). Two-column math (a-b, a/b) is NOT supported here. Omit = no conversions."},
			"accumulator_mode":         map[string]interface{}{"type": "boolean", "description": "Legacy chart-wide accumulator flag (deltas ALL y columns). Prefer accumulator_columns for per-column control; this is accepted for back-compat. Default false."},
			"accumulator_reset_policy": map[string]interface{}{"type": "string", "enum": []string{"drop_negative", "clamp_zero", "keep_negative"}, "description": "Counter-reset (negative delta) handling for accumulating columns. 'drop_negative' (default): gap/break the line. 'clamp_zero': emit 0. 'keep_negative': raw negative delta. Ignored when no column accumulates."},
			"label_col":                map[string]interface{}{"type": "string", "description": "Column used for pie/bar slice labels."},
			"filters":                  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}, "description": "Client-side filters: [{field, op, value}]. ops: eq, neq, gt, gte, lt, lte, contains, in, notIn, isNull, isNotNull."},
			"aggregation":              map[string]interface{}{"type": "object", "description": "Optional aggregation: {type: first|last|min|max|avg|sum|count|limit, sort_by, field, count}."},
			"sliding_window":           map[string]interface{}{"type": "object", "description": "{duration: seconds, timestamp_col: \"ts\"} — keep only the last N seconds of streaming data. Size it to the data's CADENCE and intent: it must hold many records, not one. Hourly-rollup data (one record/hour) needs a span of many hours/days (a 'Weekly' board → 604800); high-frequency live streams → ~3600. Use the user's span if given (15 min → 900, 1 day → 86400). When EDITING an existing chart, preserve the current duration unless the user asks to change the time span — do NOT reset it on a chart_type or visual change."},
			"latest_by":                map[string]interface{}{"type": "object", "description": "{key_col: \"disk\", timestamp_col: \"ts\"} — reduce to the NEWEST row per distinct value of key_col (\"current state per series\": one row per disk/volume/container). timestamp_col is optional; omit it to use the most recently received row, which is correct for streams. Use for a multi-series snapshot on chart_type dataview/bar/line/area/scatter. Do NOT use it on value or gauge — a single-value component expresses \"current value of disk1\" with a filter plus aggregation {type: \"last\"} instead. For a NON-streaming ts-store connection prefer the server-side equivalent (query_config.params.latest_by), which reduces before the data crosses the wire; this client-side field is the only option for streaming connections."},
			"time_bucket":              map[string]interface{}{"type": "object", "description": "{interval: seconds, function: avg|min|max|sum|count, value_cols: [\"temp\",\"humidity\"], timestamp_col: \"ts\"} — aggregate streaming rows into time buckets."},
			"sort_by":                  map[string]interface{}{"type": "string"},
			"sort_order":               map[string]interface{}{"type": "string", "enum": []string{"asc", "desc"}},
			"limit":                    map[string]interface{}{"type": "integer", "description": "Max rows the chart should render."},
			"band_columns": map[string]interface{}{
				"type":        "object",
				"description": "Banded-bar per-row band mapping. ONLY used by chart_type 'banded_bar'; ignored elsewhere. Pick a `scheme`, then map that scheme's columns to row-column names. Each row carries its own band values (a per-row envelope that moves with the data) — there is no scalar/fixed-band convention. Schemes: 'sd' (±SD: mean + plus_1sd/minus_1sd/plus_2sd/minus_2sd), 'minmaxmean' (range: mean + min/max), 'spc' (control: target + lower_control/upper_control/lower_limit/upper_limit). Provide only the keys for the chosen scheme; the center column (mean for sd/minmaxmean, target for spc) is required.",
				"properties": map[string]interface{}{
					"scheme":        map[string]interface{}{"type": "string", "enum": []string{"sd", "minmaxmean", "spc"}, "description": "Band scheme. Default 'sd'."},
					"mean":          map[string]interface{}{"type": "string", "description": "sd/minmaxmean center column (required for those schemes)."},
					"plus_1sd":      map[string]interface{}{"type": "string", "description": "sd: +1 SD bound."},
					"minus_1sd":     map[string]interface{}{"type": "string", "description": "sd: -1 SD bound."},
					"plus_2sd":      map[string]interface{}{"type": "string", "description": "sd: +2 SD bound."},
					"minus_2sd":     map[string]interface{}{"type": "string", "description": "sd: -2 SD bound."},
					"min":           map[string]interface{}{"type": "string", "description": "minmaxmean: lower bound."},
					"max":           map[string]interface{}{"type": "string", "description": "minmaxmean: upper bound."},
					"target":        map[string]interface{}{"type": "string", "description": "spc center column (required for spc)."},
					"lower_control": map[string]interface{}{"type": "string", "description": "spc: lower control limit."},
					"upper_control": map[string]interface{}{"type": "string", "description": "spc: upper control limit."},
					"lower_limit":   map[string]interface{}{"type": "string", "description": "spc: lower spec limit."},
					"upper_limit":   map[string]interface{}{"type": "string", "description": "spc: upper spec limit."},
				},
			},
		},
	}
}

// chartOptionsSchema delegates to the shared toolops definition so the
// Dashboard Assistant and the in-editor Component agent advertise the
// exact same `options.*` overlay (the keys the client chart specs
// actually read). The schema + apply both live in toolops.ChartOptions*
// — see internal/ai/toolops/chart_options.go.
func chartOptionsSchema() map[string]interface{} {
	return toolops.ChartOptionsSchema()
}

// dashboardPanelsSchema returns the inline JSON-schema for the
// DashboardPanel array. Inlining the {x, y, w, h} cell-unit
// convention here prevents the model from guessing pixel coords
// or forgetting which is width vs height.
//
// text_config is modeled as a real sub-object so the model knows
// section-header panels are a first-class shape, not an
// afterthought. Without an explicit schema the model rarely uses
// text panels even though dashboard layout discipline requires
// them — see chat-agent-layout-planning-todo.
func dashboardPanelsSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "array",
		"description": "Panels placed on the dashboard grid. Each panel occupies a rectangle of 32×32-px cells. Use a mix of component panels (set component_id) and text-header panels (set text_config, leave component_id unset) to give the dashboard visual hierarchy. Section-header text panels are typically full-width × 2-cells-tall and sit above each logical group of charts.\n\nPACK ROWS CONTIGUOUSLY — NO EMPTY GAPS. Each row of panels must start at the y where the previous row ended: a panel's y = the previous row's y + that row's h, with NO blank rows between. A section-header text panel abuts the charts below it (header at y, charts at y+header.h), and the next section header abuts the bottom of the row above it. Do not leave 1-2 empty cell rows between sections or rows — that produces dark dead strips. Panels in the same row share the same y and tile left-to-right (x advances by each panel's w). The whole layout should be a gap-free vertical stack of rows from y=0 down.",
		"items": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id":           map[string]interface{}{"type": "string", "description": "Stable panel id within the dashboard (e.g. \"panel-1\")."},
				"x":            map[string]interface{}{"type": "integer", "description": "Left edge in grid cells (0-indexed)."},
				"y":            map[string]interface{}{"type": "integer", "description": "Top edge in grid cells (0-indexed)."},
				"w":            map[string]interface{}{"type": "integer", "description": "Width in grid cells."},
				"h":            map[string]interface{}{"type": "integer", "description": "Height in grid cells."},
				"component_id": map[string]interface{}{"type": "string", "description": "ID of the component to render in this panel. Omit (and set text_config instead) for a text-only header panel."},
				// Panel fields that carry dashboard-variable behavior. Both are
				// REPLACE-semantics casualties if omitted: update_dashboard
				// rewrites the whole panel array, so a panel sent without these
				// loses them. Read the dashboard first and echo them back on
				// any panel you are not deliberately changing (#268).
				"connection_tags": map[string]interface{}{
					"type":        "array",
					"items":       map[string]interface{}{"type": "string"},
					"description": "Binds THIS panel to a different connection family when the dashboard's connection_swap variable is in tag_value mode. The panel resolves to the connection matching these tags plus the key tag (prefix:<selected value>). Empty/omitted = the panel follows the variable's primary family. Preserve existing values when editing other properties of a panel.",
				},
				"component_overrides": map[string]interface{}{
					"type":        "array",
					"description": "Per-panel component-swap rules: render a DIFFERENT component when the dashboard variable's value matches a predicate. Preserve existing values when editing other properties of a panel.",
					"items": map[string]interface{}{
						"type": "object",
						"properties": map[string]interface{}{
							"subject":      map[string]interface{}{"type": "string", "description": "What the predicate tests — see the ComponentOverride model for accepted values (e.g. the variable's effective value)."},
							"op":           map[string]interface{}{"type": "string", "description": "Comparison operator."},
							"value":        map[string]interface{}{"type": "string", "description": "Value compared against the subject."},
							"component_id": map[string]interface{}{"type": "string", "description": "Component rendered in this panel when the predicate matches."},
						},
						"required": []string{"subject", "op", "value", "component_id"},
					},
				},
				"text_config": map[string]interface{}{
					"type":        "object",
					"description": "Inline text panel for section headers / dividers / dashboard titles. Set this and leave component_id unset for a text-only panel. Always set display_content to \"title\" for static text (other values render live date/time).",
					"properties": map[string]interface{}{
						"content": map[string]interface{}{
							"type":        "string",
							"description": "Text to display (e.g. \"NODE — COMPUTE\"). Plain text; no markdown.",
						},
						"display_content": map[string]interface{}{
							"type":        "string",
							"description": "What to render. \"title\" shows the static `content` string (the only sensible option for a header panel). Other values (date_short, time_12, etc.) render live date/time and ignore `content`.",
						},
						"size": map[string]interface{}{
							"type":        "integer",
							"description": "Font size in pixels. Typical values: 14 (small), 20 (default body / section subheader), 28 (section header), 36 (dashboard title).",
						},
						"align": map[string]interface{}{
							"type":        "string",
							"description": "Text alignment within the panel.",
							"enum":        []string{"left", "center", "right"},
						},
					},
					"required": []string{"content", "display_content"},
				},
			},
			"required": []string{"id", "x", "y", "w", "h"},
		},
	}
}

// dashboardSettingsSchema returns the inline JSON-schema for
// DashboardSettings. layout_dimension is the most-asked field; the
// rest are sensible defaults.
func dashboardSettingsSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "object",
		"description": "Dashboard-level settings.",
		"properties": map[string]interface{}{
			"refresh_interval": map[string]interface{}{"type": "integer", "description": "Auto-refresh interval in SECONDS (e.g. 30 = refresh every 30s; 0 = disabled). NOT milliseconds."},
			"theme":            map[string]interface{}{"type": "string", "description": "\"light\", \"dark\", or \"auto\"."},
			"timezone":         map[string]interface{}{"type": "string", "description": "IANA timezone for x-axis timestamp display."},
			"layout_dimension": map[string]interface{}{
				"type":        "string",
				"description": "Canvas size preset name. Must exactly match one of the `name` values from `get_type_catalog`'s `layout_dimensions` array — preset names are deployment-specific (e.g. \"2560x1440-2K\", \"1920x1080-HD\"). Use the entry's `cols` × `rows` to plan panel coordinates. Empty = server default.",
			},
			"title_scale": map[string]interface{}{"type": "integer", "description": "Title font scale percent (50-200, default 100)."},
			"scale_percent": map[string]interface{}{
				"type":        "integer",
				"description": "Display scale % (50-200). Scales the whole dashboard's component text + line sizes up at render. LEAVE UNSET to inherit the chosen layout_dimension's default scale (the cols × rows in get_type_catalog are already at that default — plan to them directly). ONLY set this when the user explicitly asks for a different scale (e.g. \"build it at 150%\"); then the usable grid is SMALLER than the catalog's cols × rows by roughly (default_scale ÷ requested_scale), so reduce your panel budget accordingly.",
			},
			"panel_background": map[string]interface{}{
				"type":        "string",
				"description": "Per-dashboard override of the deployment's Transparent Panels appearance setting. \"solid\" forces the standard raised panel surface; \"transparent\" makes panels float on the dashboard canvas with no background, border, or title-band fill. LEAVE UNSET to inherit the deployment setting — that is the right choice for essentially every dashboard. ONLY set this when the user explicitly asks for it (e.g. \"make this one transparent\", \"keep this dashboard solid even though the rest are transparent\"); it is a look-and-feel preference, not something to infer from the dashboard's content or purpose.",
				"enum":        []string{"solid", "transparent"},
			},
			"is_public":    map[string]interface{}{"type": "boolean"},
			"allow_export": map[string]interface{}{"type": "boolean"},
			"variables_enabled": map[string]interface{}{
				"type":        "boolean",
				"description": "Per-dashboard on/off gate for dashboard variables (the header dropdown that re-scopes panels at view time). Set true whenever you define `variables`; when false the viewer ignores them entirely.",
			},
			"variables": dashboardVariablesSchema(),
		},
	}
}

// dashboardVariablesSchema describes settings.variables[] — the dashboard
// variable definitions that drive the header dropdowns. Three modes:
//
//   - connection_swap: dropdown lists tag-matched connections; selecting one
//     repoints every variable-driven panel's connection. No query tokens.
//   - filter: a value the user picks/types, substituted server-side into a
//     component query wherever the author wrote the `{{dashboard-variable}}`
//     token (bound as a SQL param / escaped EdgeLake literal). At most ONE
//     filter variable per dashboard (the token is a single fixed name).
//   - range: a [from, to] time window restricting time-series panels. SQL /
//     EdgeLake panels opt in by writing `<column> {{range-variable}}` after
//     the time column; ts-store / Prometheus panels pick the window up
//     automatically. At most ONE range variable per dashboard.
//
// To author a variable-driven component, write the matching token into the
// component's query_config.raw (filter: `... WHERE site = {{dashboard-variable}}`;
// range: `... WHERE ts {{range-variable}}`) when you create the component,
// then define the variable here and set variables_enabled=true.
func dashboardVariablesSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":        "array",
		"description": "Dashboard variable definitions. See the system prompt's \"Dashboard variables\" section for the authoring contract and query tokens.",
		"items": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"name": map[string]interface{}{
					"type":        "string",
					"description": "Stable key. Use the fixed token name: \"dashboard-variable\" for connection_swap/filter, \"dashboard-range\" for range.",
				},
				"label": map[string]interface{}{"type": "string", "description": "UI label shown next to the header dropdown, e.g. \"Site\" or \"Time range\"."},
				"mode": map[string]interface{}{
					"type":        "string",
					"enum":        []string{"connection_swap", "filter", "range"},
					"description": "What the variable drives. connection_swap repoints panel connections; filter substitutes a value into queries via {{dashboard-variable}}; range applies a time window via {{range-variable}}.",
				},
				"connection_swap": map[string]interface{}{
					"type":        "object",
					"description": "Required when mode=connection_swap.",
					"properties": map[string]interface{}{
						"tags":             map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "OR-matched discovery tags; the dropdown lists connections carrying any of these."},
						"schema_strict":    map[string]interface{}{"type": "string", "enum": []string{"type_only", "superset", "exact"}, "description": "How strictly a candidate connection's schema must match the reference. Default type_only."},
						"same_namespace":   map[string]interface{}{"type": "boolean", "description": "Restrict candidates to the dashboard's namespace. Default false."},
						"label_tag_prefix": map[string]interface{}{"type": "string", "description": "Derive each dropdown label from a prefixed connection tag, e.g. \"host\" → label is the value of the connection's \"host:\" tag."},
					},
				},
				// NOTE: the model field is `filter_value` (DashboardVariable.FilterValue).
				// This key MUST match the json tag or the whole filter config is
				// silently dropped on unmarshal and the variable falls back to
				// static "from list" (issue #71).
				"filter_value": map[string]interface{}{
					"type":        "object",
					"description": "Required when mode=filter. Components opt in by writing the {{dashboard-variable}} token into query_config.raw. PREFER value_source=connection (live distinct-value discovery from the data) over static unless the user asked for a fixed list.",
					"properties": map[string]interface{}{
						"value_source":  map[string]interface{}{"type": "string", "enum": []string{"static", "freetext", "connection"}, "description": "connection = options discovered LIVE from value_column of value_table (preferred — stays in sync with the data); static = pick from a fixed options list; freetext = type a value. Default static, but use connection when the values come from the dataset."},
						"options":       map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Selectable values for value_source=static; fallback list for connection."},
						"default_value": map[string]interface{}{"type": "string"},
						"value_column":  map[string]interface{}{"type": "string", "description": "For value_source=connection: column whose distinct values populate the picker."},
						"value_table":   map[string]interface{}{"type": "string", "description": "For value_source=connection: source table for distinct-value discovery."},
					},
				},
				"range": map[string]interface{}{
					"type":        "object",
					"description": "Required when mode=range. Components opt in by writing `<column> {{range-variable}}` (SQL/EdgeLake); ts-store/Prometheus panels apply it automatically.",
					"properties": map[string]interface{}{
						"presets":        map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Relative-window tokens in the dropdown: \"1h\", \"6h\", \"24h\", \"7d\", \"30d\". Empty = a sensible default set."},
						"default_preset": map[string]interface{}{"type": "string", "description": "Preset applied on first load, e.g. \"24h\"."},
						"allow_absolute": map[string]interface{}{"type": "boolean", "description": "Offer the absolute from/to picker. Default true."},
					},
				},
			},
			"required": []string{"name", "label", "mode"},
		},
	}
}

// ─── Handler wrappers ─────────────────────────────────────────────
// Each wrapper unmarshals model-supplied args into the toolops Input
// type, invokes the operation, and marshals the result back to JSON
// for the model. Capability gating and namespace injection happen
// here once they're wired through DispatchEnv (step 3.5+).

func wrapGetCurrentUser(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.GetCurrentUser(ctx, toolops.GetCurrentUserInput{
			CallerGUID: callerGUIDFromEnv(env),
		})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListNamespaces(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.ListNamespaces(ctx)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListConnections(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListConnectionsInput
		if len(args) > 0 {
			if err := json.Unmarshal(args, &in); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
		}
		out, err := ops.ListConnections(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetConnection(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetConnectionInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetConnection(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetConnectionSchema(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetConnectionSchemaInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetConnectionSchema(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListEdgeLakeDatabases(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListEdgeLakeDatabasesInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.ListEdgeLakeDatabases(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListEdgeLakeTables(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListEdgeLakeTablesInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.ListEdgeLakeTables(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetEdgeLakeTableSchema(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetEdgeLakeTableSchemaInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetEdgeLakeTableSchema(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetConnectionTypeGuidance(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetConnectionTypeGuidanceInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetConnectionTypeGuidance(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapQueryConnection(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.QueryConnectionInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.QueryConnection(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapAnalyzeDataset(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.AnalyzeDatasetInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.AnalyzeDataset(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListComponents(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListComponentsInput
		if len(args) > 0 {
			// ListComponentsInput carries JSON tags, so the model-facing
			// snake_case args unmarshal directly — no hand-rolled raw struct
			// that silently drops fields when the input grows (#21/#54).
			if err := json.Unmarshal(args, &in); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
		}
		out, err := ops.ListComponents(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapCreateConnection(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		// Unmarshal into the model's CreateConnectionRequest directly —
		// the JSON shape matches the API contract.
		var req models.CreateConnectionRequest
		if err := json.Unmarshal(args, &req); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		// Apply caller's active namespace when the model didn't pick one
		// explicitly — same behavior as the API handler.
		if req.Namespace == "" && env != nil && env.Caller != nil {
			req.Namespace = env.Caller.Namespace
		}
		out, err := ops.CreateConnection(ctx, toolops.CreateConnectionInput{Request: req})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetComponent(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetComponentInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetComponent(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapCreateComponent(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		args = coerceStringifiedJSONFields(args)
		// Fail loud on the text-panel mistake: agents have tried to make
		// section headers by passing text_config to create_component (it has
		// no such field, so it was silently dropped → a blank display shell,
		// and the agent never knew). Text panels are NOT components — they're
		// a panel-level text_config in create_dashboard. Redirect explicitly.
		var probe map[string]json.RawMessage
		if json.Unmarshal(args, &probe) == nil {
			if _, hasText := probe["text_config"]; hasText {
				return "", fmt.Errorf("text_config is not a component field — do NOT create a component for a section header or text label. Text/header panels are created inline on the dashboard: in create_dashboard (or update_dashboard), add a panel with `text_config` set and `component_id` left unset. Remove this create_component call and put the header text directly on the panel")
			}
		}
		var req models.CreateComponentRequest
		if err := json.Unmarshal(args, &req); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if req.Namespace == "" && env != nil && env.Caller != nil {
			req.Namespace = env.Caller.Namespace
		}
		out, err := ops.CreateComponent(ctx, toolops.CreateComponentInput{Request: req})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapDeleteComponent(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.DeleteComponentInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if err := ops.DeleteComponent(ctx, in); err != nil {
			return "", err
		}
		return jsonResult(map[string]interface{}{"deleted": true, "id": in.ID})
	}
}

func wrapDeleteDashboard(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.DeleteDashboardInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if err := ops.DeleteDashboard(ctx, in); err != nil {
			return "", err
		}
		return jsonResult(map[string]interface{}{"deleted": true, "id": in.ID})
	}
}

func wrapUpdateComponent(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		// id rides alongside the patch fields in the tool args; pull it
		// out, then unmarshal the rest as the partial-update request.
		var idHolder struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(args, &idHolder); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if idHolder.ID == "" {
			return "", fmt.Errorf("id is required")
		}
		args = coerceStringifiedJSONFields(args)
		var req models.UpdateComponentRequest
		if err := json.Unmarshal(args, &req); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.UpdateComponent(ctx, toolops.UpdateComponentInput{ID: idHolder.ID, Request: req})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetDashboard(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetDashboardInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetDashboard(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapCreateDashboard(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		args = coerceStringifiedJSONFields(args)
		var req models.CreateDashboardRequest
		if err := json.Unmarshal(args, &req); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if req.Namespace == "" && env != nil && env.Caller != nil {
			req.Namespace = env.Caller.Namespace
		}
		out, err := ops.CreateDashboard(ctx, toolops.CreateDashboardInput{Request: req})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapUpdateDashboard(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		// id is a top-level arg; the rest map onto the pointer-field
		// UpdateDashboardRequest so omitted keys stay nil (untouched).
		args = coerceStringifiedJSONFields(args)
		var envelope struct {
			ID string `json:"id"`
			models.UpdateDashboardRequest
		}
		if err := json.Unmarshal(args, &envelope); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if envelope.ID == "" {
			return "", fmt.Errorf("id is required")
		}
		out, err := ops.UpdateDashboard(ctx, toolops.UpdateDashboardInput{
			ID:      envelope.ID,
			Request: envelope.UpdateDashboardRequest,
		})
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListDashboards(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListDashboardsInput
		if len(args) > 0 {
			if err := json.Unmarshal(args, &in); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
		}
		out, err := ops.ListDashboards(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapDescribeTool(reg *ToolRegistry) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in struct {
			Names []string `json:"names"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if len(in.Names) == 0 {
			return "", fmt.Errorf("names must include at least one tool name")
		}

		// Build the per-tool response: { <name>: { description, schema } }
		// for every requested name. Unknown names are reported with
		// an error in the same map so the model sees the full picture.
		out := make(map[string]interface{}, len(in.Names))
		for _, name := range in.Names {
			tool := reg.findTool(name)
			if tool == nil {
				out[name] = map[string]interface{}{
					"error": "unknown tool",
				}
				continue
			}
			if tool.Tier != TierB {
				// Calling describe_tool on a Tier-A tool isn't an
				// error — the model just doesn't need to. Echo the
				// schema anyway in case it's useful.
				out[name] = map[string]interface{}{
					"description": tool.Description,
					"schema":      tool.InputSchema,
					"tier":        "A",
					"note":        "Tier-A tools are already loaded — you don't need to describe_tool them.",
				}
				continue
			}
			out[name] = map[string]interface{}{
				"description": tool.Description,
				"schema":      tool.InputSchema,
				"tier":        "B",
			}
			// Signal the agent: load this tool's schema in
			// subsequent turns.
			if env != nil && env.RevealTierB != nil {
				env.RevealTierB(name)
			}
		}
		return jsonResult(out)
	}
}

func wrapGetFullResult() ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in struct {
			ResultID string `json:"result_id"`
			Filter   string `json:"filter"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if env == nil || env.ResultStore == nil {
			return "", fmt.Errorf("result store not wired — get_full_result cannot run")
		}
		full, err := env.ResultStore.FetchFull(ctx, in.ResultID)
		if err != nil {
			return "", err
		}
		// No filter → verbatim (issue #43). Note: this verbatim return can be
		// large; that's the caller explicitly asking for the whole thing.
		if strings.TrimSpace(in.Filter) == "" {
			return full, nil
		}
		filtered, ferr := FilterResult(full, in.Filter)
		if ferr != nil {
			return "", ferr
		}
		// If the FILTERED slice is still over the inline threshold, re-store it
		// and hand back a summary + new result_id instead of dumping it into
		// context (issue #67 — a 779KB filtered result blew the conversation).
		// Summarize is a no-op (returns as-is) when the slice is already small.
		sessionID := ""
		if env.Session != nil {
			sessionID = env.Session.ID
		}
		return env.ResultStore.Summarize(ctx, sessionID, "get_full_result", filtered)
	}
}

func wrapGetCatalog(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.GetCatalog(ctx)
		if err != nil {
			return "", err
		}
		// Return the compact markdown rendering, not the raw catalog
		// JSON. The agent reads the catalog wholesale when planning a
		// build — it's a reference doc, not a "find X by name" list — so
		// summarizing the JSON (it trips the 8KB result-store threshold
		// at ~32KB) was pure waste: the summary couldn't answer the
		// question, so the agent always followed up with get_full_result
		// and re-inlined the same 32KB. RenderMarkdown drops the verbose
		// per-field JSON schemas in favor of compact field-name lists +
		// includes the layout_dimensions cols/rows the build flow needs,
		// landing well under the threshold so it inlines in one shot.
		if out == nil || out.Catalog == nil {
			return jsonResult(out)
		}
		return out.Catalog.RenderMarkdown(), nil
	}
}

// callerGUIDFromEnv pulls the auth GUID off the DispatchEnv. Pulls
// from env.Caller, which the agent populates from the per-message
// CallerCtx. Returns "" when the caller is unresolved (anonymous
// test invocations); toolops.GetCurrentUser surfaces a clean error
// in that case.
func callerGUIDFromEnv(env *DispatchEnv) string {
	if env == nil || env.Caller == nil || env.Caller.User == nil {
		return ""
	}
	return env.Caller.User.GUID
}

// jsonResult marshals any value to a JSON string for handing back to
// the model.
func jsonResult(v interface{}) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal result: %w", err)
	}
	return string(b), nil
}

// coerceStringifiedJSONFields repairs the same client failure mode the MCP
// handler guards against (issue #78), but on the Dashboard Assistant tool
// path: the model sometimes encodes an object/array argument as a JSON
// *string* (e.g. data_mapping arrives as "{\"x_axis\":\"ts\"}"). Here the
// typed fields (data_mapping / query_config / options / settings / panels)
// unmarshal into Go structs, so a string value makes the WHOLE
// json.Unmarshal fail ("cannot unmarshal string into struct field") and the
// create/update is rejected — exactly the "server won't accept strings for
// typed structs" blocker. Decode args to a map, replace any top-level value
// that is a string parsing cleanly as a JSON object or array with the parsed
// value, then re-marshal. Plain-string params (name, chart_type, raw SQL,
// component_code) are untouched: only strings whose first non-space rune is
// '{' or '[' AND that parse are converted, so a SQL string with braces is
// never mangled. On any decode hiccup the original args are returned
// unchanged (the downstream Unmarshal then surfaces the real error).
func coerceStringifiedJSONFields(args json.RawMessage) json.RawMessage {
	var m map[string]json.RawMessage
	if err := json.Unmarshal(args, &m); err != nil {
		return args // not an object — leave as-is
	}
	changed := false
	for k, v := range m {
		var s string
		if err := json.Unmarshal(v, &s); err != nil {
			continue // value isn't a JSON string
		}
		t := strings.TrimSpace(s)
		if t == "" || (t[0] != '{' && t[0] != '[') {
			continue
		}
		var probe interface{}
		if err := json.Unmarshal([]byte(t), &probe); err != nil {
			continue // string isn't valid JSON — leave it
		}
		switch probe.(type) {
		case map[string]interface{}, []interface{}:
			m[k] = json.RawMessage(t)
			changed = true
		}
	}
	if !changed {
		return args
	}
	out, err := json.Marshal(m)
	if err != nil {
		return args
	}
	return out
}
