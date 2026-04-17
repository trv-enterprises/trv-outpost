// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"github.com/anthropics/anthropic-sdk-go"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// GetAnthropicTools returns the list of tools available to the AI agent in
// Anthropic SDK format. When `cat` is supplied, the chart_type and
// control_type enums are derived from the filtered catalog so the AI can't
// even propose a disabled type as a tool argument. Pass nil for a fully
// permissive tool set (used as a fallback when no catalog is available).
func GetAnthropicTools(cat *registry.Catalog) []anthropic.ToolUnionParam {
	controlEnum := controlTypeEnum(cat)
	chartEnum := chartTypeEnum(cat)
	templateEnum := chartTemplateEnum(cat)

	toolParams := []anthropic.ToolParam{
		{
			Name:        "update_component_type",
			Description: anthropic.String("Set the component type for the current draft. Call this first when creating a control or display component. For charts, this is set automatically."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"component_type": map[string]interface{}{
						"type":        "string",
						"description": "Component type",
						"enum":        []string{"chart", "control", "display"},
					},
				},
				Required: []string{"component_type"},
			},
		},
		{
			Name:        "update_control_config",
			Description: anthropic.String(`Configure a control component. Sets the control type, connection, target device, command configuration, and UI settings.

Control types and their UI config:
- button: { label, kind (primary/secondary/danger/ghost) }
- toggle: { label, offLabel }
- slider: { label, min, max, step }
- text_input: { label, placeholder, submitLabel }
- switch: { label, onLabel, offLabel } — on/off switch with HomeKit-style pill
- dimmer: { label, min, max, step }
- garage_door: { label, state_field (default: "contact") } — full-size animated read-only garage door status
- tile_garage_door: { label, state_field (default: "contact") } — read-only garage door status tile`),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"control_type": map[string]interface{}{
						"type":        "string",
						"description": "Type of control",
						"enum":        controlEnum,
					},
					"connection_id": map[string]interface{}{"type": "string", "description": "ID of the connection to send commands through (e.g., MQTT, WebSocket)"},
					"target": map[string]interface{}{"type": "string", "description": "Device or endpoint identifier for command targeting"},
					"device_type_id": map[string]interface{}{"type": "string", "description": "Reference to a device type for template-based command generation"},
					"command_action": map[string]interface{}{"type": "string", "description": "Command action name (e.g., 'set_power', 'set_level', 'send')"},
					"command_target": map[string]interface{}{"type": "string", "description": "Command target identifier"},
					"payload_template": map[string]interface{}{"type": "object", "description": "Payload template with {{value}} placeholder for dynamic values"},
					"ui_config": map[string]interface{}{"type": "object", "description": "Type-specific UI configuration (label, min, max, step, kind, etc.)"},
				},
				Required: []string{"control_type"},
			},
		},
		{
			Name:        "update_component_config",
			Description: anthropic.String("Update basic component configuration like title, description and chart type. Note: Component name is set by the user when saving, do NOT try to set the name."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"title":       map[string]interface{}{"type": "string", "description": "Display title shown at the top of the chart on dashboards. Use a concise human-readable title (e.g., 'CPU Utilization') — this is what users see, NOT the internal name."},
					"description": map[string]interface{}{"type": "string", "description": "Component description"},
					"chart_type": map[string]interface{}{
						"type":        "string",
						"description": "Type of chart (only for chart components)",
						"enum":        chartEnum,
					},
				},
			},
		},
		{
			Name:        "update_data_mapping",
			Description: anthropic.String("Configure how data maps to chart axes and series"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"datasource_id":  map[string]interface{}{"type": "string", "description": "ID of the connection to use"},
					"x_axis":         map[string]interface{}{"type": "string", "description": "Column for X axis"},
					"x_axis_label":   map[string]interface{}{"type": "string", "description": "Label for X axis"},
					"x_axis_format":  map[string]interface{}{"type": "string", "description": "Format for X axis values"},
					"y_axis":         map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Columns for Y axis"},
					"y_axis_label":   map[string]interface{}{"type": "string", "description": "Legacy single Y-axis label. Prefer y_axis_labels (plural, one per y column). For two y-columns they split left/right; for 3+ y-columns omit y_axis_labels entirely — the legend carries series identity."},
					"y_axis_labels":  map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Per-column Y-axis labels; [0] goes on the left axis, [1] on the right axis for dual-axis charts. Omit for 3+ y columns."},
					"group_by":       map[string]interface{}{"type": "string", "description": "Column to group data by"},
				},
			},
		},
		{
			Name:        "update_query_config",
			Description: anthropic.String("Update the query configuration for data retrieval"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"query":            map[string]interface{}{"type": "string", "description": "The query string (SQL, API path, PromQL, etc.)"},
					"query_type":       map[string]interface{}{"type": "string", "description": "Type of query", "enum": []string{"sql", "api", "csv_filter", "stream_filter", "prometheus", "edgelake"}},
					"refresh_interval": map[string]interface{}{"type": "integer", "description": "Auto-refresh interval in milliseconds (0 for no refresh)"},
					"prometheus_params": map[string]interface{}{
						"type":        "object",
						"description": "Prometheus-specific query parameters (only for prometheus query_type)",
						"properties": map[string]interface{}{
							"query_type": map[string]interface{}{"type": "string", "description": "Prometheus query type", "enum": []string{"instant", "range"}},
							"start":      map[string]interface{}{"type": "string", "description": "Start time (RFC3339 or relative like 'now-1h')"},
							"end":        map[string]interface{}{"type": "string", "description": "End time (RFC3339 or relative like 'now')"},
							"step":       map[string]interface{}{"type": "string", "description": "Query resolution step (e.g., '15s', '1m', '5m')"},
						},
					},
					"edgelake_params": map[string]interface{}{
						"type":        "object",
						"description": "EdgeLake-specific query parameters (only for edgelake query_type)",
						"properties": map[string]interface{}{
							"database": map[string]interface{}{"type": "string", "description": "Database name (REQUIRED for EdgeLake queries)"},
						},
						"required": []string{"database"},
					},
				},
			},
		},
		{
			Name:        "update_filters",
			Description: anthropic.String("Add or update data filters"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"filters": map[string]interface{}{
						"type": "array",
						"items": map[string]interface{}{
							"type": "object",
							"properties": map[string]interface{}{
								"field": map[string]interface{}{"type": "string"},
								"op":    map[string]interface{}{"type": "string", "enum": []string{"eq", "neq", "gt", "gte", "lt", "lte", "contains", "in"}},
								"value": map[string]interface{}{},
							},
						},
						"description": "Array of filter objects",
					},
				},
			},
		},
		{
			Name:        "update_aggregation",
			Description: anthropic.String("Configure data aggregation"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"type":    map[string]interface{}{"type": "string", "description": "Aggregation type", "enum": []string{"first", "last", "min", "max", "avg", "sum", "count", "limit"}},
					"field":   map[string]interface{}{"type": "string", "description": "Field to aggregate"},
					"sort_by": map[string]interface{}{"type": "string", "description": "Field to sort by (for first/last)"},
					"count":   map[string]interface{}{"type": "integer", "description": "Row count (for limit)"},
				},
			},
		},
		{
			Name:        "update_sliding_window",
			Description: anthropic.String("Configure a time-based sliding window to show only recent data. Essential for streaming/real-time charts to prevent unbounded data growth."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"duration":      map[string]interface{}{"type": "integer", "description": "Window duration in seconds (e.g., 300 for last 5 minutes, 3600 for last hour)"},
					"timestamp_col": map[string]interface{}{"type": "string", "description": "Name of the timestamp column in the data"},
				},
				Required: []string{"duration", "timestamp_col"},
			},
		},
		{
			Name:        "update_time_bucket",
			Description: anthropic.String("Configure time-bucketed aggregation for streaming data. Aggregates raw streaming data into time buckets (e.g., 1-minute averages). Only works with socket/streaming data sources."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"interval":      map[string]interface{}{"type": "integer", "description": "Bucket interval in seconds (e.g., 60 for 1-minute buckets, 3600 for hourly)"},
					"function":      map[string]interface{}{"type": "string", "description": "Aggregation function", "enum": []string{"avg", "min", "max", "sum", "count"}},
					"value_cols":    map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Columns to aggregate (numeric values)"},
					"timestamp_col": map[string]interface{}{"type": "string", "description": "Column containing timestamps for bucket alignment"},
				},
				Required: []string{"interval", "function", "value_cols", "timestamp_col"},
			},
		},
		{
			Name:        "set_custom_code",
			Description: anthropic.String("Enable custom code mode and set React component code. Use this for complex components not supported by standard config."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"component_code": map[string]interface{}{"type": "string", "description": "Full React component code"},
				},
				Required: []string{"component_code"},
			},
		},
		{
			Name:        "update_chart_options",
			Description: anthropic.String("Update ECharts-specific options for the chart"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"title":            map[string]interface{}{"type": "string", "description": "Chart title displayed on the chart"},
					"show_legend":      map[string]interface{}{"type": "boolean", "description": "Whether to show the legend"},
					"legend_position":  map[string]interface{}{"type": "string", "description": "Legend position", "enum": []string{"top", "bottom", "left", "right"}},
					"show_tooltip":     map[string]interface{}{"type": "boolean", "description": "Whether to show tooltips on hover"},
					"color_palette":    map[string]interface{}{"type": "array", "items": map[string]interface{}{"type": "string"}, "description": "Array of color hex codes for series"},
					"stack_series":     map[string]interface{}{"type": "boolean", "description": "Whether to stack series (bar/area charts)"},
					"smooth_lines":     map[string]interface{}{"type": "boolean", "description": "Whether to smooth line charts"},
					"show_data_labels": map[string]interface{}{"type": "boolean", "description": "Whether to show data labels on chart"},
				},
			},
		},
		{
			Name:        "query_connection",
			Description: anthropic.String("Execute a test query against a connection to see sample data"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"connection_id": map[string]interface{}{"type": "string", "description": "ID of the connection"},
					"query":         map[string]interface{}{"type": "string", "description": "Query to execute (SQL, filter, etc.)"},
					"limit":         map[string]interface{}{"type": "integer", "description": "Maximum rows to return", "default": 10},
				},
				Required: []string{"connection_id"},
			},
		},
		{
			Name:        "list_connections",
			Description: anthropic.String("List all available connections with their types and descriptions"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{},
			},
		},
		{
			Name:        "list_device_types",
			Description: anthropic.String("List all available device types. Device types define how controls communicate with devices (command templates, value mappings, etc.). REQUIRED when creating controls - you must set device_type_id to match the target device."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{},
			},
		},
		{
			Name: "get_schema",
			Description: anthropic.String(`Get the schema for a connection including column names, types, and unique values.
Works for all connection types (SQL, Prometheus, EdgeLake, API, CSV, Socket, TSStore).

Returns:
- Column names and inferred types (timestamp, integer, float, string, boolean)
- Unique values for categorical string columns (if ≤20 distinct values)
- Min/max for numeric columns
- Row count when available

For SQL and EdgeLake: Returns tables with columns
For Prometheus: Returns metrics and labels
For API/CSV/Socket: Infers schema from sample data
For TSStore: Infers schema from sample data (works with both rest and streaming transport modes)

Use this BEFORE configuring data mapping to understand the data structure.`),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"connection_id": map[string]interface{}{"type": "string", "description": "ID of the connection"},
					"table":         map[string]interface{}{"type": "string", "description": "Table name (optional, for SQL/EdgeLake when you want columns for a specific table)"},
					"database":      map[string]interface{}{"type": "string", "description": "Database name (optional, for EdgeLake)"},
				},
				Required: []string{"connection_id"},
			},
		},
		{
			Name:        "get_datasource_schema",
			Description: anthropic.String("DEPRECATED: Use get_schema instead. Get the schema (tables and columns) for a SQL database data source."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"datasource_id": map[string]interface{}{"type": "string", "description": "ID of the SQL data source"},
				},
				Required: []string{"datasource_id"},
			},
		},
		{
			Name:        "get_prometheus_schema",
			Description: anthropic.String("DEPRECATED: Use get_schema instead. Get available metrics and labels from a Prometheus data source."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"datasource_id": map[string]interface{}{"type": "string", "description": "ID of the Prometheus data source"},
				},
				Required: []string{"datasource_id"},
			},
		},
		{
			Name:        "get_edgelake_schema",
			Description: anthropic.String("DEPRECATED: Use get_schema instead. Get available databases, tables, and columns from an EdgeLake data source."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"datasource_id": map[string]interface{}{"type": "string", "description": "ID of the EdgeLake data source"},
					"database":      map[string]interface{}{"type": "string", "description": "Database name (optional - if omitted, returns list of databases)"},
					"table":         map[string]interface{}{"type": "string", "description": "Table name (optional - if omitted with database, returns list of tables)"},
				},
				Required: []string{"datasource_id"},
			},
		},
		{
			Name:        "preview_data",
			Description: anthropic.String("Get sample data for the current component configuration"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"limit": map[string]interface{}{"type": "integer", "description": "Maximum rows to return", "default": 10},
				},
			},
		},
		{
			Name:        "get_component_state",
			Description: anthropic.String("Get the current state of the component being edited"),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{},
			},
		},
		{
			Name: "get_component_template",
			Description: anthropic.String(`Get a React component template for a chart type.
Call AFTER setting chart_type with update_component_config.
Returns Carbon g100 dark theme styled code to customize with your column names.
For non-standard charts, use "custom" to get general formatting guidelines and color tokens.`),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"chart_type": map[string]interface{}{
						"type":        "string",
						"description": "Chart type to get template for",
						"enum":        templateEnum,
					},
				},
				Required: []string{"chart_type"},
			},
		},
		{
			Name:        "suggest_missing_tools",
			Description: anthropic.String("DEPRECATED: Use set_custom_code to implement custom visualizations instead."),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: map[string]interface{}{
					"feature":    map[string]interface{}{"type": "string", "description": "The ECharts feature being requested"},
					"suggestion": map[string]interface{}{"type": "string", "description": "Explanation of what tools/config would need to be added"},
				},
				Required: []string{"feature", "suggestion"},
			},
		},
	}

	// Convert to ToolUnionParam
	tools := make([]anthropic.ToolUnionParam, len(toolParams))
	for i := range toolParams {
		tools[i] = anthropic.ToolUnionParam{OfTool: &toolParams[i]}
	}

	return tools
}

