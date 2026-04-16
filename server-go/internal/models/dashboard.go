// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"time"
)

// PanelTextConfig holds configuration for native text panels (no component needed)
// @Description Configuration for native text panels — section headers, date/time, titles
type PanelTextConfig struct {
	Content        string      `json:"content,omitempty" bson:"content,omitempty"`                 // Static text (used when display_content="title")
	DisplayContent string      `json:"display_content,omitempty" bson:"display_content,omitempty"` // "title", "date_short", "time_12", etc.
	Size           interface{} `json:"size,omitempty" bson:"size,omitempty"`                       // Font size in pixels (int) or legacy name (string)
	Align          string      `json:"align,omitempty" bson:"align,omitempty"`                     // "left", "center", "right"
}

// DashboardPanel represents a panel position in the dashboard grid
// @Description Panel position and size in the grid with optional chart reference or text config
type DashboardPanel struct {
	ID         string           `json:"id" bson:"id"`
	X          int              `json:"x" bson:"x"`
	Y          int              `json:"y" bson:"y"`
	W          int              `json:"w" bson:"w"`
	H          int              `json:"h" bson:"h"`
	ChartID    string           `json:"chart_id,omitempty" bson:"chart_id,omitempty"`       // Reference to chart component
	TextConfig *PanelTextConfig `json:"text_config,omitempty" bson:"text_config,omitempty"` // Native text panel config
}

// ChartQueryConfig defines how to query data for a chart
// @Description Query configuration for fetching chart data
type ChartQueryConfig struct {
	Raw    string                 `json:"raw" bson:"raw"`       // SQL query, filter, or API path
	Type   string                 `json:"type" bson:"type"`     // sql, csv_filter, stream_filter, api
	Params map[string]interface{} `json:"params" bson:"params"` // Query parameters
}

// DataFilter defines a single filter condition
// @Description Filter condition for data transformation
type DataFilter struct {
	Field string      `json:"field" bson:"field"` // Column name to filter on
	Op    string      `json:"op" bson:"op"`       // Operator: eq, neq, gt, gte, lt, lte, contains, in, notIn, isNull, isNotNull
	Value interface{} `json:"value" bson:"value"` // Value to compare against (can be array for 'in' operator)
}

// SlidingWindow defines a time-based window for filtering data
// @Description Time window configuration for limiting data to recent entries
type SlidingWindow struct {
	Duration     int    `json:"duration" bson:"duration"`           // Window duration in seconds (e.g., 300 = last 5 minutes)
	TimestampCol string `json:"timestamp_col" bson:"timestamp_col"` // Column containing timestamps
}

// TimeBucket defines time-bucketed aggregation for streaming data
// @Description Time bucket configuration for aggregating streaming data into intervals
type TimeBucket struct {
	Interval     int      `json:"interval" bson:"interval"`           // Bucket interval in seconds (e.g., 60 = 1 minute, 3600 = 1 hour)
	Function     string   `json:"function" bson:"function"`           // Aggregation function: avg, min, max, sum, count
	ValueCols    []string `json:"value_cols" bson:"value_cols"`       // Columns to aggregate (numeric values)
	TimestampCol string   `json:"timestamp_col" bson:"timestamp_col"` // Column containing timestamps for bucket alignment
}

// DataAggregation defines how to aggregate/reduce data
// @Description Aggregation configuration for data transformation
type DataAggregation struct {
	Type   string `json:"type" bson:"type"`       // first, last, min, max, avg, sum, count, limit
	SortBy string `json:"sort_by" bson:"sort_by"` // Column to sort by (for first/last)
	Field  string `json:"field" bson:"field"`     // Column to aggregate (for min/max/avg/sum)
	Count  int    `json:"count" bson:"count"`     // Row count (for limit)
}

