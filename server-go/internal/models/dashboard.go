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
// @Description Panel position and size in the grid with optional component reference or text config
type DashboardPanel struct {
	ID          string           `json:"id" bson:"id"`
	X           int              `json:"x" bson:"x"`
	Y           int              `json:"y" bson:"y"`
	W           int              `json:"w" bson:"w"`
	H           int              `json:"h" bson:"h"`
	ComponentID string           `json:"component_id,omitempty" bson:"component_id,omitempty"` // Reference to a component (chart, control, or display)
	TextConfig  *PanelTextConfig `json:"text_config,omitempty" bson:"text_config,omitempty"`   // Native text panel config
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
	XAxisLabel    string           `json:"x_axis_label" bson:"x_axis_label"`         // Label for X axis (e.g., "Time", "Date"). Empty = render no x-axis name; most charts are time-based and don't need one.
	XAxisFormat   string           `json:"x_axis_format" bson:"x_axis_format"`       // Format for X axis values: chart, chart_time, chart_date, chart_datetime, short, long, etc.
	YAxis         []string         `json:"y_axis" bson:"y_axis"`                     // Columns for Y axis (values/series)
	YAxisLabel    string           `json:"y_axis_label" bson:"y_axis_label"`         // Legacy single y-axis label — kept for backwards compat. Prefer YAxisLabels (plural) going forward; this is populated from YAxisLabels[0] on save.
	YAxisLabels   []string         `json:"y_axis_labels,omitempty" bson:"y_axis_labels,omitempty"` // Per-column y-axis labels. When shorter than YAxis, missing entries fall back to the column name. Dual-axis charts use [0] for the left axis and [1] for the right. Three+ y-columns suppress axis names entirely (series legend carries the identity).
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
	VisibleColumns []string         `json:"visible_columns,omitempty" bson:"visible_columns,omitempty"` // For dataview only: columns to render as table columns. Empty/missing = show all (default). Preserves the order given.
	ColumnWidths  map[string]int    `json:"column_widths,omitempty" bson:"column_widths,omitempty"` // For dataview only: column name -> pixel width. Default if a per-user override isn't set in app_config.dataview_layouts.
	Parser        *StreamParserConfig `json:"parser,omitempty" bson:"parser,omitempty"` // Per-component data extraction for streaming (MQTT, ts-store MQTT)
	BandColumns   *BandColumns        `json:"band_columns,omitempty" bson:"band_columns,omitempty"` // Banded-bar column mapping. Each row in the data is expected to carry a Mean column plus paired ±1 SD / ±2 SD columns; the renderer reads each row's own values to draw a per-row envelope. The chart is per-row only — there is no scalar/fixed-band convention.

	// ReferenceLevels was the original scalar (Westgard) reference-marker
	// list. Banded-bar moved to a per-row-only convention (BandColumns
	// above) so this field is read-only/legacy: existing components keep
	// it for backward compat reads but the editor + AI tools no longer
	// write it. Safe to remove once all stored components migrate.
	ReferenceLevels []ReferenceLevel `json:"reference_levels,omitempty" bson:"reference_levels,omitempty"`
}

// BandColumns maps each conceptual band role to a row-column name. The
// data adapter pulls each row's own value from the named column at
// render time; this is the per-row Levey-Jennings envelope contract.
// Columns referenced here must exist in every row of the data stream.
//
// Scheme drives which fields are meaningful (client band-schemes.js):
//   - "sd" (default / legacy): Mean + ±1/±2 SD
//   - "minmaxmean":            Mean + Min/Max
//   - "spc":                   Target + Lower/Upper Control + Lower/Upper Limit
// Records written before the scheme selector have no Scheme set; the
// client defaults them to "sd", matching the original fixed structure.
type BandColumns struct {
	Scheme string `json:"scheme,omitempty" bson:"scheme,omitempty"` // "sd" (default) | "minmaxmean" | "spc"

	// sd / minmaxmean center
	Mean string `json:"mean,omitempty" bson:"mean,omitempty"` // Primary value column (e.g. "mean")
	// sd bounds
	Plus1SD  string `json:"plus_1sd,omitempty" bson:"plus_1sd,omitempty"`   // +1 SD bound
	Minus1SD string `json:"minus_1sd,omitempty" bson:"minus_1sd,omitempty"` // -1 SD bound
	Plus2SD  string `json:"plus_2sd,omitempty" bson:"plus_2sd,omitempty"`   // +2 SD bound
	Minus2SD string `json:"minus_2sd,omitempty" bson:"minus_2sd,omitempty"` // -2 SD bound
	// minmaxmean bounds
	Min string `json:"min,omitempty" bson:"min,omitempty"`
	Max string `json:"max,omitempty" bson:"max,omitempty"`
	// spc center + bounds
	Target       string `json:"target,omitempty" bson:"target,omitempty"`
	LowerControl string `json:"lower_control,omitempty" bson:"lower_control,omitempty"`
	UpperControl string `json:"upper_control,omitempty" bson:"upper_control,omitempty"`
	LowerLimit   string `json:"lower_limit,omitempty" bson:"lower_limit,omitempty"`
	UpperLimit   string `json:"upper_limit,omitempty" bson:"upper_limit,omitempty"`
}

