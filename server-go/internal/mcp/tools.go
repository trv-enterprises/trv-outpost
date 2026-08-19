// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/trv-enterprises/trve-dashboard/internal/ai/toolops"
	"github.com/trv-enterprises/trve-dashboard/internal/componenttemplates"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// ToolRegistry manages MCP tool definitions and their handlers. The
// registry is built once at server startup and reads its type metadata
// from the unified registry package — there are no hardcoded enums in
// this file. Adding a new connection type, chart type, or control type
// only requires touching the registry package; the MCP tools update
// automatically.
type ToolRegistry struct {
	tools    map[string]Tool
	handlers map[string]ToolHandler

	connectionService *service.ConnectionService
	dashboardService  *service.DashboardService
	componentService  *service.ComponentService
	deviceTypeService *service.DeviceTypeService
	settingsService   *service.SettingsService
	typeFilter        registry.TypeFilter

	// toolops is the shared lower-level tool-implementation layer.
	// As of v0.20.0 we're migrating individual tools to shim through
	// it; the registry holds the rest of the service refs for
	// not-yet-migrated handlers. May be nil during early bootstrap
	// or in tests — every shim must nil-check.
	toolops *toolops.Toolset
}

// NewToolRegistry wires services into a fresh tool registry and registers
// every tool the MCP server exposes. typeFilter may be nil (no filtering).
// ops may be nil — handlers that have been migrated to the shared
// toolops layer fall back to legacy direct-service calls when ops is
// nil, so partial wiring during bootstrap doesn't break MCP.
func NewToolRegistry(
	connectionSvc *service.ConnectionService,
	dashboardSvc *service.DashboardService,
	chartSvc *service.ComponentService,
	deviceTypeSvc *service.DeviceTypeService,
	settingsSvc *service.SettingsService,
	typeFilter registry.TypeFilter,
	ops *toolops.Toolset,
) *ToolRegistry {
	r := &ToolRegistry{
		tools:             make(map[string]Tool),
		handlers:          make(map[string]ToolHandler),
		connectionService: connectionSvc,
		dashboardService:  dashboardSvc,
		componentService:  chartSvc,
		deviceTypeService: deviceTypeSvc,
		settingsService:   settingsSvc,
		typeFilter:        typeFilter,
		toolops:           ops,
	}

	r.registerCatalogTools()
	r.registerConnectionTools()
	r.registerDiscoveryTools()
	r.registerComponentTools()
	r.registerDashboardTools()
	r.registerGuidanceTools()

	return r
}

// GetTools returns all registered tools.
func (r *ToolRegistry) GetTools() []Tool {
	tools := make([]Tool, 0, len(r.tools))
	for _, tool := range r.tools {
		tools = append(tools, tool)
	}
	return tools
}