// ChartDataMapping defines how to map query results to chart elements
// @Description Mapping configuration from data columns to chart axes/series
type ChartDataMapping struct {
	XAxis         string           `json:"x_axis" bson:"x_axis"`                     // Column for X axis (categories)
	XAxisLabel    string           `json:"x_axis_label" bson:"x_axis_label"`         // Label for X axis (e.g., "Time", "Date")
	XAxisFormat   string           `json:"x_axis_format" bson:"x_axis_format"`       // Format for X axis values: chart, chart_time, chart_date, chart_datetime, short, long, etc.
	YAxis         []string         `json:"y_axis" bson:"y_axis"`                     // Columns for Y axis (values/series)
	YAxisLabel    string           `json:"y_axis_label" bson:"y_axis_label"`         // Label for Y axis (e.g., "Temperature (°F)", "Count")
	Series        string           `json:"series" bson:"series"`                     // Column that identifies each series (e.g., "location") - used for time bucket partitioning
	GroupBy       string           `json:"group_by" bson:"group_by"`                 // Column to group/split series by (client-side grouping)
	LabelCol      string           `json:"label_col" bson:"label_col"`               // Column for labels
	Filters       []DataFilter     `json:"filters" bson:"filters"`                   // Client-side filters applied after data fetch
	Aggregation   *DataAggregation `json:"aggregation" bson:"aggregation"`           // Aggregation to apply (first, last, avg, etc.)
	SlidingWindow *SlidingWindow   `json:"sliding_window" bson:"sliding_window"`     // Time-based sliding window (e.g., last 5 minutes)
	TimeBucket    *TimeBucket      `json:"time_bucket" bson:"time_bucket"`           // Time-bucketed aggregation for streaming data
	SortBy        string            `json:"sort_by" bson:"sort_by"`                   // Column to sort by
	SortOrder     string            `json:"sort_order" bson:"sort_order"`             // asc or desc
	Limit         int               `json:"limit" bson:"limit"`                       // Max rows to return
	ColumnAliases map[string]string `json:"column_aliases" bson:"column_aliases"`     // Display names for columns (column name -> display name), primarily for dataview
	Parser        *StreamParserConfig `json:"parser,omitempty" bson:"parser,omitempty"` // Per-component data extraction for streaming (MQTT, ts-store MQTT)
}

// StreamParserConfig configures how to extract data from streaming messages.
// Used when messages arrive in an envelope format (e.g., ts-store MQTT sink publishes
// {"type": "data", "timestamp": nanoseconds, "data": {...actual fields...}}).
type StreamParserConfig struct {
	DataPath       string `json:"data_path,omitempty" bson:"data_path,omitempty"`           // Dot-notation path to data object (e.g., "data", "payload.readings")
	TimestampField string `json:"timestamp_field,omitempty" bson:"timestamp_field,omitempty"` // Field containing timestamp (extracted before data_path)
	TimestampScale string `json:"timestamp_scale,omitempty" bson:"timestamp_scale,omitempty"` // "s", "ms", "ns" — auto-detected if empty
}

// EmbeddedChart represents a chart embedded directly in a dashboard
// @Description Chart stored within a dashboard, keyed by panel_id
type EmbeddedChart struct {
	ID            string                 `json:"id" bson:"id"`
	Name          string                 `json:"name" bson:"name"`
	ChartType     string                 `json:"chart_type" bson:"chart_type"`           // bar, line, pie, etc.
	DatasourceID  string                 `json:"connection_id" bson:"datasource_id"`     // Reference to connection (was datasource_id)
	QueryConfig   *ChartQueryConfig      `json:"query_config" bson:"query_config"`       // How to query data
	DataMapping   *ChartDataMapping      `json:"data_mapping" bson:"data_mapping"`       // How to map data to chart
	ComponentCode string                 `json:"component_code" bson:"component_code"`   // Custom React component code
	UseCustomCode bool                   `json:"use_custom_code" bson:"use_custom_code"` // Whether custom code mode is enabled
	Options       map[string]interface{} `json:"options" bson:"options"`                 // ECharts options overrides
}

// Dashboard represents a complete dashboard configuration
// @Description Dashboard with panels that reference standalone charts
type Dashboard struct {
	ID          string                 `json:"id" bson:"_id"`
	Name        string                 `json:"name" bson:"name" binding:"required"`
	Description string                 `json:"description" bson:"description"`
	Panels      []DashboardPanel       `json:"panels" bson:"panels"`           // Panels with chart_id references
	Thumbnail   string                 `json:"thumbnail" bson:"thumbnail"`     // Base64 encoded thumbnail image
	Settings    DashboardSettings      `json:"settings" bson:"settings"`
	Tags        []string               `json:"tags,omitempty" bson:"tags,omitempty"` // User-defined tags for filtering/grouping
	Metadata    map[string]interface{} `json:"metadata,omitempty" bson:"metadata,omitempty"`
	Created     time.Time              `json:"created" bson:"created"`
	Updated     time.Time              `json:"updated" bson:"updated"`
}