// ToolName constants for easier reference
const (
	ToolUpdateComponentType   = "update_component_type"
	ToolUpdateControlConfig   = "update_control_config"
	ToolUpdateComponentConfig = "update_component_config"
	ToolUpdateDataMapping     = "update_data_mapping"
	ToolUpdateQueryConfig     = "update_query_config"
	ToolUpdateFilters         = "update_filters"
	ToolUpdateAggregation     = "update_aggregation"
	ToolUpdateSlidingWindow   = "update_sliding_window"
	ToolUpdateTimeBucket      = "update_time_bucket"
	ToolSetCustomCode         = "set_custom_code"
	ToolUpdateChartOptions    = "update_chart_options"
	ToolQueryConnection       = "query_connection"
	ToolListConnections       = "list_connections"
	ToolGetSchema             = "get_schema"
	ToolGetDatasourceSchema   = "get_datasource_schema"   // Deprecated
	ToolGetPrometheusSchema   = "get_prometheus_schema"   // Deprecated
	ToolGetEdgeLakeSchema     = "get_edgelake_schema"     // Deprecated
	ToolListDeviceTypes       = "list_device_types"
	ToolPreviewData           = "preview_data"
	ToolGetComponentState     = "get_component_state"
	ToolGetComponentTemplate  = "get_component_template"
	ToolSuggestMissing        = "suggest_missing_tools" // Deprecated
)