// CallTool executes a tool by name.
// CallTool executes a tool by name. ctx MUST be the caller's request
// context: it carries their namespace grants (#4), and the service
// layer enforces those grants off it.
func (r *ToolRegistry) CallTool(ctx context.Context, name string, args map[string]interface{}) (interface{}, error) {
	handler, ok := r.handlers[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
	return handler(ctx, args)
}

func (r *ToolRegistry) registerTool(tool Tool, handler ToolHandler) {
	if tool.Annotations == nil {
		tool.Annotations = annotationsForTool(tool.Name)
	}
	r.tools[tool.Name] = tool
	r.handlers[tool.Name] = handler
}

func boolPtr(b bool) *bool { return &b }

// externalReadTools are read-only tools that reach a configured connection or
// broker rather than only this server's own catalog/records. They get
// openWorldHint=true so a host knows the call touches an external system.
var externalReadTools = map[string]bool{
	"query_connection":             true,
	"analyze_dataset":              true,
	"test_connection":              true,
	"sample_mqtt_topic":            true,
	"list_mqtt_topics":             true,
	"list_edgelake_databases":      true,
	"list_edgelake_tables":         true,
	"get_edgelake_table_schema":    true,
	"get_connection_schema":        true,
	"list_prometheus_label_values": true,
}

// annotationsForTool derives MCP behavior hints from a tool's name. The MCP
// surface follows a strict `verb_noun` convention (get_/list_/create_/update_/
// delete_), so the verb prefix is a reliable classifier — and deriving the
// hints here (rather than on each Tool literal) means every current and future
// tool is annotated consistently with no per-tool boilerplate to forget.
//
// The crucial case for issue #111 is update_*: those are non-destructive,
// idempotent mutations. Advertising idempotentHint=true + destructiveHint=false
// lets a host's auto-approval logic treat an `update_component` rename as the
// safe operation it is, instead of falling back to a value heuristic that
// mis-flagged the rename to the short word "Disk".
func annotationsForTool(name string) *ToolAnnotations {
	switch {
	case strings.HasPrefix(name, "get_"), strings.HasPrefix(name, "list_"),
		name == "query_connection", name == "test_connection", name == "sample_mqtt_topic",
		name == "analyze_dataset":
		a := &ToolAnnotations{ReadOnlyHint: boolPtr(true)}
		if externalReadTools[name] {
			a.OpenWorldHint = boolPtr(true)
		}
		return a
	case strings.HasPrefix(name, "create_"):
		// Additive: not read-only, not destructive, and not idempotent
		// (each call makes a new record).
		return &ToolAnnotations{
			ReadOnlyHint:    boolPtr(false),
			DestructiveHint: boolPtr(false),
			IdempotentHint:  boolPtr(false),
		}
	case strings.HasPrefix(name, "update_"):
		// Overwrites provided fields on an existing record: a mutation, but
		// not data-destroying, and idempotent for a fixed argument set.
		return &ToolAnnotations{
			ReadOnlyHint:    boolPtr(false),
			DestructiveHint: boolPtr(false),
			IdempotentHint:  boolPtr(true),
		}
	case strings.HasPrefix(name, "delete_"):
		return &ToolAnnotations{
			ReadOnlyHint:    boolPtr(false),
			DestructiveHint: boolPtr(true),
			IdempotentHint:  boolPtr(true),
		}
	default:
		return nil
	}
}

// deviceTypeLister adapts the device type service for the catalog builder.
type deviceTypeListerAdapter struct {
	svc *service.DeviceTypeService
}

func (a *deviceTypeListerAdapter) ListDeviceTypesForCatalog(ctx context.Context) ([]registry.DeviceTypeSummary, error) {
	if a.svc == nil {
		return nil, nil
	}
	resp, err := a.svc.ListDeviceTypes(ctx, &models.DeviceTypeQueryParams{Page: 1, PageSize: 500})
	if err != nil {
		return nil, err
	}
	out := make([]registry.DeviceTypeSummary, 0, len(resp.DeviceTypes))
	for _, dt := range resp.DeviceTypes {
		out = append(out, registry.DeviceTypeSummary{
			ID:             dt.ID,
			Name:           dt.Name,
			Description:    dt.Description,
			Category:       dt.Category,
			Protocol:       dt.Protocol,
			SupportedTypes: dt.SupportedTypes,
			IsBuiltIn:      dt.IsBuiltIn,
		})
	}
	return out, nil
}

func (r *ToolRegistry) deviceTypeLister() registry.DeviceTypeLister {
	if r.deviceTypeService == nil {
		return nil
	}
	return &deviceTypeListerAdapter{svc: r.deviceTypeService}
}

// ============================================================================
// Catalog tools — start here. The first thing an external agent should call
// is `get_type_catalog` to discover what kinds of connections, charts,
// controls, displays, and device types this server supports.
// ============================================================================

func (r *ToolRegistry) registerCatalogTools() {
	r.registerTool(
		Tool{
			Name:        "get_type_catalog",
			Description: "Returns the unified catalog of every type the dashboard knows about: connection types (with required config fields), chart subtypes (bar/line/pie/etc with their data requirements), control subtypes (button/toggle/slider/etc with capabilities), display subtypes, and user-defined device types. Call this first when planning to build a dashboard so you understand what's available.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return registry.BuildCatalog(ctx, r.deviceTypeLister(), r.typeFilter)
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_integrations",
			Description: "List integrations available on this server. Integrations group related connection / chart / control / display types so they can be enabled or disabled as a bundle from the admin settings. Disabled integrations and any types tagged with them are omitted from the type catalog.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			items := registry.ListIntegrations()
			if r.typeFilter != nil {
				filtered := items[:0]
				for _, info := range items {
					if r.typeFilter.IsIntegrationEnabled(info.ID) {
						filtered = append(filtered, info)
					}
				}
				items = filtered
			}
			return map[string]interface{}{"integrations": items, "count": len(items)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_connection_types",
			Description: "List the connection (datasource) types this server supports. Each entry includes the type ID, capabilities (read/write/stream), and required configuration fields. Use this before calling create_connection.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"types": r.filterConnectionTypes(registry.List())}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_chart_types",
			Description: "List supported chart subtypes (bar, line, pie, scatter, gauge, dataview, custom, etc) with their data requirements (does it need x_axis, multiple y_axis values, etc). Use this before calling create_component with component_type=chart.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"types": r.filterComponentTypes(registry.ListComponentTypes(registry.CategoryChart), registry.CategoryChart)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_control_types",
			Description: "List supported control subtypes (button, toggle, slider, switch, dimmer, garage_door, tile_*, etc) with their capabilities. Writable controls require a device_type_id when bound to a connection — see list_device_types.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"types": r.filterComponentTypes(registry.ListComponentTypes(registry.CategoryControl), registry.CategoryControl)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_display_types",
			Description: "List supported display subtypes (frigate_camera, frigate_alerts, weather, etc). Displays are non-chart visual components bundled with the frontend.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return map[string]interface{}{"types": r.filterComponentTypes(registry.ListComponentTypes(registry.CategoryDisplay), registry.CategoryDisplay)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_device_types",
			Description: "List user-defined device types from MongoDB. Each device type carries a command schema and a list of supported control subtypes — required when creating a writable control bound to a connection.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			if r.deviceTypeService == nil {
				return map[string]interface{}{"device_types": []interface{}{}, "count": 0}, nil
			}
			resp, err := r.deviceTypeService.ListDeviceTypes(ctx, &models.DeviceTypeQueryParams{Page: 1, PageSize: 500})
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{
				"device_types": resp.DeviceTypes,
				"count":        resp.Total,
			}, nil
		},
	)
}

// ============================================================================
// Connection tools — CRUD over the datasources collection. We use
// "connection" terminology in tool names and descriptions even though the
// underlying model and collection are still called datasource.
// ============================================================================

func (r *ToolRegistry) registerConnectionTools() {
	r.registerTool(
		Tool{
			Name:        "list_connections",
			Description: "List configured connections (datasources), filtered/sorted/paginated server-side. By default returns ALL matching connections (up to a 1000 cap). Returns name, type, health status, and ID for each (secrets masked). count (total) + has_more indicate truncation.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: withListProps(map[string]PropertySchema{
					"namespace": {Type: "string", Description: "Filter by namespace"},
					"name":      {Type: "string", Description: "Filter by name (case-insensitive substring)"},
					"type":      {Type: "string", Description: "Filter by connection type"},
					"tags":      {Type: "array", Description: "Filter by tags (OR semantics)"},
				}, "name, created_at, updated_at, type, namespace"),
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			in := toolops.ListConnectionsInput{
				Namespace: getString(args, "namespace"),
				Name:      getString(args, "name"),
				Type:      getString(args, "type"),
				Tags:      getStringSlice(args, "tags"),
				Sort:      getString(args, "sort"),
				Direction: getString(args, "direction"),
				Page:      getInt(args, "page"),
				PageSize:  getInt(args, "page_size"),
			}
			// Shim through the shared toolops layer when available so MCP
			// and the Dashboard Assistant share one truth (incl. secret
			// masking). Fall back to direct service calls only when toolops
			// isn't wired (early bootstrap, tests).
			if r.toolops != nil {
				return r.toolops.ListConnections(ctx, in)
			}
			resp, err := r.connectionService.ListConnectionsPaged(ctx, models.ConnectionQueryParams{
				Namespace: in.Namespace, Name: in.Name, Type: in.Type, Tags: in.Tags,
				Sort: in.Sort, Direction: in.Direction, Page: in.Page, PageSize: in.PageSize,
			})
			if err != nil {
				return nil, err
			}
			// Sanitize secrets before they reach the agent. Never hand a
			// live api_key / password to a model or into an exportable
			// transcript.
			masked := make([]*models.Connection, len(resp.Connections))
			for i, c := range resp.Connections {
				masked[i] = c.SanitizeForAPI()
			}
			return map[string]interface{}{
				"connections": masked,
				"count":       resp.Total,
				"page":        resp.Page,
				"page_size":   resp.PageSize,
				"has_more":    resp.HasMore,
			}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "get_connection",
			Description: "Get the full configuration for a single connection by ID.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Connection ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id, ok := args["id"].(string)
			if !ok {
				return nil, fmt.Errorf("id must be a string")
			}
			if r.toolops != nil {
				return r.toolops.GetConnection(ctx, toolops.GetConnectionInput{ID: id})
			}
			conn, err := r.connectionService.GetConnection(ctx, id)
			if err != nil {
				return nil, err
			}
			if conn == nil {
				return nil, nil
			}
			// Sanitize secrets before returning to the agent.
			return conn.SanitizeForAPI(), nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "create_connection",
			Description: "Create a new connection. Call list_connection_types first to see what `type` values are supported and what fields each requires in `config`. The `config` object must contain a sub-object matching the type (e.g. `config.mqtt`, `config.sql`, `config.api`).",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"name":        {Type: "string", Description: "Connection name (must be unique within the target namespace)"},
					"type":        {Type: "string", Description: "Connection type — call list_connection_types for valid values"},
					"description": {Type: "string", Description: "Optional human-readable description"},
					"namespace":   {Type: "string", Description: "Target namespace. Must equal the runtime context's target namespace; omit to default to \"default\"."},
					"config":      {Type: "object", Description: "Type-specific configuration. Shape depends on `type`."},
					"tags":        {Type: "array", Description: "Optional tags for organization"},
				},
				Required: []string{"name", "type", "config"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			req := &models.CreateConnectionRequest{
				Name:        getString(args, "name"),
				Description: getString(args, "description"),
				Namespace:   getString(args, "namespace"),
				Type:        models.ConnectionType(getString(args, "type")),
			}
			if cfg, ok := args["config"].(map[string]interface{}); ok {
				req.Config = parseConnectionConfig(req.Type, cfg)
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			return r.connectionService.CreateConnection(ctx, req)
		},
	)

	r.registerTool(
		Tool{
			Name:        "update_connection",
			Description: "Update an existing connection. Provide only the fields you want to change. To change connection settings, pass `type` (the current connection type) plus a `config` object in the same shape create_connection accepts — it fully replaces the type-specific config.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id":          {Type: "string", Description: "Connection ID"},
					"name":        {Type: "string", Description: "New name (optional)"},
					"description": {Type: "string", Description: "New description (optional)"},
					"type":        {Type: "string", Description: "Connection type — REQUIRED when passing `config`, so the config can be parsed for the right adapter."},
					"config":      {Type: "object", Description: "Type-specific configuration (same shape as create_connection). Replaces the existing config. Requires `type`."},
					"tags":        {Type: "array", Description: "Replace the connection's tags (optional)"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateConnectionRequest{
				Name:        getString(args, "name"),
				Description: getString(args, "description"),
			}
			// Config edits require the type so we can parse into the right
			// adapter shape. Without type we can't know which sub-object to fill.
			if cfg, ok := args["config"].(map[string]interface{}); ok {
				connType := models.ConnectionType(getString(args, "type"))
				if connType == "" {
					return nil, fmt.Errorf("update_connection: `type` is required when passing `config`")
				}
				req.Config = parseConnectionConfig(connType, cfg)
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			return r.connectionService.UpdateConnection(ctx, id, req)
		},
	)

	r.registerTool(
		Tool{
			Name:        "delete_connection",
			Description: "Delete a connection by ID. Components referencing it will lose their data binding — consider listing dashboards/charts that depend on it first.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Connection ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if _, err := r.connectionService.DeleteConnection(ctx, id); err != nil {
				return nil, err
			}
			return map[string]interface{}{"success": true, "message": fmt.Sprintf("Connection %s deleted", id)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "test_connection",
			Description: "Health-check an existing connection. Returns whether the connection is reachable and any error details.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Connection ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return r.connectionService.CheckHealth(ctx, getString(args, "id"))
		},
	)

	r.registerTool(
		Tool{
			Name:        "query_connection",
			Description: "Execute an ad-hoc query against a connection. The `query` object takes `raw` (the query string), `type` (sql / api / csv_filter / stream_filter), and optional `params`. Returns columns and rows. Pass `limit` to cap how many rows come back — useful when you just want to verify the result shape (column names + types) before committing to a chart_type. `limit: 1` is the common probe pattern.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "Connection ID to query"},
					"query":         {Type: "object", Description: "Query object with `raw`, `type`, and optional `params`"},
					"limit":         {Type: "integer", Description: "Optional cap on the number of rows returned. The query still executes against the data source; this trims the rows before serializing back to you. Use a small number (1-5) for shape probes, omit for full results."},
				},
				Required: []string{"connection_id", "query"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "connection_id")
			queryMap, _ := args["query"].(map[string]interface{})
			limit := getInt(args, "limit")
			if r.toolops != nil {
				return r.toolops.QueryConnection(ctx, toolops.QueryConnectionInput{
					ConnectionID: id,
					Raw:          getString(queryMap, "raw"),
					Type:         getString(queryMap, "type"),
					Params:       getMap(queryMap, "params"),
					Limit:        limit,
				})
			}
			req := &models.QueryRequest{
				Query: models.Query{
					Raw:    getString(queryMap, "raw"),
					Type:   models.QueryType(getString(queryMap, "type")),
					Params: getMap(queryMap, "params"),
				},
			}
			// Trusted internal call (#23): the /mcp surface is gated to
			// design at its route, so raw queries here are authored by a
			// design-capable principal. The verb guard still applies.
			resp, err := r.connectionService.QueryConnection(service.WithTrustedQuery(ctx), id, req)
			if err != nil || resp == nil || resp.ResultSet == nil {
				return resp, err
			}
			// Apply the optional row cap after the adapter has returned —
			// we don't push limit into adapters (would require changes
			// in every one). For probe-style usage the caller has
			// usually baked LIMIT into the SQL anyway; this is the
			// safety net + token-saving trim.
			if limit > 0 && len(resp.ResultSet.Rows) > limit {
				resp.ResultSet.Rows = resp.ResultSet.Rows[:limit]
				if resp.ResultSet.Metadata == nil {
					resp.ResultSet.Metadata = map[string]interface{}{}
				}
				resp.ResultSet.Metadata["truncated_to"] = limit
			}
			return resp, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "analyze_dataset",
			Description: "Run a server-side statistical analysis over a connection's data and get back a compact JSON summary — the server fetches the rows (up to 50k) and does the math, so prefer this over query_connection for questions about the shape or behavior of data too big to read row-by-row. Analyses: `summary` (per-column stats/percentiles/histogram; optional `group_by` for per-group stats), `anomaly` (rolling z-score outlier windows; needs `column`), `correlation` (Pearson between `column_a`/`column_b`, optional `max_lag`), `trend` (regression slope + R² and hour-of-day/day-of-week means; needs `column` + `timestamp_column`). EXCEPTION for plain summary/group_by stats on `sql` or EdgeLake connections: push the aggregation into the query itself (AVG/COUNT/GROUP BY via query_connection) — exact answers, less data moved; use summary mainly for sources that can't aggregate in-query. anomaly/correlation/trend are appropriate on any source. IMPORTANT: `max_rows` trims AFTER the source returns — it does not limit the fetch. On sql/edgelake ALWAYS bound the query yourself in `raw` (LIMIT and/or a time-window filter, ideally ORDER BY the time column): an unbounded SELECT can pull an entire table into server memory, and trimming an unordered result biases the analysis toward arbitrary rows. The `raw`/`type`/`params` query fields work exactly like query_connection.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id":    {Type: "string", Description: "Connection ID to fetch data from"},
					"raw":              {Type: "string", Description: "The query string (SQL, API path, filter expression, etc)"},
					"type":             {Type: "string", Description: "Query type — sql, api, csv_filter, stream_filter"},
					"params":           {Type: "object", Description: "Optional query parameters"},
					"analysis":         {Type: "string", Enum: []string{"summary", "anomaly", "correlation", "trend"}, Description: "Which analysis to run"},
					"columns":          {Raw: map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "summary only: columns to summarize (default all, capped at 20)"}},
					"column":           {Type: "string", Description: "anomaly/trend: the numeric column to analyze"},
					"column_a":         {Type: "string", Description: "correlation: first numeric column"},
					"column_b":         {Type: "string", Description: "correlation: second numeric column"},
					"timestamp_column": {Type: "string", Description: "Time column (RFC3339 or epoch seconds/millis); sorts the series and enables time-based output"},
					"group_by":         {Type: "string", Description: "summary only: per-group stats keyed on this column (top 20 groups by row count; columns capped at 5 when grouped)"},
					"sensitivity":      {Type: "number", Description: "anomaly: z-score threshold, default 3.0 (range 1-10)"},
					"max_lag":          {Type: "integer", Description: "correlation: scan row shifts up to ±max_lag for the strongest correlation"},
					"max_rows":         {Type: "integer", Description: "Cap rows ANALYZED (default and max 50000). Trims after the source returns — not a fetch limit; bound sql/edgelake queries in `raw` with LIMIT / a time window"},
				},
				Required: []string{"connection_id", "raw", "analysis"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			if r.toolops == nil {
				return nil, fmt.Errorf("analyze_dataset not available: toolops not wired")
			}
			// decodeInto keeps the args field-complete (#54) — a field
			// added to AnalyzeDatasetInput flows through without a
			// parser change here.
			var in toolops.AnalyzeDatasetInput
			if err := decodeInto(args, &in); err != nil {
				return nil, fmt.Errorf("invalid analyze_dataset args: %w", err)
			}
			return r.toolops.AnalyzeDataset(ctx, in)
		},
	)
}

