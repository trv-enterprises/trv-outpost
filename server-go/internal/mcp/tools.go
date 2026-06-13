// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"context"
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
	componentService      *service.ComponentService
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
		componentService:      chartSvc,
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
func (r *ToolRegistry) CallTool(name string, args map[string]interface{}) (interface{}, error) {
	handler, ok := r.handlers[name]
	if !ok {
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
	return handler(args)
}

func (r *ToolRegistry) registerTool(tool Tool, handler ToolHandler) {
	r.tools[tool.Name] = tool
	r.handlers[tool.Name] = handler
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
		func(args map[string]interface{}) (interface{}, error) {
			return registry.BuildCatalog(context.Background(), r.deviceTypeLister(), r.typeFilter)
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
		func(args map[string]interface{}) (interface{}, error) {
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
		func(args map[string]interface{}) (interface{}, error) {
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
		func(args map[string]interface{}) (interface{}, error) {
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
		func(args map[string]interface{}) (interface{}, error) {
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
		func(args map[string]interface{}) (interface{}, error) {
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
		func(args map[string]interface{}) (interface{}, error) {
			if r.deviceTypeService == nil {
				return map[string]interface{}{"device_types": []interface{}{}, "count": 0}, nil
			}
			resp, err := r.deviceTypeService.ListDeviceTypes(context.Background(), &models.DeviceTypeQueryParams{Page: 1, PageSize: 500})
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
			Description: "List all configured connections (datasources). Returns name, type, health status, and ID for each.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			// Shim through the shared toolops layer when available so
			// MCP and the Dashboard Assistant share one truth. Fall
			// back to direct service calls only when toolops isn't
			// wired (early bootstrap, tests).
			if r.toolops != nil {
				return r.toolops.ListConnections(context.Background())
			}
			ctx := context.Background()
			conns, total, err := r.connectionService.ListConnections(ctx, 100, 0)
			if err != nil {
				return nil, err
			}
			// Sanitize secrets before they reach the agent (the toolops
			// path above does the same). Never hand a live api_key /
			// password to a model or into an exportable transcript.
			masked := make([]*models.Connection, len(conns))
			for i, c := range conns {
				masked[i] = c.SanitizeForAPI()
			}
			return map[string]interface{}{
				"connections": masked,
				"count":       total,
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
		func(args map[string]interface{}) (interface{}, error) {
			id, ok := args["id"].(string)
			if !ok {
				return nil, fmt.Errorf("id must be a string")
			}
			if r.toolops != nil {
				return r.toolops.GetConnection(context.Background(), toolops.GetConnectionInput{ID: id})
			}
			conn, err := r.connectionService.GetConnection(context.Background(), id)
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
		func(args map[string]interface{}) (interface{}, error) {
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
			return r.connectionService.CreateConnection(context.Background(), req)
		},
	)

	r.registerTool(
		Tool{
			Name:        "update_connection",
			Description: "Update an existing connection. Provide only the fields you want to change.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"id":          {Type: "string", Description: "Connection ID"},
					"name":        {Type: "string", Description: "New name (optional)"},
					"description": {Type: "string", Description: "New description (optional)"},
				},
				Required: []string{"id"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateConnectionRequest{
				Name:        getString(args, "name"),
				Description: getString(args, "description"),
			}
			return r.connectionService.UpdateConnection(context.Background(), id, req)
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
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if _, err := r.connectionService.DeleteConnection(context.Background(), id); err != nil {
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
		func(args map[string]interface{}) (interface{}, error) {
			return r.connectionService.CheckHealth(context.Background(), getString(args, "id"))
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
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "connection_id")
			queryMap, _ := args["query"].(map[string]interface{})
			limit := getInt(args, "limit")
			if r.toolops != nil {
				return r.toolops.QueryConnection(context.Background(), toolops.QueryConnectionInput{
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
			resp, err := r.connectionService.QueryConnection(context.Background(), id, req)
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
					"connection_id":  {Type: "string", Description: "Connection ID"},
					"metric_prefix":  {Type: "string", Description: "Prometheus only: return only metric names that start with this prefix. Recommended on any Prometheus server exposing more than a few dozen metrics — otherwise the response can bloat your context with hundreds of irrelevant names."},
					"metric_contains": {Type: "string", Description: "Prometheus only: return only metric names that contain this substring. Takes precedence over metric_prefix if both are given."},
					"max_metrics":    {Type: "integer", Description: "Prometheus only: cap the number of metric names returned. Default 150. Set a negative value for unlimited."},
				},
				Required: []string{"connection_id"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			resp, err := r.connectionService.GetSchema(context.Background(), getString(args, "connection_id"))
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
		func(args map[string]interface{}) (interface{}, error) {
			topics, err := r.connectionService.GetMQTTTopics(context.Background(), getString(args, "connection_id"))
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
		func(args map[string]interface{}) (interface{}, error) {
			return r.connectionService.SampleMQTTTopic(context.Background(), getString(args, "connection_id"), getString(args, "topic"))
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
		func(args map[string]interface{}) (interface{}, error) {
			dbs, err := r.connectionService.GetEdgeLakeDatabases(context.Background(), getString(args, "connection_id"))
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
		func(args map[string]interface{}) (interface{}, error) {
			tables, err := r.connectionService.GetEdgeLakeTables(context.Background(), getString(args, "connection_id"), getString(args, "database"))
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
		func(args map[string]interface{}) (interface{}, error) {
			cols, err := r.connectionService.GetEdgeLakeSchema(context.Background(), getString(args, "connection_id"), getString(args, "database"), getString(args, "table"))
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
		func(args map[string]interface{}) (interface{}, error) {
			values, err := r.connectionService.GetPrometheusLabelValues(context.Background(), getString(args, "connection_id"), getString(args, "label"))
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
			Description: "List components (charts/controls/displays). Optionally filter by chart_type, connection ID, or tag. Components are stored in one collection and discriminated by `component_type`.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"chart_type":    {Type: "string", Description: "Filter by chart subtype (bar, line, etc)"},
					"connection_id": {Type: "string", Description: "Filter by connection ID"},
					"tag":           {Type: "string", Description: "Filter by tag"},
				},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			if r.toolops != nil {
				return r.toolops.ListComponents(context.Background(), toolops.ListComponentsInput{
					ChartType:    getString(args, "chart_type"),
					ConnectionID: getString(args, "connection_id"),
					Tag:          getString(args, "tag"),
				})
			}
			params := models.ComponentQueryParams{
				Page:         1,
				PageSize:     100,
				ChartType:    getString(args, "chart_type"),
				ConnectionID: getString(args, "connection_id"),
				Tag:          getString(args, "tag"),
			}
			result, err := r.componentService.ListComponents(context.Background(), params)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"components": result.Components, "count": result.Total}, nil
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
		func(args map[string]interface{}) (interface{}, error) {
			return r.componentService.GetComponent(context.Background(), getString(args, "id"))
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
		func(args map[string]interface{}) (interface{}, error) {
			limit := int64(50)
			if l := getInt(args, "limit"); l > 0 {
				limit = int64(l)
			}
			return r.componentService.GetComponentSummaries(context.Background(), limit)
		},
	)

	r.registerTool(
		Tool{
			Name:        "create_component",
			Description: "Create a new component. Set `component_type` to chart, control, or display. Charts need `chart_type`, `connection_id`, `query_config`, and `data_mapping` (call list_chart_types first). Controls need `control_config` with `control_type` (call list_control_types). Displays need `display_config` with `display_type` (call list_display_types).",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"name":            {Type: "string", Description: "Unique component name (must be unique within the target namespace)"},
					"description":     {Type: "string", Description: "Description"},
					"namespace":       {Type: "string", Description: "Target namespace. Must equal the runtime context's target namespace; omit to default to \"default\"."},
					"component_type":  {Type: "string", Description: "chart | control | display", Enum: []string{"chart", "control", "display"}},
					"chart_type":      {Type: "string", Description: "Chart subtype (bar, line, pie, etc) — for chart components"},
					"connection_id":   {Type: "string", Description: "Connection ID for data binding"},
					"query_config":    {Type: "object", Description: "Query: {raw, type, params}"},
					"data_mapping":    {Type: "object", Description: "Data mapping: {x_axis, y_axis, group_by, filters, aggregation, ...}. For chart_type 'banded_bar' set band_columns: {scheme: \"sd\"|\"minmaxmean\"|\"spc\", and the columns for that scheme — sd: mean + plus_1sd/minus_1sd/plus_2sd/minus_2sd; minmaxmean: mean + min/max; spc: target + lower_control/upper_control/lower_limit/upper_limit}. Each row carries its own band values; the center column is required."},
					"control_config":  {Type: "object", Description: "Control config: {control_type, device_type_id, target, ui_config}"},
					"display_config":  {Type: "object", Description: "Display config: {display_type, ...display-specific fields}"},
					"component_code":  {Type: "string", Description: "React component code (for chart_type=custom or use_custom_code=true)"},
					"use_custom_code": {Type: "boolean", Description: "Render via custom React code instead of ECharts options"},
					"options":                {Type: "object", Description: "ECharts options overrides"},
					"tags":                   {Type: "array", Description: "Tags"},
					"uses_dashboard_variable": {Type: "boolean", Description: "Marks this component as accepting dashboard-variable substitution (the {{dashboard-variable}} token in its query or a filter value)."},
				},
				Required: []string{"name"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			req := &models.CreateComponentRequest{
				Name:          getString(args, "name"),
				Description:   getString(args, "description"),
				Namespace:     getString(args, "namespace"),
				ComponentType: getString(args, "component_type"),
				ChartType:     getString(args, "chart_type"),
				ConnectionID:  getString(args, "connection_id"),
				ComponentCode: getString(args, "component_code"),
				UseCustomCode: getBool(args, "use_custom_code"),
				UsesDashboardVariable: getBool(args, "uses_dashboard_variable"),
			}
			if qc, ok := args["query_config"].(map[string]interface{}); ok {
				req.QueryConfig = parseQueryConfig(qc)
			}
			if dm, ok := args["data_mapping"].(map[string]interface{}); ok {
				req.DataMapping = parseDataMapping(dm)
			}
			if cc, ok := args["control_config"].(map[string]interface{}); ok {
				req.ControlConfig = parseControlConfig(cc)
			}
			if dc, ok := args["display_config"].(map[string]interface{}); ok {
				req.DisplayConfig = parseDisplayConfig(dc)
			}
			if opts, ok := args["options"].(map[string]interface{}); ok {
				req.Options = opts
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			out, err := r.componentService.CreateComponent(context.Background(), req)
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
					"id":              {Type: "string", Description: "Component ID"},
					"name":            {Type: "string", Description: "New name"},
					"description":     {Type: "string", Description: "New description"},
					"chart_type":      {Type: "string", Description: "New chart subtype"},
					"connection_id":   {Type: "string", Description: "New connection ID"},
					"query_config":    {Type: "object", Description: "New query config"},
					"data_mapping":    {Type: "object", Description: "New data mapping. For chart_type 'banded_bar' include band_columns (see create_component's data_mapping description for the per-scheme keys)."},
					"control_config":  {Type: "object", Description: "New control config"},
					"display_config":  {Type: "object", Description: "New display config"},
					"component_code":  {Type: "string", Description: "New component code. Last-resort field — prefer changing data_mapping / options / chart_type instead. Setting this with use_custom_code=true freezes the chart at this code; subsequent config tool calls won't update the rendering."},
					"use_custom_code": {Type: "boolean", Description: "New custom-code flag. Setting true is destructive and one-way (per the description above). Only enable when configuration fields can't express the request."},
					"options":                {Type: "object", Description: "New options"},
					"tags":                   {Type: "array", Description: "New tags"},
					"uses_dashboard_variable": {Type: "boolean", Description: "Marks this component as accepting dashboard-variable substitution: the {{dashboard-variable}} token may appear in its query (substituted server-side as a bound param) or in a client-side filter value (substituted at view time). Drives the editor's substitution UI hints."},
				},
				Required: []string{"id"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateComponentRequest{}
			if name := getString(args, "name"); name != "" {
				req.Name = &name
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
			if qc, ok := args["query_config"].(map[string]interface{}); ok {
				req.QueryConfig = parseQueryConfig(qc)
			}
			if dm, ok := args["data_mapping"].(map[string]interface{}); ok {
				req.DataMapping = parseDataMapping(dm)
			}
			if cc, ok := args["control_config"].(map[string]interface{}); ok {
				req.ControlConfig = parseControlConfig(cc)
			}
			if dc, ok := args["display_config"].(map[string]interface{}); ok {
				req.DisplayConfig = parseDisplayConfig(dc)
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
			out, err := r.componentService.UpdateComponent(context.Background(), id, req)
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
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if _, err := r.componentService.DeleteComponent(context.Background(), id); err != nil {
				return nil, err
			}
			return map[string]interface{}{"success": true, "message": fmt.Sprintf("Component %s deleted", id)}, nil
		},
	)

	r.registerTool(
		Tool{
			Name:        "list_dashboards_using_component",
			Description: "Find every dashboard that references a specific component. Useful before deleting a component to see what would break.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"component_id": {Type: "string", Description: "Component ID"},
				},
				Required: []string{"component_id"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			params := models.DashboardQueryParams{
				ComponentID: getString(args, "component_id"),
				Page:        1,
				PageSize:    100,
			}
			result, err := r.dashboardService.ListDashboards(context.Background(), params)
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"dashboards": result.Dashboards, "count": result.Total}, nil
		},
	)

	r.registerTool(
		Tool{
			Name: "get_component_template",
			Description: "Return the custom-code starting template — a freeform React/ECharts skeleton with Carbon g100 styling, the CARBON_COLORS palette, and the viewer's data helpers (toObjects, getValue, formatTimestamp, formatCellValue — do not import them) already wired. ONLY for hand-written custom code: set use_custom_code=true and pass the filled-in code in update_component's `component_code` field. The canonical chart types (line, bar, area, pie, scatter, gauge, number, dataview, banded_bar) are spec-driven — configure them via create_component / update_component structured fields (chart_type + data_mapping + options); do NOT fetch a template and hand-write code for them. There is exactly one template, 'custom'.",
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
		func(args map[string]interface{}) (interface{}, error) {
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
			Description: "List all dashboards.",
			InputSchema: InputSchema{
				Type:       "object",
				Properties: map[string]PropertySchema{},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			if r.toolops != nil {
				return r.toolops.ListDashboards(context.Background())
			}
			result, err := r.dashboardService.ListDashboards(context.Background(), models.DashboardQueryParams{Page: 1, PageSize: 100})
			if err != nil {
				return nil, err
			}
			return map[string]interface{}{"dashboards": result.Dashboards, "count": result.Total}, nil
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
		func(args map[string]interface{}) (interface{}, error) {
			return r.dashboardService.GetDashboard(context.Background(), getString(args, "id"))
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
					"panels":      {Type: "array", Description: "Array of panel objects. Each panel is {id, x, y, w, h, and exactly one of: component_id (reference an existing component), text_config (inline text — see tool description for schema), or neither (empty placeholder)}."},
					"settings":    {Type: "object", Description: "Dashboard settings: theme, refresh_interval (ms), timezone, layout_dimension, title_scale, scale_percent, is_public, allow_export. Dashboard variables: set variables_enabled=true and variables=[{name, label, mode, ...}] where mode is connection_swap | filter | range. filter variables substitute the {{dashboard-variable}} token in component queries; range variables substitute {{range-variable}} (written as `<column> {{range-variable}}`). See the dashboard-builder prompt's \"Dashboard variables\" section for the full shape and authoring contract."},
					"tags":        {Type: "array", Description: "Tags"},
				},
				Required: []string{"name"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			req := &models.CreateDashboardRequest{
				Name:        getString(args, "name"),
				Description: getString(args, "description"),
				Namespace:   getString(args, "namespace"),
			}
			if panelsRaw, ok := args["panels"].([]interface{}); ok {
				req.Panels = parsePanels(panelsRaw)
			}
			if settingsRaw, ok := args["settings"].(map[string]interface{}); ok {
				req.Settings = parseSettings(settingsRaw)
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				req.Tags = parseStringArray(tagsRaw)
			}
			return r.dashboardService.CreateDashboard(context.Background(), req)
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
					"panels":      {Type: "array", Description: "New panel array (replaces existing). Each panel is {id, x, y, w, h, and exactly one of: component_id, text_config, or neither}. See create_dashboard for text_config schema."},
					"settings":    {Type: "object", Description: "New settings (same shape as create_dashboard, including variables_enabled + variables[] for dashboard variables). Replaces the whole settings object — fetch the dashboard first if you only want to add variables to existing settings."},
					"tags":        {Type: "array", Description: "New tags"},
				},
				Required: []string{"id"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			req := &models.UpdateDashboardRequest{}
			if name := getString(args, "name"); name != "" {
				req.Name = &name
			}
			if desc := getString(args, "description"); desc != "" {
				req.Description = &desc
			}
			if panelsRaw, ok := args["panels"].([]interface{}); ok {
				panels := parsePanels(panelsRaw)
				req.Panels = &panels
			}
			if settingsRaw, ok := args["settings"].(map[string]interface{}); ok {
				settings := parseSettings(settingsRaw)
				req.Settings = &settings
			}
			if tagsRaw, ok := args["tags"].([]interface{}); ok {
				tags := parseStringArray(tagsRaw)
				req.Tags = &tags
			}
			return r.dashboardService.UpdateDashboard(context.Background(), id, req)
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
		func(args map[string]interface{}) (interface{}, error) {
			id := getString(args, "id")
			if err := r.dashboardService.DeleteDashboard(context.Background(), id); err != nil {
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
		"id":              c.ID,
		"version":         c.Version,
		"status":          c.Status,
		"component_type":  c.ComponentType,
		"namespace":       c.Namespace,
		"name":            c.Name,
		"title":           c.Title,
		"chart_type":      c.ChartType,
		"connection_id":   c.ConnectionID,
		"use_custom_code": c.UseCustomCode,
		"component_code_length": len(c.ComponentCode),
		"created":         c.Created,
		"updated":         c.Updated,
	}
}

func getMap(m map[string]interface{}, key string) map[string]interface{} {
	if v, ok := m[key].(map[string]interface{}); ok {
		return v
	}
	return nil
}

func parseConnectionConfig(dsType models.ConnectionType, configMap map[string]interface{}) models.ConnectionConfig {
	config := models.ConnectionConfig{}
	switch dsType {
	case models.ConnectionTypeAPI:
		config.API = &models.APIConfig{
			URL:     getString(configMap, "url"),
			Method:  getString(configMap, "method"),
			Timeout: getInt(configMap, "timeout"),
		}
		if headers, ok := configMap["headers"].(map[string]interface{}); ok {
			config.API.Headers = make(map[string]string)
			for k, v := range headers {
				if s, ok := v.(string); ok {
					config.API.Headers[k] = s
				}
			}
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
		config.Socket = &models.SocketConfig{
			URL:      getString(configMap, "url"),
			Protocol: getString(configMap, "protocol"),
		}
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

func parsePanels(panelsRaw []interface{}) []models.DashboardPanel {
	panels := make([]models.DashboardPanel, 0, len(panelsRaw))
	for _, p := range panelsRaw {
		if pm, ok := p.(map[string]interface{}); ok {
			panel := models.DashboardPanel{
				ID:          getString(pm, "id"),
				X:           getInt(pm, "x"),
				Y:           getInt(pm, "y"),
				W:           getInt(pm, "w"),
				H:           getInt(pm, "h"),
				ComponentID: getString(pm, "component_id"),
			}
			if tc, ok := pm["text_config"].(map[string]interface{}); ok {
				panel.TextConfig = &models.PanelTextConfig{
					Content:        getString(tc, "content"),
					DisplayContent: getString(tc, "display_content"),
					Size:           tc["size"],
					Align:          getString(tc, "align"),
				}
			}
			panels = append(panels, panel)
		}
	}
	return panels
}

func parseSettings(settingsRaw map[string]interface{}) models.DashboardSettings {
	s := models.DashboardSettings{
		Theme:            getString(settingsRaw, "theme"),
		RefreshInterval:  getInt(settingsRaw, "refresh_interval"),
		TimeZone:         getString(settingsRaw, "timezone"),
		DefaultView:      getString(settingsRaw, "default_view"),
		IsPublic:         getBool(settingsRaw, "is_public"),
		AllowExport:      getBool(settingsRaw, "allow_export"),
		LayoutDimension:  getString(settingsRaw, "layout_dimension"),
		TitleScale:       getInt(settingsRaw, "title_scale"),
		ScalePercent:     getInt(settingsRaw, "scale_percent"),
		VariablesEnabled: getBool(settingsRaw, "variables_enabled"),
	}
	if varsRaw, ok := settingsRaw["variables"].([]interface{}); ok {
		s.Variables = parseDashboardVariables(varsRaw)
	}
	return s
}

// parseDashboardVariables maps the loosely-typed settings.variables[] payload
// onto the model. Mirrors the chat assistant's schema; the substitution tokens
// ({{dashboard-variable}}, {{range-variable}}) are authored into component
// queries, not here.
func parseDashboardVariables(arr []interface{}) []models.DashboardVariable {
	vars := make([]models.DashboardVariable, 0, len(arr))
	for _, item := range arr {
		raw, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		v := models.DashboardVariable{
			Name:  getString(raw, "name"),
			Label: getString(raw, "label"),
			Mode:  getString(raw, "mode"),
		}
		if cs := getMap(raw, "connection_swap"); cs != nil {
			cfg := &models.ConnectionSwapConfig{
				SchemaStrict:   getString(cs, "schema_strict"),
				SameNamespace:  getBool(cs, "same_namespace"),
				LabelTagPrefix: getString(cs, "label_tag_prefix"),
			}
			if tagsRaw, ok := cs["tags"].([]interface{}); ok {
				cfg.Tags = parseStringArray(tagsRaw)
			}
			v.ConnectionSwap = cfg
		}
		if fv := getMap(raw, "filter"); fv != nil {
			cfg := &models.FilterValueConfig{
				ValueSource:  getString(fv, "value_source"),
				DefaultValue: getString(fv, "default_value"),
				ValueColumn:  getString(fv, "value_column"),
				ValueTable:   getString(fv, "value_table"),
			}
			if optsRaw, ok := fv["options"].([]interface{}); ok {
				cfg.Options = parseStringArray(optsRaw)
			}
			v.FilterValue = cfg
		}
		if rg := getMap(raw, "range"); rg != nil {
			cfg := &models.RangeConfig{
				DefaultPreset: getString(rg, "default_preset"),
			}
			if presetsRaw, ok := rg["presets"].([]interface{}); ok {
				cfg.Presets = parseStringArray(presetsRaw)
			}
			if allow, ok := rg["allow_absolute"].(bool); ok {
				cfg.AllowAbsolute = &allow
			}
			v.Range = cfg
		}
		vars = append(vars, v)
	}
	return vars
}

func parseQueryConfig(qc map[string]interface{}) *models.ChartQueryConfig {
	return &models.ChartQueryConfig{
		Raw:    getString(qc, "raw"),
		Type:   getString(qc, "type"),
		Params: getMap(qc, "params"),
	}
}

func parseDataMapping(dm map[string]interface{}) *models.ChartDataMapping {
	mapping := &models.ChartDataMapping{
		XAxis:     getString(dm, "x_axis"),
		GroupBy:   getString(dm, "group_by"),
		LabelCol:  getString(dm, "label_col"),
		SortBy:    getString(dm, "sort_by"),
		SortOrder: getString(dm, "sort_order"),
		Limit:     getInt(dm, "limit"),
	}
	if yAxisRaw, ok := dm["y_axis"].([]interface{}); ok {
		mapping.YAxis = parseStringArray(yAxisRaw)
	}
	if filtersRaw, ok := dm["filters"].([]interface{}); ok {
		filters := make([]models.DataFilter, 0, len(filtersRaw))
		for _, f := range filtersRaw {
			if fm, ok := f.(map[string]interface{}); ok {
				filters = append(filters, models.DataFilter{
					Field: getString(fm, "field"),
					Op:    getString(fm, "op"),
					Value: fm["value"],
				})
			}
		}
		mapping.Filters = filters
	}
	if aggRaw, ok := dm["aggregation"].(map[string]interface{}); ok {
		mapping.Aggregation = &models.DataAggregation{
			Type:   getString(aggRaw, "type"),
			SortBy: getString(aggRaw, "sort_by"),
			Field:  getString(aggRaw, "field"),
			Count:  getInt(aggRaw, "count"),
		}
	}
	if bandsRaw, ok := dm["band_columns"].(map[string]interface{}); ok {
		mapping.BandColumns = parseBandColumns(bandsRaw)
	}
	return mapping
}

// parseBandColumns maps the loosely-typed band_columns payload onto the model.
// Only chart_type "banded_bar" consumes it; ignored on other chart types. The
// three schemes (sd / minmaxmean / spc) share this flat struct — only the keys
// for the chosen scheme are populated. Mirrors the Component-agent schema in
// internal/ai/tools.go and the Chat schema in chartDataMappingSchema.
func parseBandColumns(b map[string]interface{}) *models.BandColumns {
	return &models.BandColumns{
		Scheme:       getString(b, "scheme"),
		Mean:         getString(b, "mean"),
		Plus1SD:      getString(b, "plus_1sd"),
		Minus1SD:     getString(b, "minus_1sd"),
		Plus2SD:      getString(b, "plus_2sd"),
		Minus2SD:     getString(b, "minus_2sd"),
		Min:          getString(b, "min"),
		Max:          getString(b, "max"),
		Target:       getString(b, "target"),
		LowerControl: getString(b, "lower_control"),
		UpperControl: getString(b, "upper_control"),
		LowerLimit:   getString(b, "lower_limit"),
		UpperLimit:   getString(b, "upper_limit"),
	}
}

func parseControlConfig(cc map[string]interface{}) *models.ControlConfig {
	out := &models.ControlConfig{
		ControlType:  getString(cc, "control_type"),
		DeviceTypeID: getString(cc, "device_type_id"),
		Target:       getString(cc, "target"),
	}
	if ui, ok := cc["ui_config"].(map[string]interface{}); ok {
		out.UIConfig = ui
	}
	return out
}

func parseDisplayConfig(dc map[string]interface{}) *models.DisplayConfig {
	return &models.DisplayConfig{
		DisplayType:         getString(dc, "display_type"),
		FrigateConnectionID: getString(dc, "frigate_connection_id"),
		DefaultCamera:       getString(dc, "default_camera"),
		MqttConnectionID:    getString(dc, "mqtt_connection_id"),
		AlertTopic:          getString(dc, "alert_topic"),
		SnapshotInterval:    getInt(dc, "snapshot_interval"),
		MaxThumbnails:       getInt(dc, "max_thumbnails"),
		AlertSeverity:       getString(dc, "alert_severity"),
		WeatherTopicPrefix:  getString(dc, "weather_topic_prefix"),
		WeatherLocation:     getString(dc, "weather_location"),
	}
}

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