// ReferenceLevel is the legacy scalar marker type. Retained only so the
// ReferenceLevels field on ChartDataMapping deserializes cleanly for
// pre-existing components. New banded-bar charts use BandColumns.
type ReferenceLevel struct {
	Value float64 `json:"value" bson:"value"`
	Label string  `json:"label" bson:"label"`
	Kind  string  `json:"kind,omitempty" bson:"kind,omitempty"`
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
	ConnectionID  string                 `json:"connection_id" bson:"connection_id"`     // Reference to connection (was connection_id)
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
	Namespace   string                 `json:"namespace" bson:"namespace"` // Conflict-domain; uniqueness is (namespace, name). See models.Namespace.
	Name        string                 `json:"name" bson:"name" binding:"required"`
	Description string                 `json:"description" bson:"description"`
	Panels      []DashboardPanel       `json:"panels" bson:"panels"`           // Panels with component_id references
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
	Namespace   string                 `json:"namespace,omitempty"` // Empty defaults to "default" in the handler.
	Name        string                 `json:"name" binding:"required"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"` // Panels with optional component_id
	Settings    DashboardSettings      `json:"settings"`
	Tags        []string               `json:"tags,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}

// UpdateDashboardRequest represents a request to update a dashboard
// @Description Request body for updating an existing dashboard
type UpdateDashboardRequest struct {
	Namespace   *string                 `json:"namespace,omitempty"` // Omitted = leave current namespace unchanged.
	Name        *string                 `json:"name,omitempty"`
	Description *string                 `json:"description,omitempty"`
	Panels      *[]DashboardPanel       `json:"panels,omitempty"` // Panels with optional component_id
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
	Namespace          string   `form:"namespace"`           // Empty = all namespaces; non-empty = exact match
	Name               string   `form:"name"`
	IsPublic           *bool    `form:"is_public"`
	ComponentID        string   `form:"component_id"`        // Filter dashboards using a specific component
	Tags               []string `form:"tags"`                // Filter dashboards with any of the given tags (OR)
	IncludeConnections bool     `form:"include_connections"` // Include connection names from referenced components
	Page               int      `form:"page"`
	PageSize           int      `form:"page_size"`
}

// DashboardSummary is a lightweight dashboard representation for tile listings
// @Description Dashboard info with optional data source names for display in tiles
type DashboardSummary struct {
	ID              string            `json:"id"`
	Namespace       string            `json:"namespace"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Thumbnail       string            `json:"thumbnail,omitempty"`
	Settings        DashboardSettings `json:"settings"`
	Tags            []string          `json:"tags,omitempty"`
	PanelCount      int               `json:"panel_count"`
	ConnectionNames []string          `json:"connection_names,omitempty"` // Unique connection names used by referenced components
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

// DashboardWithComponents represents a dashboard with expanded component data
// @Description Dashboard with full component objects for rendering
type DashboardWithComponents struct {
	ID          string                 `json:"id"`
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	Panels      []DashboardPanel       `json:"panels"`
	Components  map[string]*Component  `json:"components"` // panel_id -> Component mapping
	Settings    DashboardSettings      `json:"settings"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
}