// ============================================================================
// Discovery tools — let an agent introspect the data shape of an existing
// connection (database schema, MQTT topics, EdgeLake tables, Prometheus
// labels, etc) before generating queries or building components.
// ============================================================================

func (r *ToolRegistry) registerDiscoveryTools() {
	r.registerTool(
		Tool{
			Name:        "get_connection_schema",
			Description: "Discover the schema of a connection. SQL connections return tables and columns. Prometheus connections return available metrics and labels — at scale this can be hundreds of metrics, so use `metric_prefix` to keep the response focused (e.g. `node_` for node-exporter, `kube_` for kube-state-metrics). Returns a not-supported error for connection types that don't expose schema (CSV, raw socket, etc).",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id":   {Type: "string", Description: "Connection ID"},
					"metric_prefix":   {Type: "string", Description: "Prometheus only: return only metric names that start with this prefix. Recommended on any Prometheus server exposing more than a few dozen metrics — otherwise the response can bloat your context with hundreds of irrelevant names."},
					"metric_contains": {Type: "string", Description: "Prometheus only: return only metric names that contain this substring. Takes precedence over metric_prefix if both are given."},
					"max_metrics":     {Type: "integer", Description: "Prometheus only: cap the number of metric names returned. Default 150. Set a negative value for unlimited."},
				},
				Required: []string{"connection_id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			resp, err := r.connectionService.GetSchema(ctx, getString(args, "connection_id"))
			if err != nil || resp == nil || resp.PrometheusSchema == nil {
				return resp, err
			}

			// Prometheus-specific filter pass. The service returns every
			// metric the server has ever scraped; for real deployments
			// (kube-state-metrics, node-exporter, cadvisor, istio, etc.
			// all in one cluster) that's easily 1000+ names and blows up
			// the agent's context budget. The caller-provided filters
			// let an agent ask for exactly what it's going to build
			// charts against.
			prefix := getString(args, "metric_prefix")
			contains := getString(args, "metric_contains")
			maxMetrics := getInt(args, "max_metrics")
			if maxMetrics == 0 {
				maxMetrics = 150 // default cap; agent can pass a larger value to override
			}
			if maxMetrics < 0 {
				maxMetrics = 0 // negative = unlimited
			}

			all := resp.PrometheusSchema.Metrics
			filtered := make([]models.PrometheusMetricInfo, 0, len(all))
			for _, m := range all {
				if contains != "" && !strings.Contains(m.Name, contains) {
					continue
				}
				if contains == "" && prefix != "" && !strings.HasPrefix(m.Name, prefix) {
					continue
				}
				filtered = append(filtered, m)
			}
			totalMatched := len(filtered)
			truncated := false
			if maxMetrics > 0 && len(filtered) > maxMetrics {
				filtered = filtered[:maxMetrics]
				truncated = true
			}

			// Return the usual envelope but with the filtered metric
			// list and a small footer so the agent knows whether the
			// answer was narrowed.
			out := map[string]interface{}{
				"success":  resp.Success,
				"duration": resp.Duration,
				"prometheus_schema": map[string]interface{}{
					"metrics":       filtered,
					"labels":        resp.PrometheusSchema.Labels,
					"total_metrics": len(all),
					"total_matched": totalMatched,
					"truncated":     truncated,
				},
			}
			if resp.Error != "" {
				out["error"] = resp.Error
			}
			return out, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_mqtt_topics",
			Description: "List topics observed on an MQTT connection. The MQTT adapter snoops the broker for a short window and returns whatever it sees. MQTT-only.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "MQTT connection ID"},
				},
				Required: []string{"connection_id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			topics, err := r.connectionService.GetMQTTTopics(ctx, getString(args, "connection_id"))
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"topics": topics, "count": len(topics)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "sample_mqtt_topic",
			Description: "Subscribe briefly to an MQTT topic and return one sample payload. Useful for inferring the JSON shape so you know what `state_field` to set on a control.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "MQTT connection ID"},
					"topic":         {Type: "string", Description: "Topic name to sample"},
				},
				Required: []string{"connection_id", "topic"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return r.connectionService.SampleMQTTTopic(ctx, getString(args, "connection_id"), getString(args, "topic"))
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_edgelake_databases",
			Description: "List databases available on an EdgeLake connection.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "EdgeLake connection ID"},
				},
				Required: []string{"connection_id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			dbs, err := r.connectionService.GetEdgeLakeDatabases(ctx, getString(args, "connection_id"))
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"databases": dbs, "count": len(dbs)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_edgelake_tables",
			Description: "List tables in an EdgeLake database.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "EdgeLake connection ID"},
					"database":      {Type: "string", Description: "Database name"},
				},
				Required: []string{"connection_id", "database"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			tables, err := r.connectionService.GetEdgeLakeTables(ctx, getString(args, "connection_id"), getString(args, "database"))
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"tables": tables, "count": len(tables)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "get_edgelake_table_schema",
			Description: "Get column information for an EdgeLake table.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "EdgeLake connection ID"},
					"database":      {Type: "string", Description: "Database name"},
					"table":         {Type: "string", Description: "Table name"},
				},
				Required: []string{"connection_id", "database", "table"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			cols, err := r.connectionService.GetEdgeLakeSchema(ctx, getString(args, "connection_id"), getString(args, "database"), getString(args, "table"))
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"columns": cols, "count": len(cols)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_prometheus_label_values",
			Description: "Return all known values for a Prometheus label across the indexed series.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"connection_id": {Type: "string", Description: "Prometheus connection ID"},
					"label":         {Type: "string", Description: "Label name"},
				},
				Required: []string{"connection_id", "label"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			values, err := r.connectionService.GetPrometheusLabelValues(ctx, getString(args, "connection_id"), getString(args, "label"))
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"values": values, "count": len(values)}, nil
		},
	)
}

