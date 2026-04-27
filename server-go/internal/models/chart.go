// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"time"
)

// Chart status constants
const (
	ChartStatusDraft = "draft" // AI work in progress, not visible in dashboards
	ChartStatusFinal = "final" // Saved/committed version
)

// Component type constants
const (
	ComponentTypeChart   = "chart"   // Default - data visualization chart
	ComponentTypeControl = "control" // Interactive control component
	ComponentTypeDisplay = "display" // Non-chart visual component (cameras, iframes, etc.)
)

// Display type constants
const (
	DisplayTypeFrigateCamera = "frigate_camera" // Frigate NVR camera viewer
	DisplayTypeWeather       = "weather"        // Weather display with MQTT feed
)

// Control type constants
const (
	ControlTypeButton    = "button"      // Simple action button
	ControlTypeToggle    = "toggle"      // On/off toggle switch
	ControlTypeSlider    = "slider"      // Numeric slider
	ControlTypeTextInput = "text_input"  // Text input field
	ControlTypeSwitch    = "switch"      // On/off switch (HomeKit-style pill)
	ControlTypePlug      = "plug"        // Alias for switch (backward compat)
	ControlTypeDimmer     = "dimmer"      // Light dimmer
	ControlTypeGarageDoor = "garage_door" // Full-size animated garage door status
	ControlTypeTileSwitch     = "tile_switch"      // Compact tile switch
	ControlTypeTilePlug       = "tile_plug"        // Alias for tile_switch (backward compat)
	ControlTypeTileDimmer     = "tile_dimmer"      // Compact tile dimmer
	ControlTypeTileGarageDoor = "tile_garage_door"  // Compact garage door status tile
	ControlTypeTextLabel      = "text_label"        // Static text/label display
	ControlTypeMqttPublish    = "mqtt_publish"      // Fire-and-forget MQTT JSON publish
)

// ControlConfig defines configuration for control components
// @Description Configuration for interactive control components (buttons, toggles, etc.)
type ControlConfig struct {
	ControlType string `json:"control_type" bson:"control_type"` // button, toggle, slider, text_input

	// Device type-based control configuration (preferred)
	DeviceTypeID string `json:"device_type_id,omitempty" bson:"device_type_id,omitempty"` // Reference to device_type
	Target       string `json:"target,omitempty" bson:"target,omitempty"`                 // Device/endpoint identifier for template interpolation

	// Legacy command configuration (deprecated, use device type instead)
	CommandConfig *CommandConfig `json:"command_config,omitempty" bson:"command_config,omitempty"` // How to send commands

	// UI configuration
	UIConfig map[string]interface{} `json:"ui_config" bson:"ui_config"` // Type-specific UI configuration
}

// CommandConfig defines how a control sends commands to a connection
// @Description Configuration for sending commands via a connection
type CommandConfig struct {
	Action          string                 `json:"action" bson:"action"`                       // Command action name
	Target          string                 `json:"target,omitempty" bson:"target,omitempty"`   // Optional target identifier
	PayloadTemplate map[string]interface{} `json:"payload_template,omitempty" bson:"payload_template,omitempty"` // Template with {{value}} placeholder
}

