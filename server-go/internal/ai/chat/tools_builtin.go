// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"

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
		Description: "List all configured connections (SQL, API, MQTT, EdgeLake, etc). Returns name, type, and ID for each.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListConnections(ops),
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

	// Write surface for connections — Tier-B because the type-specific
	// config shape is detailed and only relevant when the model is
	// actually creating a connection. The model will load this via
	// describe_tool after consulting get_type_catalog for the
	// connection types it can use.
	reg.Register(Tool{
		Name: "create_connection",
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
		Description: "List components (charts/controls/displays). Optionally filter by chart_type, connection_id, or tag.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"chart_type":    map[string]interface{}{"type": "string", "description": "Filter by chart subtype (bar, line, etc)"},
				"connection_id": map[string]interface{}{"type": "string", "description": "Filter by connection ID"},
				"tag":           map[string]interface{}{"type": "string", "description": "Filter by tag"},
			},
		},
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
		Name: "create_component",
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
		Name: "update_component",
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

	// ─── Dashboards ───
	reg.Register(Tool{
		Name:        "list_dashboards",
		Description: "List all dashboards in the deployment.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListDashboards(ops),
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
		Name: "create_dashboard",
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
		Description: "Retrieve the verbatim content of a previously-stored large tool result by its result_id. Only call this when the inline summary doesn't have what you need — fetching the full payload can consume significant context. result_id looks like `r_abc12345` and is returned in the summary of any large tool call.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"result_id": map[string]interface{}{
					"type":        "string",
					"description": "The result ID returned in the summary of a large tool call (e.g. r_abc12345).",
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
				"description": "Optional query parameters (named bind vars for sql, query-string params for api, etc).",
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
			"multiple_y_axis": map[string]interface{}{"type": "boolean", "description": "Dual Y-axis mode. Off (default): all y columns share one axis (N columns allowed). On: the first two y columns split across left/right axes; pair with options.yAxisRange.right."},
			"y_axis_label":   map[string]interface{}{"type": "string", "description": "Display label for the Y axis (legacy single label; use y_axis_labels for dual-axis)."},
			"y_axis_labels":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Per-column Y-axis labels. [0] = left axis, [1] = right axis on dual-axis charts."},
			"series":         map[string]interface{}{"type": "string", "description": "Column that distinguishes series (e.g. \"location\" splits one column into per-location lines)."},
			"group_by":       map[string]interface{}{"type": "string", "description": "Client-side grouping column."},
			"label_col":      map[string]interface{}{"type": "string", "description": "Column used for pie/bar slice labels."},
			"filters":        map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "object"}, "description": "Client-side filters: [{field, op, value}]. ops: eq, neq, gt, gte, lt, lte, contains, in, notIn, isNull, isNotNull."},
			"aggregation":    map[string]interface{}{"type": "object", "description": "Optional aggregation: {type: first|last|min|max|avg|sum|count|limit, sort_by, field, count}."},
			"sliding_window": map[string]interface{}{"type": "object", "description": "{duration: seconds, timestamp_col: \"ts\"} — keep only the last N seconds of data."},
			"time_bucket":    map[string]interface{}{"type": "object", "description": "{interval: seconds, function: avg|min|max|sum|count, value_cols: [\"temp\",\"humidity\"], timestamp_col: \"ts\"} — aggregate streaming rows into time buckets."},
			"sort_by":        map[string]interface{}{"type": "string"},
			"sort_order":     map[string]interface{}{"type": "string", "enum": []string{"asc", "desc"}},
			"limit":          map[string]interface{}{"type": "integer", "description": "Max rows the chart should render."},
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
				"title":        map[string]interface{}{"type": "string", "description": "Optional panel-level title override (falls back to the component's title or name)."},
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
			"refresh_interval": map[string]interface{}{"type": "integer", "description": "Auto-refresh interval in ms (e.g. 5000 = 5s)."},
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
			"is_public":   map[string]interface{}{"type": "boolean"},
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
				"filter": map[string]interface{}{
					"type":        "object",
					"description": "Required when mode=filter. Components opt in by writing the {{dashboard-variable}} token into query_config.raw.",
					"properties": map[string]interface{}{
						"value_source":  map[string]interface{}{"type": "string", "enum": []string{"static", "freetext", "connection"}, "description": "static = pick from options; freetext = type a value; connection = options discovered live from the bound column. Default static."},
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
		out, err := ops.ListConnections(ctx)
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

func wrapListComponents(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListComponentsInput
		if len(args) > 0 {
			// Decode the model-facing shape (snake_case) into the
			// strongly-typed input. JSON tags would be cleaner but the
			// surface is small enough to do manually.
			var raw struct {
				ChartType    string `json:"chart_type"`
				ConnectionID string `json:"connection_id"`
				Tag          string `json:"tag"`
			}
			if err := json.Unmarshal(args, &raw); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
			in.ChartType = raw.ChartType
			in.ConnectionID = raw.ConnectionID
			in.Tag = raw.Tag
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
		out, err := ops.ListDashboards(ctx)
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
		return full, nil
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