// ============================================================================
// Component tools — covers chart, control, and display components. They all
// live in the same `charts` collection, distinguished by `component_type`.
// ============================================================================

func (r *ToolRegistry) registerComponentTools() {
	r.registerTool(
		Tool{
			Name:        "list_components",
			Description: "List components (charts/controls/displays), filtered/sorted/paginated server-side. By default returns ALL matching components (up to a 1000 cap); use filters + page_size to narrow. The result's count (total) + has_more indicate truncation. Components are stored in one collection and discriminated by `component_type`.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: withListProps(map[string]PropertySchema{
					"namespace":      {Type: "string", Description: "Filter by namespace"},
					"name":           {Type: "string", Description: "Filter by name (case-insensitive word-prefix match)"},
					"chart_type":     {Type: "string", Description: "Filter by chart subtype (bar, line, etc)"},
					"component_type": {Type: "string", Enum: []string{"chart", "control", "display"}, Description: "Filter by component type"},
					"status":         {Type: "string", Enum: []string{"draft", "final"}, Description: "Filter by status"},
					"connection_id":  {Type: "string", Description: "Filter by connection ID"},
					"tags":           {Type: "array", Description: "Filter by tags (OR semantics)"},
				}, "name, updated, created, component_type, chart_type, status, namespace"),
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			in := toolops.ListComponentsInput{
				Namespace:     getString(args, "namespace"),
				Name:          getString(args, "name"),
				ChartType:     getString(args, "chart_type"),
				ComponentType: getString(args, "component_type"),
				Status:        getString(args, "status"),
				ConnectionID:  getString(args, "connection_id"),
				Tags:          getStringSlice(args, "tags"),
				Tag:           getString(args, "tag"),
				Sort:          getString(args, "sort"),
				Direction:     getString(args, "direction"),
				Page:          getInt(args, "page"),
				PageSize:      getInt(args, "page_size"),
			}
			if r.toolops != nil {
				return r.toolops.ListComponents(ctx, in)
			}
			result, err := r.componentService.ListComponents(ctx, models.ComponentQueryParams{
				Namespace: in.Namespace, Name: in.Name, ChartType: in.ChartType,
				ComponentType: in.ComponentType, Status: in.Status, ConnectionID: in.ConnectionID,
				Tags: in.Tags, Tag: in.Tag, Sort: in.Sort, Direction: in.Direction,
				Page: in.Page, PageSize: in.PageSize,
			})
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"components": result.Components, "count": result.Total, "page": result.Page, "page_size": result.PageSize, "has_more": result.HasMore}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "get_component",
			Description: "Get a single component by ID. Returns the full chart/control/display record including query_config, data_mapping, control_config, etc.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Component ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return r.componentService.GetComponent(ctx, getString(args, "id"))
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_component_summaries",
			Description: "Lightweight component summary list (id + name + type) for selection UIs. Cheaper than list_components when you don't need the full record.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"limit": {Type: "number", Description: "Maximum summaries (default 50)"},
				},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			limit := int64(50)
			if l := getInt(args, "limit"); l > 0 {
				limit = int64(l)
			}
			return r.componentService.GetComponentSummaries(ctx, limit)
		},
	)

	r.registerTool(
		Tool{
			Name:        "create_component",
			Description: "Create a new component. Set `component_type` to chart, control, or display. Charts need `chart_type`, `connection_id`, `query_config`, and `data_mapping` (call list_chart_types first). Controls need `control_config` with `control_type` (call list_control_types). Displays need `display_config` with `display_type` (call list_display_types).",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"name":                    {Type: "string", Description: "Unique component name (must be unique within the target namespace). This is the INTERNAL identifier — keep it descriptive but it is NOT the on-panel label. Set `title` for the display label."},
					"title":                   {Type: "string", Description: "Human-readable display label shown in the panel header (e.g. \"CPU Utilization\", \"Memory %\"). ALWAYS set this — it's what users see. Use title case, keep under ~40 chars. Do NOT encode the label into `name`; the renderer shows title when set, falling back to name only when title is empty."},
					"description":             {Type: "string", Description: "Description"},
					"namespace":               {Type: "string", Description: "Target namespace. Must equal the runtime context's target namespace; omit to default to \"default\"."},
					"component_type":          {Type: "string", Description: "chart | control | display", Enum: []string{"chart", "control", "display"}},
					"chart_type":              {Type: "string", Description: "Chart subtype (bar, line, pie, etc) — for chart components"},
					"connection_id":           {Type: "string", Description: "Connection ID for data binding"},
					"query_config":            {Type: "object", Description: "Query: {raw, type, params}"},
					"data_mapping":            {Type: "object", Description: "Data mapping: {x_axis, y_axis, series, group_by, filters, aggregation, ...}. `series` is a SINGLE column name (string): when the result stacks multiple series in one column with a distinguishing label column (e.g. a Prometheus `sum by (mode)` query returns rows with a `mode` column, or any long-format table), set series to that label column to split into one line/bar per value. Omitting it renders all rows as a single merged series. (`group_by` is a separate, client-side grouping field — for multi-series from a label column, use `series`.) For chart_type 'banded_bar' set band_columns: {scheme: \"sd\"|\"minmaxmean\"|\"spc\", and the columns for that scheme — sd: mean + plus_1sd/minus_1sd/plus_2sd/minus_2sd; minmaxmean: mean + min/max; spc: target + lower_control/upper_control/lower_limit/upper_limit}. Each row carries its own band values; the center column is required. For line/area charts of a monotonically-increasing COUNTER (odometer, packet/request total, kWh meter), set accumulator_columns: a boolean array index-aligned to y_axis (true at position i plots that column's per-interval DELTA value[i]-value[i-1] instead of the raw ramp) — per-column, so you can delta one series and leave another raw. Prefer this over custom code or a SQL LAG()/Prometheus rate(). accumulator_reset_policy (\"drop_negative\" default | \"clamp_zero\" | \"keep_negative\") governs counter resets. (Legacy accumulator_mode:true = all y columns is still accepted.)"},
					"control_config":          {Type: "object", Description: "Control config: {control_type, device_type_id, target, ui_config}"},
					"display_config":          {Type: "object", Description: "Display config: {display_type, ...display-specific fields}"},
					"component_code":          {Type: "string", Description: "React component code (for chart_type=custom or use_custom_code=true)"},
					"use_custom_code":         {Type: "boolean", Description: "Render via custom React code instead of ECharts options"},
					"options":                 {Raw: toolops.ChartOptionsSchema()},
					"tags":                    {Type: "array", Description: "Tags"},
					"uses_dashboard_variable": {Type: "boolean", Description: "Marks this component as accepting dashboard-variable substitution (the {{dashboard-variable}} token in its query or a filter value)."},
				},
				Required: []string{"name"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			// Fail loud on the text-panel mistake: agents have tried to make
			// section headers via create_component with a text_config arg (no
			// such field → silently dropped → a blank component shell). Text
			// panels are a panel-level text_config in create_dashboard, not a
			// component. Redirect explicitly instead of accepting the no-op.
			if _, hasText := args["text_config"]; hasText {
				return nil, fmt.Errorf("text_config is not a component field — do NOT create a component for a section header or text label. Text/header panels are created inline on the dashboard: in create_dashboard (or update_dashboard), add a panel with text_config set and component_id left unset")
			}
			req := &models.CreateComponentRequest{
				Name:                  getString(args, "name"),
				Title:                 getString(args, "title"),
				Description:           getString(args, "description"),
				Namespace:             getString(args, "namespace"),
				ComponentType:         getString(args, "component_type"),
				ChartType:             getString(args, "chart_type"),
				ConnectionID:          getString(args, "connection_id"),
				ComponentCode:         getString(args, "component_code"),
				UseCustomCode:         getBool(args, "use_custom_code"),
				UsesDashboardVariable: getBool(args, "uses_dashboard_variable"),
			}
			// Nested model objects decode field-complete via their json tags
			// (decodeInto), so new model fields reach MCP without a parser
			// change — see issue #54.
			if qc, ok := args["query_config"].(map[string]interface{}); ok {
				req.QueryConfig = &models.ChartQueryConfig{}
				if err := decodeInto(qc, req.QueryConfig); err != nil {
					return nil, fmt.Errorf("invalid query_config: %w", err)
				}
			}
			if dm, ok := args["data_mapping"].(map[string]interface{}); ok {
				req.DataMapping = &models.ChartDataMapping{}
				if err := decodeInto(dm, req.DataMapping); err != nil {
					return nil, fmt.Errorf("invalid data_mapping: %w", err)
				}
			}
			if cc, ok := args["control_config"].(map[string]interface{}); ok {
				req.ControlConfig = &models.ControlConfig{}
				if err := decodeInto(cc, req.ControlConfig); err != nil {
					return nil, fmt.Errorf("invalid control_config: %w", err)
				}
			}
			if dc, ok := args["display_config"].(map[string]interface{}); ok {
				req.DisplayConfig = &models.DisplayConfig{}
				if err := decodeInto(dc, req.DisplayConfig); err != nil {
					return nil, fmt.Errorf("invalid display_config: %w", err)
				}
			}
			if opts, ok := args["options"].(map[string]interface{}); ok {
				req.Options = opts
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			// Stamp the AI-provenance tag server-side (issue #59). MCP creates
			// directly via the service (not toolops), so apply it here too.
			req.Tags = models.WithAITag(req.Tags)
			out, err := r.componentService.CreateComponent(ctx, req)
			if err != nil {
				return nil, err
			}
			return componentWriteAck(out), nil
		},
	)

	r.registerTool(
		Tool{
			Name: "update_component",
			Description: `Update an existing component. Only provided fields are changed.

**Prefer changing fields like data_mapping / options / chart_type / connection_id over component_code + use_custom_code=true.** The chart's auto-generated code regenerates from those settings whenever any of them change, so the chart stays in sync with the editor's UI form. Setting use_custom_code=true is destructive: the editor switches to "Custom Code Mode" where the data-mapping form is bypassed, and subsequent data_mapping / options edits no longer affect rendering — every later change requires re-writing the code by hand.

Only set use_custom_code=true when (a) the user explicitly asks for custom code or hand-tuned visual logic, or (b) you've identified a specific rendering need (custom renderItem, computed tooltip formatter, non-standard interaction) that no configuration field can express.`,
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id":                      {Type: "string", Description: "Component ID"},
					"name":                    {Type: "string", Description: "New internal name (the identifier, not the on-panel label). To change the displayed label, set `title` instead — do not rename to relabel."},
					"title":                   {Type: "string", Description: "New human-readable display label shown in the panel header (e.g. \"CPU Utilization\"). This — not `name` — is what users see; the renderer shows title when set."},
					"description":             {Type: "string", Description: "New description"},
					"chart_type":              {Type: "string", Description: "New chart subtype"},
					"connection_id":           {Type: "string", Description: "New connection ID"},
					"query_config":            {Type: "object", Description: "New query config"},
					"data_mapping":            {Type: "object", Description: "New data mapping. For multiple series from a label column (e.g. a Prometheus `sum by (mode)` result), set `series` to that column name — see create_component's data_mapping description. For chart_type 'banded_bar' include band_columns (see create_component's data_mapping description for the per-scheme keys). For a line/area chart of a counter, set accumulator_columns (boolean array index-aligned to y_axis, + optional accumulator_reset_policy) to plot per-interval deltas — see create_component's data_mapping description."},
					"control_config":          {Type: "object", Description: "New control config"},
					"display_config":          {Type: "object", Description: "New display config"},
					"component_code":          {Type: "string", Description: "New component code. Last-resort field — prefer changing data_mapping / options / chart_type instead. Setting this with use_custom_code=true freezes the chart at this code; subsequent config tool calls won't update the rendering."},
					"use_custom_code":         {Type: "boolean", Description: "New custom-code flag. Setting true is destructive and one-way (per the description above). Only enable when configuration fields can't express the request."},
					"options":                 {Raw: toolops.ChartOptionsSchema()},
					"tags":                    {Type: "array", Description: "New tags"},
					"uses_dashboard_variable": {Type: "boolean", Description: "Marks this component as accepting dashboard-variable substitution: the {{dashboard-variable}} token may appear in its query (substituted server-side as a bound param) or in a client-side filter value (substituted at view time). Drives the editor's substitution UI hints."},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateComponentRequest{}
			if name := getString(args, "name"); name != "" {
				req.Name = &name
			}
			if title := getString(args, "title"); title != "" {
				req.Title = &title
			}
			if desc := getString(args, "description"); desc != "" {
				req.Description = &desc
			}
			if ct := getString(args, "chart_type"); ct != "" {
				req.ChartType = &ct
			}
			if cid := getString(args, "connection_id"); cid != "" {
				req.ConnectionID = &cid
			}
			if code := getString(args, "component_code"); code != "" {
				req.ComponentCode = &code
			}
			if _, ok := args["use_custom_code"]; ok {
				v := getBool(args, "use_custom_code")
				req.UseCustomCode = &v
			}
			// Nested model objects decode field-complete via decodeInto — see
			// issue #54.
			if qc, ok := args["query_config"].(map[string]interface{}); ok {
				req.QueryConfig = &models.ChartQueryConfig{}
				if err := decodeInto(qc, req.QueryConfig); err != nil {
					return nil, fmt.Errorf("invalid query_config: %w", err)
				}
			}
			if dm, ok := args["data_mapping"].(map[string]interface{}); ok {
				req.DataMapping = &models.ChartDataMapping{}
				if err := decodeInto(dm, req.DataMapping); err != nil {
					return nil, fmt.Errorf("invalid data_mapping: %w", err)
				}
			}
			if cc, ok := args["control_config"].(map[string]interface{}); ok {
				req.ControlConfig = &models.ControlConfig{}
				if err := decodeInto(cc, req.ControlConfig); err != nil {
					return nil, fmt.Errorf("invalid control_config: %w", err)
				}
			}
			if dc, ok := args["display_config"].(map[string]interface{}); ok {
				req.DisplayConfig = &models.DisplayConfig{}
				if err := decodeInto(dc, req.DisplayConfig); err != nil {
					return nil, fmt.Errorf("invalid display_config: %w", err)
				}
			}
			if opts, ok := args["options"].(map[string]interface{}); ok {
				req.Options = &opts
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				tags := parseStringArray(tagsRaw)
				req.Tags = &tags
			}
			if _, ok := args["uses_dashboard_variable"]; ok {
				v := getBool(args, "uses_dashboard_variable")
				req.UsesDashboardVariable = &v
			}
			out, err := r.componentService.UpdateComponent(ctx, id, req)
			if err != nil {
				return nil, err
			}
			return componentWriteAck(out), nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "delete_component",
			Description: "Delete a component by ID. Dashboards referencing it will show an empty panel.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Component ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if _, err := r.componentService.DeleteComponent(ctx, id); err != nil {
				return nil, err
			}
			return map[string]interface{}{"success": true, "message": fmt.Sprintf("Component %s deleted", id)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_dashboards_using_component",
			Description: "Find every dashboard that references a specific component (default + component-swap references). Useful before deleting a component to see what would break. Returns ALL matching dashboards (up to a 1000 cap); count + has_more indicate truncation.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: withListProps(map[string]PropertySchema{
					"component_id": {Type: "string", Description: "Component ID"},
				}, "name, updated, created, namespace"),
				Required: []string{"component_id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			in := toolops.ListDashboardsInput{
				ComponentID: getString(args, "component_id"),
				Sort:        getString(args, "sort"),
				Direction:   getString(args, "direction"),
				Page:        getInt(args, "page"),
				PageSize:    getInt(args, "page_size"),
			}
			if r.toolops != nil {
				return r.toolops.ListDashboards(ctx, in)
			}
			result, err := r.dashboardService.ListDashboards(ctx, models.DashboardQueryParams{
				ComponentID: in.ComponentID, Sort: in.Sort, Direction: in.Direction, Page: in.Page, PageSize: in.PageSize,
			})
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"dashboards": result.Dashboards, "count": result.Total, "page": result.Page, "page_size": result.PageSize, "has_more": result.HasMore}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "get_component_template",
			Description: "Return the custom-code starting template — a freeform React/ECharts skeleton with Carbon g100 styling, the CARBON_COLORS palette, and the viewer's data helpers (toObjects, getValue, formatTimestamp, formatCellValue — do not import them) already wired. ONLY for hand-written custom code: set use_custom_code=true and pass the filled-in code in update_component's `component_code` field. The canonical chart types (line, bar, area, pie, scatter, gauge, value, dataview, banded_bar) are spec-driven — configure them via create_component / update_component structured fields (chart_type + data_mapping + options); do NOT fetch a template and hand-write code for them. There is exactly one template, 'custom'.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"chart_type": {
						Type:        "string",
						Description: "Always 'custom' — the only available template. Canonical chart types are spec-driven and have no template.",
					},
				},
				Required: []string{"chart_type"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			ct := getString(args, "chart_type")
			if ct == "" {
				return nil, fmt.Errorf("chart_type is required")
			}
			tmpl, ok := componenttemplates.Get(ct)
			if !ok {
				return nil, fmt.Errorf("no template for chart type %q — only 'custom' exists; canonical chart types are spec-driven and configured via create_component / update_component", ct)
			}
			return map[string]interface{}{
				"chart_type": ct,
				"template":   tmpl,
			}, nil
		},
	)
}