// DisplayConfig defines configuration for display components
// @Description Configuration for non-chart visual components (cameras, iframes, etc.)
type DisplayConfig struct {
	DisplayType string `json:"display_type" bson:"display_type"` // "frigate_camera", "frigate_alerts", "weather"

	// Frigate-specific fields (used by frigate_camera and frigate_alerts)
	FrigateConnectionID string `json:"frigate_connection_id,omitempty" bson:"frigate_connection_id,omitempty"` // API connection to Frigate NVR
	DefaultCamera       string `json:"default_camera,omitempty" bson:"default_camera,omitempty"`               // Pre-selected camera name (frigate_camera) or camera filter (frigate_alerts)
	MqttConnectionID    string `json:"mqtt_connection_id,omitempty" bson:"mqtt_connection_id,omitempty"`       // MQTT connection for alert/weather subscription
	AlertTopic          string `json:"alert_topic,omitempty" bson:"alert_topic,omitempty"`                     // MQTT topic for alerts (default: "frigate/reviews")
	SnapshotInterval    int    `json:"snapshot_interval,omitempty" bson:"snapshot_interval,omitempty"`          // Polling interval in ms (default 10000)

	// Frigate alerts grid fields (only used when display_type = "frigate_alerts")
	MaxThumbnails  int    `json:"max_thumbnails,omitempty" bson:"max_thumbnails,omitempty"`   // Max number of alert thumbnails to display (default 8)
	AlertSeverity  string `json:"alert_severity,omitempty" bson:"alert_severity,omitempty"`   // Filter by severity: "alert" (default), "detection", or "" for all

	// Weather-specific fields (only used when display_type = "weather")
	WeatherTopicPrefix string `json:"weather_topic_prefix,omitempty" bson:"weather_topic_prefix,omitempty"` // MQTT topic prefix (default: "weather")
	WeatherLocation    string `json:"weather_location,omitempty" bson:"weather_location,omitempty"`         // Display label (e.g., "Spring, TX")
}

// Chart represents a standalone chart or control configuration
// @Description Chart/Control with data source binding, query config, and visualization settings
// Primary key is composite (id, version) - id stays same across versions
type Chart struct {
	ID            string                 `json:"id" bson:"id"`                           // UUID - same across versions
	Version       int                    `json:"version" bson:"version"`                 // Version number (1, 2, 3...)
	Status        string                 `json:"status" bson:"status"`                   // "draft" | "final"
	ComponentType string                 `json:"component_type" bson:"component_type"`   // "chart" (default) | "control"
	Namespace     string                 `json:"namespace" bson:"namespace"`             // Conflict-domain; uniqueness is (namespace, name). See models.Namespace.
	Name          string                 `json:"name" bson:"name" binding:"required"`    // Unique identifier within namespace
	Title         string                 `json:"title" bson:"title"`                     // Display title (defaults to Name if empty)
	Description   string                 `json:"description" bson:"description"`
	ChartType     string                 `json:"chart_type" bson:"chart_type"`           // bar, line, pie, gauge, etc. (charts only)
	DatasourceID  string                 `json:"connection_id" bson:"datasource_id"`     // Reference to connection
	QueryConfig   *ChartQueryConfig      `json:"query_config" bson:"query_config"`       // How to query data (charts only)
	DataMapping   *ChartDataMapping      `json:"data_mapping" bson:"data_mapping"`       // How to map data to chart (charts only)
	ControlConfig *ControlConfig         `json:"control_config,omitempty" bson:"control_config,omitempty"` // Control configuration (controls only)
	DisplayConfig *DisplayConfig         `json:"display_config,omitempty" bson:"display_config,omitempty"` // Display configuration (displays only)
	ComponentCode string                 `json:"component_code" bson:"component_code"`   // React component code
	UseCustomCode bool                   `json:"use_custom_code" bson:"use_custom_code"` // Whether custom code mode is enabled
	Options       map[string]interface{} `json:"options" bson:"options"`                 // ECharts options overrides (charts only)
	Tags          []string               `json:"tags,omitempty" bson:"tags,omitempty"`   // Searchable tags
	AISessionID   string                 `json:"ai_session_id,omitempty" bson:"ai_session_id,omitempty"` // Active AI session (drafts only)
	Created       time.Time              `json:"created" bson:"created"`
	Updated       time.Time              `json:"updated" bson:"updated"`
}