// DashboardSettings contains dashboard-level configuration
// @Description Dashboard settings and preferences
type DashboardSettings struct {
	Theme           string `json:"theme" bson:"theme"`
	RefreshInterval int    `json:"refresh_interval" bson:"refresh_interval"`
	TimeZone        string `json:"timezone,omitempty" bson:"timezone,omitempty"`
	DefaultView     string `json:"default_view,omitempty" bson:"default_view,omitempty"`
	IsPublic        bool   `json:"is_public" bson:"is_public"`
	AllowExport     bool   `json:"allow_export" bson:"allow_export"`
	LayoutDimension string `json:"layout_dimension,omitempty" bson:"layout_dimension,omitempty"`
	TitleScale      int    `json:"title_scale,omitempty" bson:"title_scale,omitempty"` // Title font scale % (default 100, range 50-200)
}

// CreateDashboardRequest represents a request to create a dashboard
// @Description Request body for creating a new dashboard
type CreateDashboardRequest struct {
	Name        string                 `json:"name" binding:"required"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"` // Panels with optional chart_id
	Settings    DashboardSettings      `json:"settings"`
	Tags        []string               `json:"tags,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// UpdateDashboardRequest represents a request to update a dashboard
// @Description Request body for updating an existing dashboard
type UpdateDashboardRequest struct {
	Name        *string                 `json:"name,omitempty"`
	Description *string                 `json:"description,omitempty"`
	Panels      *[]DashboardPanel       `json:"panels,omitempty"` // Panels with optional chart_id
	Thumbnail   *string                 `json:"thumbnail,omitempty"`
	Settings    *DashboardSettings      `json:"settings,omitempty"`
	Tags        *[]string               `json:"tags,omitempty"`
	Metadata    *map[string]interface{} `json:"metadata,omitempty"`
}

// DashboardListResponse represents a paginated list of dashboards
// @Description Response containing a list of dashboards with pagination
type DashboardListResponse struct {
	Dashboards []Dashboard `json:"dashboards"`
	Total      int64       `json:"total"`
	Page       int         `json:"page"`
	PageSize   int         `json:"page_size"`
}

// DashboardQueryParams defines query parameters for listing dashboards
// @Description Query parameters for filtering and pagination
type DashboardQueryParams struct {
	Name               string   `form:"name"`
	IsPublic           *bool    `form:"is_public"`
	ChartID            string   `form:"chart_id"`            // Filter dashboards using a specific chart
	Tags               []string `form:"tags"`                // Filter dashboards with any of the given tags (OR)
	IncludeDatasources bool     `form:"include_datasources"` // Include data source names from charts
	Page               int      `form:"page"`
	PageSize           int      `form:"page_size"`
}

// DashboardSummary is a lightweight dashboard representation for tile listings
// @Description Dashboard info with optional data source names for display in tiles
type DashboardSummary struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Thumbnail       string            `json:"thumbnail,omitempty"`
	Settings        DashboardSettings `json:"settings"`
	Tags            []string          `json:"tags,omitempty"`
	PanelCount      int               `json:"panel_count"`
	DatasourceNames []string          `json:"datasource_names,omitempty"` // Unique data source names used by charts
	Created         time.Time         `json:"created"`
	Updated         time.Time         `json:"updated"`
}

// DashboardSummaryListResponse represents a paginated list of dashboard summaries
// @Description Response containing dashboard summaries with optional data source info
type DashboardSummaryListResponse struct {
	Dashboards []DashboardSummary `json:"dashboards"`
	Total      int64              `json:"total"`
	Page       int                `json:"page"`
	PageSize   int                `json:"page_size"`
}

// DashboardWithCharts represents a dashboard with expanded chart data
// @Description Dashboard with full chart objects for rendering
type DashboardWithCharts struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"`
	Charts      map[string]*Chart      `json:"charts"` // panel_id -> Chart mapping (uses Chart from chart.go)
	Settings    DashboardSettings      `json:"settings"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}