// ============================================================================
// Dashboard tools. Dashboards are a name + grid panels. Each panel either
// references a component (component_id) or carries inline text (text_config).
// ============================================================================

func (r *ToolRegistry) registerDashboardTools() {
	r.registerTool(
		Tool{
			Name:        "list_dashboards",
			Description: "List dashboards, filtered/sorted/paginated server-side. By default returns ALL matching dashboards (up to a 1000 cap). Pass component_id to find dashboards using a specific component. count (total) + has_more indicate truncation.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: withListProps(map[string]PropertySchema{
					"namespace":     {Type: "string", Description: "Filter by namespace"},
					"name":          {Type: "string", Description: "Filter by name (partial match)"},
					"is_public":     {Type: "boolean", Description: "Filter by public status"},
					"component_id":  {Type: "string", Description: "Only dashboards that reference this component"},
					"connection_id": {Type: "string", Description: "Only dashboards using any component bound to this connection"},
					"tags":          {Type: "array", Description: "Filter by tags (OR semantics)"},
				}, "name, updated, created, namespace"),
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			in := toolops.ListDashboardsInput{
				Namespace:    getString(args, "namespace"),
				Name:         getString(args, "name"),
				ComponentID:  getString(args, "component_id"),
				ConnectionID: getString(args, "connection_id"),
				Tags:         getStringSlice(args, "tags"),
				Sort:         getString(args, "sort"),
				Direction:    getString(args, "direction"),
				Page:         getInt(args, "page"),
				PageSize:     getInt(args, "page_size"),
			}
			if _, ok := args["is_public"]; ok {
				b := getBool(args, "is_public")
				in.IsPublic = &b
			}
			if r.toolops != nil {
				return r.toolops.ListDashboards(ctx, in)
			}
			result, err := r.dashboardService.ListDashboards(ctx, models.DashboardQueryParams{
				Namespace: in.Namespace, Name: in.Name, IsPublic: in.IsPublic, ComponentID: in.ComponentID,
				ConnectionID: in.ConnectionID,
				Tags:         in.Tags, Sort: in.Sort, Direction: in.Direction, Page: in.Page, PageSize: in.PageSize,
			})
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"dashboards": result.Dashboards, "count": result.Total, "page": result.Page, "page_size": result.PageSize, "has_more": result.HasMore}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "get_dashboard",
			Description: "Get a single dashboard by ID, including its panel layout.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Dashboard ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			return r.dashboardService.GetDashboard(ctx, getString(args, "id"))
		},
	)

	r.registerTool(
		Tool{
			Name:        "create_dashboard",
			Description: "Create a new dashboard. Panels live directly on the dashboard (there is no separate Layout entity). Each panel is `{id, x, y, w, h, component_id?, text_config?}` in 32x32 px cell units — see the session-init \"Grid contract\" section for how cols/rows derive from canvas size.\n\nA panel can be one of three things:\n  1. **Component panel** — set `component_id` to an existing component UUID (chart / control / display).\n  2. **Native text panel** — set `text_config` (NOT component_id). This renders text directly on the panel without creating a component record. Use it for section headers, dashboard titles, dates/clocks, or any standalone label that doesn't need to be reused or referenced from another dashboard.\n  3. **Empty placeholder** — neither component_id nor text_config. Renders an empty cell.\n\nPrefer a native text panel over creating a `text_label` control component when the text is one-off and dashboard-specific. Components are reusable; text_config is inline.\n\n`text_config` schema:\n  - `content` (string) — literal text. Used when `display_content` is `\"title\"` (or omitted).\n  - `display_content` (string) — what to render. One of: `\"title\"` (use `content`), `\"date_short\"`, `\"date_medium\"`, `\"date_long\"`, `\"time_12\"`, `\"time_24\"`, `\"datetime_short\"`, `\"datetime_long\"`. The date/time variants render the live date or time and tick every second.\n  - `size` (int OR string) — font size in pixels (e.g. 24), or a legacy preset name (`\"sm\"`, `\"md\"`, `\"lg\"`, `\"xl\"`).\n  - `align` (string) — `\"left\"`, `\"center\"`, or `\"right\"`. Defaults to center when omitted.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"name":        {Type: "string", Description: "Unique dashboard name (must be unique within the target namespace)"},
					"description": {Type: "string", Description: "Description"},
					"namespace":   {Type: "string", Description: "Target namespace. Must equal the runtime context's target namespace; omit to default to \"default\"."},
					"panels":      {Type: "array", Description: "Array of panel objects. Each panel is {id, x, y, w, h, and exactly one of: component_id (reference an existing component), text_config (inline text — see tool description for schema), or neither (empty placeholder)}. A panel may ALSO carry `connection_tags` (array of strings — binds this panel to a different connection family when the dashboard's connection_swap variable is in tag_value mode) and `component_overrides` (array of {subject, op, value, component_id} — render a different component when the variable's value matches). IMPORTANT: this call REPLACES the whole panel array, so read the dashboard first and echo both fields back on every panel you are not deliberately changing — omitting them deletes them (#268)."},
					"settings":    {Type: "object", Description: "Dashboard settings: theme, refresh_interval (SECONDS, not ms — e.g. 30 = every 30s, 0 = disabled), timezone, layout_dimension, title_scale, scale_percent, panel_background (\"\" inherit / solid / transparent), is_public, allow_export. Dashboard variables: set variables_enabled=true and variables=[{name, label, mode, ...}] where mode is connection_swap | filter | range. filter variables substitute the {{dashboard-variable}} token in component queries; range variables substitute {{range-variable}} (written as `<column> {{range-variable}}`). See the dashboard-builder prompt's \"Dashboard variables\" section for the full shape and authoring contract."},
					"tags":        {Type: "array", Description: "Tags"},
				},
				Required: []string{"name"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			req := &models.CreateDashboardRequest{
				Name:        getString(args, "name"),
				Description: getString(args, "description"),
				Namespace:   getString(args, "namespace"),
			}
			// panels + settings decode field-complete via decodeInto (incl.
			// settings.variables[], layout_dimension, scale fields) — issue #54.
			if panelsRaw, ok := args["panels"].([]interface{}); ok {
				if err := decodeInto(panelsRaw, &req.Panels); err != nil {
					return nil, fmt.Errorf("invalid panels: %w", err)
				}
			}
			if settingsRaw, ok := args["settings"].(map[string]interface{}); ok {
				if err := decodeInto(settingsRaw, &req.Settings); err != nil {
					return nil, fmt.Errorf("invalid settings: %w", err)
				}
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			// AI-provenance tag (issue #59) — MCP creates directly via service.
			req.Tags = models.WithAITag(req.Tags)
			return r.dashboardService.CreateDashboard(ctx, req)
		},
	)

	r.registerTool(
		Tool{
			Name:        "update_dashboard",
			Description: "Update an existing dashboard. Only provided fields are changed. When `panels` is provided, it REPLACES the entire panel array — fetch the current dashboard first if you only want to add or modify a subset.\n\nPanel shapes are the same as `create_dashboard`: each panel either references a component via `component_id`, carries inline text via `text_config`, or is an empty placeholder. See `create_dashboard` for the full `text_config` schema (content / display_content / size / align). Native text panels are the right tool for dashboard headers, titles, date/clock displays, and other one-off text — use them instead of creating a `text_label` control unless the text needs to be reusable across dashboards.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id":          {Type: "string", Description: "Dashboard ID"},
					"name":        {Type: "string", Description: "New name"},
					"description": {Type: "string", Description: "New description"},
					"panels":      {Type: "array", Description: "New panel array (replaces existing). Each panel is {id, x, y, w, h, and exactly one of: component_id, text_config, or neither}. See create_dashboard for text_config schema. A panel may ALSO carry `connection_tags` (array of strings — binds this panel to a different connection family when the dashboard's connection_swap variable is in tag_value mode) and `component_overrides` (array of {subject, op, value, component_id} — render a different component when the variable's value matches). IMPORTANT: this call REPLACES the whole panel array, so read the dashboard first and echo both fields back on every panel you are not deliberately changing — omitting them deletes them (#268)."},
					"settings":    {Type: "object", Description: "Settings to change (same shape as create_dashboard, including variables_enabled + variables[] for dashboard variables). MERGED per key: only the keys you send are written, so a partial update no longer wipes untouched settings like layout_dimension (#135). Note this differs from `panels`, which replaces the whole array."},
					"tags":        {Type: "array", Description: "New tags"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateDashboardRequest{}
			if name := getString(args, "name"); name != "" {
				req.Name = &name
			}
			if desc := getString(args, "description"); desc != "" {
				req.Description = &desc
			}
			if panelsRaw, ok := args["panels"].([]interface{}); ok {
				var panels []models.DashboardPanel
				if err := decodeInto(panelsRaw, &panels); err != nil {
					return nil, fmt.Errorf("invalid panels: %w", err)
				}
				req.Panels = &panels
			}
			if settingsRaw, ok := args["settings"].(map[string]interface{}); ok {
				var settings models.DashboardSettings
				if err := decodeInto(settingsRaw, &settings); err != nil {
					return nil, fmt.Errorf("invalid settings: %w", err)
				}
				req.Settings = &settings
				// Carry the raw key set so the repo merges ONLY the fields the
				// caller sent — a partial settings update (e.g. just panels +
				// refresh_interval) no longer wipes layout_dimension etc (#135).
				req.SettingsFields = settingsRaw
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				tags := parseStringArray(tagsRaw)
				req.Tags = &tags
			}
			return r.dashboardService.UpdateDashboard(ctx, id, req)
		},
	)

	r.registerTool(
		Tool{
			Name:        "delete_dashboard",
			Description: "Delete a dashboard by ID.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id": {Type: "string", Description: "Dashboard ID"},
				},
				Required: []string{"id"},
			},
		},
		func(ctx context.Context, args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if err := r.dashboardService.DeleteDashboard(ctx, id); err != nil {
				return nil, err
			}
			return map[string]interface{}{"success": true, "message": fmt.Sprintf("Dashboard %s deleted", id)}, nil
		},
	)
}