// controlTypeEnum returns the control_type enum derived from the catalog,
// or the historical full list when no catalog is supplied.
func controlTypeEnum(cat *registry.Catalog) []string {
	if cat == nil {
		return []string{"button", "toggle", "slider", "text_input", "switch", "dimmer", "garage_door", "tile_switch", "tile_dimmer", "tile_garage_door", "text_label"}
	}
	out := make([]string, 0, len(cat.ControlTypes))
	for _, t := range cat.ControlTypes {
		if t.Hidden {
			continue
		}
		out = append(out, t.Subtype)
	}
	if len(out) == 0 {
		// Defensive: never emit an empty enum (some Anthropic tool validators
		// reject zero-length enums). Fall back to a single sentinel.
		return []string{"button"}
	}
	return out
}

// chartTypeEnum returns the chart_type enum for update_component_config.
func chartTypeEnum(cat *registry.Catalog) []string {
	if cat == nil {
		return []string{"bar", "line", "area", "pie", "scatter", "gauge", "heatmap", "radar", "funnel", "dataview", "custom"}
	}
	out := make([]string, 0, len(cat.ChartTypes))
	for _, t := range cat.ChartTypes {
		if t.Hidden {
			continue
		}
		out = append(out, t.Subtype)
	}
	if len(out) == 0 {
		return []string{"custom"}
	}
	return out
}

// chartTemplateEnum returns the chart_type enum for get_component_template.
// Same set as chartTypeEnum today, but isolated so we can diverge if needed.
func chartTemplateEnum(cat *registry.Catalog) []string {
	return chartTypeEnum(cat)
}

// IsComponentUpdateTool returns true if the tool modifies the component
func IsComponentUpdateTool(toolName string) bool {
	switch toolName {
	case ToolUpdateComponentType, ToolUpdateControlConfig,
		ToolUpdateComponentConfig, ToolUpdateDataMapping, ToolUpdateQueryConfig,
		ToolUpdateFilters, ToolUpdateAggregation, ToolUpdateSlidingWindow, ToolUpdateTimeBucket, ToolSetCustomCode, ToolUpdateChartOptions:
		return true
	default:
		return false
	}
}