// CreateChartRequest represents a request to create a chart or control
// @Description Request body for creating a new chart or control
type CreateChartRequest struct {
	ComponentType string                 `json:"component_type"` // "chart" (default) | "control"
	Namespace     string                 `json:"namespace,omitempty"` // Empty defaults to "default" in the handler.
	Name          string                 `json:"name" binding:"required"`
	Title         string                 `json:"title"`
	Description   string                 `json:"description"`
	ChartType     string                 `json:"chart_type"`
	DatasourceID  string                 `json:"connection_id"`
	QueryConfig   *ChartQueryConfig      `json:"query_config"`
	DataMapping   *ChartDataMapping      `json:"data_mapping"`
	ControlConfig *ControlConfig         `json:"control_config"`
	DisplayConfig *DisplayConfig         `json:"display_config"`
	ComponentCode string                 `json:"component_code"`
	UseCustomCode bool                   `json:"use_custom_code"`
	Options       map[string]interface{} `json:"options"`
	Tags          []string               `json:"tags"`
}

// UpdateChartRequest represents a request to update a chart, control, or display
// @Description Request body for updating an existing chart, control, or display
type UpdateChartRequest struct {
	ComponentType *string                 `json:"component_type,omitempty"`
	Namespace     *string                 `json:"namespace,omitempty"` // Omitted = leave current namespace unchanged.
	Name          *string                 `json:"name,omitempty"`
	Title         *string                 `json:"title,omitempty"`
	Description   *string                 `json:"description,omitempty"`
	ChartType     *string                 `json:"chart_type,omitempty"`
	DatasourceID  *string                 `json:"connection_id,omitempty"`
	QueryConfig   *ChartQueryConfig       `json:"query_config,omitempty"`
	DataMapping   *ChartDataMapping       `json:"data_mapping,omitempty"`
	ControlConfig *ControlConfig          `json:"control_config,omitempty"`
	DisplayConfig *DisplayConfig          `json:"display_config,omitempty"`
	ComponentCode *string                 `json:"component_code,omitempty"`
	UseCustomCode *bool                   `json:"use_custom_code,omitempty"`
	Options       *map[string]interface{} `json:"options,omitempty"`
	Tags          *[]string               `json:"tags,omitempty"`
}

// ChartListResponse represents a paginated list of charts
// @Description Response containing a list of charts with pagination
type ChartListResponse struct {
	Charts   []Chart `json:"charts"`
	Total    int64   `json:"total"`
	Page     int     `json:"page"`
	PageSize int     `json:"page_size"`
}

// ChartQueryParams defines query parameters for listing charts
// @Description Query parameters for filtering and pagination
type ChartQueryParams struct {
	Namespace     string   `form:"namespace"`      // Empty = all namespaces; non-empty = exact match
	Name          string   `form:"name"`
	ChartType     string   `form:"chart_type"`
	ComponentType string   `form:"component_type"` // "chart", "control", "display"
	Status        string   `form:"status"`         // "draft", "final"
	DatasourceID  string   `form:"connection_id"`  // Accept connection_id query param
	Tags          []string `form:"tags"`           // Filter charts with any of the given tags (OR)
	Tag           string   `form:"tag"`            // DEPRECATED: use tags; kept for back-compat
	Page          int      `form:"page"`
	PageSize      int      `form:"page_size"`
}

// ChartSummary is a lightweight chart representation for card listings
// @Description Minimal chart info for selection cards and lists
type ChartSummary struct {
	ID            string   `json:"id"`
	Version       int      `json:"version"`
	Status        string   `json:"status"`
	ComponentType string   `json:"component_type"`
	Namespace     string   `json:"namespace"`
	Name          string   `json:"name"`
	Description   string   `json:"description"`
	ChartType     string   `json:"chart_type"`
	DatasourceID  string   `json:"connection_id"`
	Tags          []string `json:"tags,omitempty"`
}

// ChartVersionInfo provides version metadata for delete dialogs
// @Description Version info for a chart
type ChartVersionInfo struct {
	ID           string `json:"id"`
	Version      int    `json:"version"`
	Status       string `json:"status"`
	VersionCount int    `json:"version_count"` // Total versions for this chart id
	HasDraft     bool   `json:"has_draft"`     // Whether a draft version exists
}