// ============================================================================
// Helper functions for parsing JSON-RPC arguments. Most of these are
// preserved from the previous tools.go implementation.
// ============================================================================

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

// coerceStringifiedJSONArgs repairs a common MCP-client failure mode: some
// clients (including LLMs emitting tool calls) encode an object- or
// array-typed parameter as a JSON *string* — e.g. data_mapping arrives as
// `"{\"x_axis\":\"ts\"}"` instead of `{"x_axis":"ts"}`. Our per-tool
// handlers type-assert these params to map[string]interface{} /
// []interface{}; a string fails that assertion and the field is SILENTLY
// DROPPED (the chart is created with no query_config/data_mapping, then fails
// downstream validation with a confusing error). Rather than make every
// call site string-tolerant, normalize once here: any top-level arg whose
// value is a string that parses as a JSON object or array is replaced with
// the parsed value. Plain-string params (name, chart_type, raw SQL, etc.)
// are left untouched — only strings that BOTH look like JSON (first
// non-space rune is '{' or '[') AND parse cleanly are converted, so a SQL
// string that happens to contain braces is never mangled (it won't parse).
func coerceStringifiedJSONArgs(args map[string]interface{}) {
	for k, v := range args {
		s, ok := v.(string)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(s)
		if trimmed == "" {
			continue
		}
		if trimmed[0] != '{' && trimmed[0] != '[' {
			continue
		}
		var parsed interface{}
		if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
			continue // not valid JSON — leave the string as-is
		}
		switch parsed.(type) {
		case map[string]interface{}, []interface{}:
			args[k] = parsed
		}
	}
}

// decodeInto round-trips a JSON-RPC arg value (a map/slice of JSON-native
// types) into a typed model struct via the struct's own json tags. This is
// the field-complete alternative to the hand-rolled parse* helpers: every
// json-tagged field on dst is populated automatically, so a new field on the
// model flows through to MCP with no parser change (the silent-drop bug class
// — see issue #54). args values originate from the standard-library JSON-RPC
// decode, so a Marshal→Unmarshal is lossless and cannot fail on type mismatch
// that the model's own Unmarshal wouldn't also reject.
func decodeInto(raw interface{}, dst interface{}) error {
	b, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, dst)
}

func getInt(m map[string]interface{}, key string) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	if v, ok := m[key].(int); ok {
		return v
	}
	return 0
}

func getBool(m map[string]interface{}, key string) bool {
	if v, ok := m[key].(bool); ok {
		return v
	}
	return false
}

// withListProps appends the shared sort + pagination property schemas
// every list tool accepts (#21) to the given property map. sortFields is
// the allowlist shown in the sort description.
func withListProps(props map[string]PropertySchema, sortFields string) map[string]PropertySchema {
	if props == nil {
		props = map[string]PropertySchema{}
	}
	props["sort"] = PropertySchema{Type: "string", Description: "Sort field. One of: " + sortFields + ". Omit for the default."}
	props["direction"] = PropertySchema{Type: "string", Enum: []string{"asc", "desc"}, Description: "Sort direction. Omit for the default."}
	props["page"] = PropertySchema{Type: "integer", Description: "1-based page number (default 1)."}
	props["page_size"] = PropertySchema{Type: "integer", Description: "Records per page. Omit or 0 = all matching, up to a server cap of 1000. The result's count + has_more tell you whether it was truncated."}
	return props
}

// getStringSlice extracts a []string from a JSON array arg (e.g. tags).
// Tolerates a single bare string too.
func getStringSlice(m map[string]interface{}, key string) []string {
	switch v := m[key].(type) {
	case []string:
		return v
	case []interface{}:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	}
	return nil
}

// componentWriteAck is the compact response envelope returned to MCP
// clients from create_component / update_component. The full Chart
// record is large (~2KB of component_code, plus query_config,
// data_mapping, options) and the client already knows the
// values it sent in the request — echoing them back just inflates
// the LLM's context history for no benefit. This envelope carries
// only what a caller can't compute: id, version, status, timestamps,
// and a code-length signal so the agent can sanity-check that its
// component_code landed.
func componentWriteAck(c *models.Component) map[string]interface{} {
	if c == nil {
		return nil
	}
	return map[string]interface{}{
		"id":                    c.ID,
		"version":               c.Version,
		"status":                c.Status,
		"component_type":        c.ComponentType,
		"namespace":             c.Namespace,
		"name":                  c.Name,
		"title":                 c.Title,
		"chart_type":            c.ChartType,
		"connection_id":         c.ConnectionID,
		"use_custom_code":       c.UseCustomCode,
		"component_code_length": len(c.ComponentCode),
		"created":               c.Created,
		"updated":               c.Updated,
	}
}

func getMap(m map[string]interface{}, key string) map[string]interface{} {
	if v, ok := m[key].(map[string]interface{}); ok {
		return v
	}
	return nil
}

// getStringMap pulls a nested object and coerces its values to strings,
// dropping any non-string entries. Returns nil when the key is absent or
// not an object (so callers can leave the target field unset).
func getStringMap(m map[string]interface{}, key string) map[string]string {
	raw, ok := m[key].(map[string]interface{})
	if !ok {
		return nil
	}
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		if s, ok := v.(string); ok {
			out[k] = s
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func parseConnectionConfig(dsType models.ConnectionType, configMap map[string]interface{}) models.ConnectionConfig {
	config := models.ConnectionConfig{}
	switch dsType {
	case models.ConnectionTypeAPI:
		config.API = &models.APIConfig{
			URL:                getString(configMap, "url"),
			Method:             getString(configMap, "method"),
			Timeout:            getInt(configMap, "timeout"),
			AuthType:           getString(configMap, "auth_type"),
			Body:               getString(configMap, "body"),
			RetryCount:         getInt(configMap, "retry_count"),
			RetryDelay:         getInt(configMap, "retry_delay"),
			InsecureSkipVerify: getBool(configMap, "insecure_skip_verify"),
			Headers:            getStringMap(configMap, "headers"),
			AuthCredentials:    getStringMap(configMap, "auth_credentials"),
			QueryParams:        getStringMap(configMap, "query_params"),
		}
		// response_config.data_path tells the adapter where the record array
		// lives in the JSON response. Accept it nested (response_config:{data_path})
		// or as a flat top-level data_path for convenience.
		dataPath := getString(configMap, "data_path")
		if rc := getMap(configMap, "response_config"); rc != nil {
			if dp := getString(rc, "data_path"); dp != "" {
				dataPath = dp
			}
		}
		if dataPath != "" {
			config.API.ResponseConfig = &models.APIResponseConfig{DataPath: dataPath}
		}
	case models.ConnectionTypeSQL:
		config.SQL = &models.SQLConfig{
			Driver:   getString(configMap, "driver"),
			Host:     getString(configMap, "host"),
			Port:     getInt(configMap, "port"),
			Database: getString(configMap, "database"),
			Username: getString(configMap, "username"),
			Password: getString(configMap, "password"),
			SSL:      getBool(configMap, "ssl"),
			Options:  getString(configMap, "options"),
		}
	case models.ConnectionTypeCSV:
		config.CSV = &models.CSVConfig{
			Path:      getString(configMap, "path"),
			Delimiter: getString(configMap, "delimiter"),
			HasHeader: getBool(configMap, "has_header"),
		}
	case models.ConnectionTypeSocket:
		socket := &models.SocketConfig{
			URL:                getString(configMap, "url"),
			Protocol:           getString(configMap, "protocol"),
			Bidirectional:      getBool(configMap, "bidirectional"),
			ReconnectOnError:   getBool(configMap, "reconnect_on_error"),
			ReconnectDelay:     getInt(configMap, "reconnect_delay"),
			PingInterval:       getInt(configMap, "ping_interval"),
			MessageFormat:      getString(configMap, "message_format"),
			BufferSize:         getInt(configMap, "buffer_size"),
			InsecureSkipVerify: getBool(configMap, "insecure_skip_verify"),
			// Custom headers (e.g. Authorization: Bearer …) — the socket
			// adapter passes these to the WS dialer, so header auth works
			// without leaking a token into the URL.
			Headers: getStringMap(configMap, "headers"),
		}
		// Parser config unwraps a nested payload (data_path) and pulls the
		// timestamp out of the message (timestamp_field). Only attach a
		// parser when at least one field is set so we don't store an empty
		// object.
		if p := getMap(configMap, "parser"); p != nil {
			parser := &models.SocketParserConfig{
				DataPath:        getString(p, "data_path"),
				TimestampField:  getString(p, "timestamp_field"),
				TimestampScale:  getString(p, "timestamp_scale"),
				TimestampFormat: getString(p, "timestamp_format"),
				FieldMappings:   getStringMap(p, "field_mappings"),
				IncludeFields:   getStringSlice(p, "include_fields"),
				ExcludeFields:   getStringSlice(p, "exclude_fields"),
			}
			if parser.DataPath != "" || parser.TimestampField != "" || parser.TimestampScale != "" ||
				parser.TimestampFormat != "" || len(parser.FieldMappings) > 0 ||
				len(parser.IncludeFields) > 0 || len(parser.ExcludeFields) > 0 {
				socket.Parser = parser
			}
		}
		config.Socket = socket
	case models.ConnectionTypeTSStore:
		config.TSStore = &models.TSStoreConfig{
			Transport: models.TSStoreTransport(getString(configMap, "transport")),
			Protocol:  models.TSStoreProtocol(getString(configMap, "protocol")),
			Host:      getString(configMap, "host"),
			Port:      getInt(configMap, "port"),
			StoreName: getString(configMap, "store_name"),
			DataType:  models.TSStoreDataType(getString(configMap, "data_type")),
			APIKey:    getString(configMap, "api_key"),
			Timeout:   getInt(configMap, "timeout"),
		}
	}
	return config
}

// Panels, settings, query_config, data_mapping, control_config, and
// display_config are decoded field-complete via decodeInto (Marshal→Unmarshal
// into the model struct) at the create/update call sites — see issue #54. The
// former hand-rolled parse* helpers for those objects were deleted because they
// enumerated fields manually and silently dropped any the model gained later.

// filterConnectionTypes applies the registry TypeFilter to a connection
// type listing. Returns the input unchanged when no filter is wired.
func (r *ToolRegistry) filterConnectionTypes(items []registry.TypeInfo) []registry.TypeInfo {
	if r.typeFilter == nil {
		return items
	}
	out := make([]registry.TypeInfo, 0, len(items))
	for _, t := range items {
		if r.typeFilter.IsEnabled(registry.CategoryConnection, t.TypeID) {
			out = append(out, t)
		}
	}
	return out
}

// filterComponentTypes applies the registry TypeFilter to a component type
// listing.
func (r *ToolRegistry) filterComponentTypes(items []registry.ComponentTypeInfo, category string) []registry.ComponentTypeInfo {
	if r.typeFilter == nil {
		return items
	}
	out := make([]registry.ComponentTypeInfo, 0, len(items))
	for _, t := range items {
		if r.typeFilter.IsEnabled(category, t.Subtype) {
			out = append(out, t)
		}
	}
	return out
}

func parseStringArray(arr []interface{}) []string {
	result := make([]string, 0, len(arr))
	for _, item := range arr {
		if s, ok := item.(string); ok {
			result = append(result, s)
		}
	}
	return result
}
