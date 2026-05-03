// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/hub"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// ToolExecutor handles executing AI tools and updating charts
type ToolExecutor struct {
	componentRepo      ComponentRepository
	connectionRepo ConnectionRepoIface
	connectionSvc  ConnectionServiceIface
	deviceTypeRepo DeviceTypeRepository
	componentHub       *hub.ComponentHub
}

// ComponentRepository interface for chart operations
type ComponentRepository interface {
	FindByIDAndVersion(ctx context.Context, id string, version int) (*models.Component, error)
	Update(ctx context.Context, id string, version int, chart *models.Component) error
}

// ConnectionRepoIface interface for data source operations
type ConnectionRepoIface interface {
	FindAll(ctx context.Context, limit, offset int64) ([]*models.Connection, error)
	FindByID(ctx context.Context, id string) (*models.Connection, error)
}

// DeviceTypeRepository interface for device type operations
type DeviceTypeRepository interface {
	List(ctx context.Context, params *models.DeviceTypeQueryParams) ([]models.DeviceType, int64, error)
}

// ConnectionServiceIface interface for data source queries
type ConnectionServiceIface interface {
	QueryConnection(ctx context.Context, id string, req *models.QueryRequest) (*models.QueryResponse, error)
	GetSchema(ctx context.Context, id string) (*models.SchemaResponse, error)
	GetConnection(ctx context.Context, id string) (*models.Connection, error)
	GetEdgeLakeDatabases(ctx context.Context, id string) ([]string, error)
	GetEdgeLakeTables(ctx context.Context, id string, database string) ([]string, error)
	GetEdgeLakeSchema(ctx context.Context, id string, database, table string) ([]models.EdgeLakeColumnInfo, error)
}

// NewToolExecutor creates a new tool executor
func NewToolExecutor(componentRepo ComponentRepository, connRepo ConnectionRepoIface, connSvc ConnectionServiceIface, dtRepo DeviceTypeRepository, componentHub *hub.ComponentHub) *ToolExecutor {
	return &ToolExecutor{
		componentRepo:      componentRepo,
		connectionRepo: connRepo,
		connectionSvc:  connSvc,
		deviceTypeRepo: dtRepo,
		componentHub:       componentHub,
	}
}

// broadcastComponentUpdate broadcasts a component update to all subscribers via the hub
func (e *ToolExecutor) broadcastComponentUpdate(component *models.Component) {
	if e.componentHub != nil && component != nil {
		fmt.Printf("[ToolExecutor] Broadcasting component update for %s to ComponentHub\n", component.ID)
		e.componentHub.BroadcastComponentUpdate(component.ID, component)
	}
}

// ToolResult contains the result of executing a tool
type ToolResult struct {
	Success      bool        `json:"success"`
	Message      string      `json:"message,omitempty"`
	Data         interface{} `json:"data,omitempty"`
	Error        string      `json:"error,omitempty"`
	ChartUpdated bool        `json:"chart_updated,omitempty"`
}

// ExecuteTool executes a tool and returns the result
func (e *ToolExecutor) ExecuteTool(ctx context.Context, chartID string, chartVersion int, toolName string, input json.RawMessage) (*ToolResult, error) {
	fmt.Printf("[ToolExecutor] Executing tool: %s for chart %s v%d\n", toolName, chartID, chartVersion)
	fmt.Printf("[ToolExecutor] Input: %s\n", string(input))

	switch toolName {
	case ToolUpdateComponentType:
		return e.executeUpdateComponentType(ctx, chartID, chartVersion, input)
	case ToolUpdateControlConfig:
		return e.executeUpdateControlConfig(ctx, chartID, chartVersion, input)
	case ToolUpdateComponentConfig:
		return e.executeUpdateComponentConfig(ctx, chartID, chartVersion, input)
	case ToolUpdateDataMapping:
		return e.executeUpdateDataMapping(ctx, chartID, chartVersion, input)
	case ToolUpdateQueryConfig:
		return e.executeUpdateQueryConfig(ctx, chartID, chartVersion, input)
	case ToolUpdateFilters:
		return e.executeUpdateFilters(ctx, chartID, chartVersion, input)
	case ToolUpdateAggregation:
		return e.executeUpdateAggregation(ctx, chartID, chartVersion, input)
	case ToolUpdateSlidingWindow:
		return e.executeUpdateSlidingWindow(ctx, chartID, chartVersion, input)
	case ToolUpdateTimeBucket:
		return e.executeUpdateTimeBucket(ctx, chartID, chartVersion, input)
	case ToolSetCustomCode:
		return e.executeSetCustomCode(ctx, chartID, chartVersion, input)
	case ToolUpdateChartOptions:
		return e.executeUpdateChartOptions(ctx, chartID, chartVersion, input)
	case ToolQueryConnection:
		return e.executeQueryConnection(ctx, input)
	case ToolListConnections:
		return e.executeListConnections(ctx)
	case ToolGetSchema:
		return e.executeGetSchema(ctx, input)
	case ToolGetConnectionSchema:
		return e.executeGetConnectionSchema(ctx, input)
	case ToolGetPrometheusSchema:
		return e.executeGetPrometheusSchema(ctx, input)
	case ToolGetEdgeLakeSchema:
		return e.executeGetEdgeLakeSchema(ctx, input)
	case ToolPreviewData:
		return e.executePreviewData(ctx, chartID, chartVersion, input)
	case ToolGetComponentState:
		return e.executeGetComponentState(ctx, chartID, chartVersion)
	case ToolGetComponentTemplate:
		return e.executeGetComponentTemplate(input)
	case ToolListDeviceTypes:
		return e.executeListDeviceTypes(ctx)
	case ToolSuggestMissing:
		return e.executeSuggestMissing(input)
	default:
		return &ToolResult{
			Success: false,
			Error:   fmt.Sprintf("unknown tool: %s", toolName),
		}, nil
	}
}

// executeUpdateComponentType sets the component type on the draft
func (e *ToolExecutor) executeUpdateComponentType(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ComponentType string `json:"component_type"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	validTypes := map[string]bool{"chart": true, "control": true, "display": true}
	if !validTypes[params.ComponentType] {
		return &ToolResult{Success: false, Error: "invalid component_type, must be: chart, control, or display"}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	chart.ComponentType = params.ComponentType

	// Initialize type-specific configs
	if params.ComponentType == "control" && chart.ControlConfig == nil {
		chart.ControlConfig = &models.ControlConfig{}
	}
	if params.ComponentType == "display" && chart.DisplayConfig == nil {
		chart.DisplayConfig = &models.DisplayConfig{}
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Set component type to '%s'", params.ComponentType),
		ChartUpdated: true,
	}, nil
}

// executeUpdateControlConfig configures a control component
func (e *ToolExecutor) executeUpdateControlConfig(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ControlType     *string                `json:"control_type,omitempty"`
		ConnectionID    *string                `json:"connection_id,omitempty"`
		Target          *string                `json:"target,omitempty"`
		DeviceTypeID    *string                `json:"device_type_id,omitempty"`
		CommandAction   *string                `json:"command_action,omitempty"`
		CommandTarget   *string                `json:"command_target,omitempty"`
		PayloadTemplate map[string]interface{} `json:"payload_template,omitempty"`
		UIConfig        map[string]interface{} `json:"ui_config,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Ensure component type is control
	if chart.ComponentType != models.ComponentTypeControl {
		chart.ComponentType = models.ComponentTypeControl
	}

	// Initialize ControlConfig if nil
	if chart.ControlConfig == nil {
		chart.ControlConfig = &models.ControlConfig{}
	}

	updates := []string{}

	if params.ControlType != nil {
		validTypes := map[string]bool{"button": true, "toggle": true, "slider": true, "text_input": true, "plug": true, "dimmer": true}
		if !validTypes[*params.ControlType] {
			return &ToolResult{Success: false, Error: "invalid control_type"}, nil
		}
		chart.ControlConfig.ControlType = *params.ControlType
		updates = append(updates, "control_type")
	}

	if params.ConnectionID != nil {
		chart.ConnectionID = *params.ConnectionID
		updates = append(updates, "connection_id")
	}

	if params.Target != nil {
		chart.ControlConfig.Target = *params.Target
		updates = append(updates, "target")
	}

	if params.DeviceTypeID != nil {
		chart.ControlConfig.DeviceTypeID = *params.DeviceTypeID
		updates = append(updates, "device_type_id")
	}

	// Build CommandConfig if any command fields provided
	if params.CommandAction != nil || params.CommandTarget != nil || params.PayloadTemplate != nil {
		if chart.ControlConfig.CommandConfig == nil {
			chart.ControlConfig.CommandConfig = &models.CommandConfig{}
		}
		if params.CommandAction != nil {
			chart.ControlConfig.CommandConfig.Action = *params.CommandAction
			updates = append(updates, "command_action")
		}
		if params.CommandTarget != nil {
			chart.ControlConfig.CommandConfig.Target = *params.CommandTarget
			updates = append(updates, "command_target")
		}
		if params.PayloadTemplate != nil {
			chart.ControlConfig.CommandConfig.PayloadTemplate = params.PayloadTemplate
			updates = append(updates, "payload_template")
		}
	}

	if params.UIConfig != nil {
		chart.ControlConfig.UIConfig = params.UIConfig
		updates = append(updates, "ui_config")
	}

	if len(updates) == 0 {
		return &ToolResult{Success: true, Message: "No changes specified"}, nil
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Updated control config: %v", updates),
		ChartUpdated: true,
	}, nil
}

// executeUpdateComponentConfig updates basic component configuration (not name - that's user-controlled)
func (e *ToolExecutor) executeUpdateComponentConfig(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Title       *string `json:"title,omitempty"`
		Description *string `json:"description,omitempty"`
		ChartType   *string `json:"chart_type,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	updates := []string{}
	if params.Title != nil {
		chart.Title = *params.Title
		updates = append(updates, "title")
	}
	if params.Description != nil {
		chart.Description = *params.Description
		updates = append(updates, "description")
	}
	if params.ChartType != nil {
		chart.ChartType = *params.ChartType
		updates = append(updates, "chart_type")
	}

	if len(updates) == 0 {
		return &ToolResult{Success: true, Message: "No changes specified"}, nil
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Updated chart config: %v", updates),
		ChartUpdated: true,
	}, nil
}

// executeUpdateDataMapping updates data mapping configuration
func (e *ToolExecutor) executeUpdateDataMapping(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID *string   `json:"connection_id,omitempty"`
		XAxis        *string   `json:"x_axis,omitempty"`
		XAxisLabel   *string   `json:"x_axis_label,omitempty"`
		XAxisFormat  *string   `json:"x_axis_format,omitempty"`
		YAxis        *[]string `json:"y_axis,omitempty"`
		YAxisLabel   *string   `json:"y_axis_label,omitempty"`   // legacy single label
		YAxisLabels  *[]string `json:"y_axis_labels,omitempty"`  // per-column labels (preferred)
		GroupBy      *string   `json:"group_by,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	if params.ConnectionID != nil {
		chart.ConnectionID = *params.ConnectionID
	}

	// Initialize DataMapping if nil
	if chart.DataMapping == nil {
		chart.DataMapping = &models.ChartDataMapping{}
	}

	if params.XAxis != nil {
		chart.DataMapping.XAxis = *params.XAxis
	}
	if params.XAxisLabel != nil {
		chart.DataMapping.XAxisLabel = *params.XAxisLabel
	}
	if params.XAxisFormat != nil {
		chart.DataMapping.XAxisFormat = *params.XAxisFormat
	}
	if params.YAxis != nil {
		// Cap y_axis at 2 columns for chart types that render with axes.
		// Beyond 2 there's no good rendering — no place for axis names, tick
		// values overlap, and color coding breaks down. Two separate charts
		// beat one cluttered one. Dataview (tabular) is the exception; any
		// column count is fine there.
		ys := *params.YAxis
		if chart.ChartType != "dataview" && len(ys) > 2 {
			ys = ys[:2]
		}
		chart.DataMapping.YAxis = ys
	}
	if params.YAxisLabel != nil {
		chart.DataMapping.YAxisLabel = *params.YAxisLabel
	}
	if params.YAxisLabels != nil {
		chart.DataMapping.YAxisLabels = *params.YAxisLabels
		// Keep the legacy singular in sync for back-compat consumers.
		if len(*params.YAxisLabels) > 0 {
			chart.DataMapping.YAxisLabel = (*params.YAxisLabels)[0]
		}
	}
	if params.GroupBy != nil {
		chart.DataMapping.GroupBy = *params.GroupBy
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		fmt.Printf("[ToolExecutor] update_data_mapping - Update failed: %v\n", err)
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	fmt.Printf("[ToolExecutor] update_data_mapping - Chart updated successfully\n")
	fmt.Printf("[ToolExecutor] update_data_mapping - ConnectionID: %s\n", chart.ConnectionID)
	if chart.DataMapping != nil {
		fmt.Printf("[ToolExecutor] update_data_mapping - XAxis: %s, YAxis: %v\n",
			chart.DataMapping.XAxis, chart.DataMapping.YAxis)
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      "Updated data mapping configuration",
		ChartUpdated: true,
	}, nil
}

// executeUpdateQueryConfig updates query configuration
func (e *ToolExecutor) executeUpdateQueryConfig(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Query           *string `json:"query,omitempty"`
		QueryType       *string `json:"query_type,omitempty"`
		RefreshInterval *int    `json:"refresh_interval,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize QueryConfig if nil
	if chart.QueryConfig == nil {
		chart.QueryConfig = &models.ChartQueryConfig{}
	}

	if params.Query != nil {
		chart.QueryConfig.Raw = *params.Query
	}
	if params.QueryType != nil {
		chart.QueryConfig.Type = *params.QueryType
	}
	// RefreshInterval is stored in Options for now
	if params.RefreshInterval != nil {
		if chart.Options == nil {
			chart.Options = make(map[string]interface{})
		}
		chart.Options["refreshInterval"] = *params.RefreshInterval
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      "Updated query configuration",
		ChartUpdated: true,
	}, nil
}

// executeUpdateFilters updates data filters
func (e *ToolExecutor) executeUpdateFilters(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Filters []models.DataFilter `json:"filters"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize DataMapping if nil
	if chart.DataMapping == nil {
		chart.DataMapping = &models.ChartDataMapping{}
	}

	chart.DataMapping.Filters = params.Filters

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Updated filters: %d filter(s) applied", len(params.Filters)),
		ChartUpdated: true,
	}, nil
}

// executeUpdateAggregation updates aggregation configuration
func (e *ToolExecutor) executeUpdateAggregation(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Type   *string `json:"type,omitempty"`
		Field  *string `json:"field,omitempty"`
		SortBy *string `json:"sort_by,omitempty"`
		Count  *int    `json:"count,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize DataMapping if nil
	if chart.DataMapping == nil {
		chart.DataMapping = &models.ChartDataMapping{}
	}
	if chart.DataMapping.Aggregation == nil {
		chart.DataMapping.Aggregation = &models.DataAggregation{}
	}

	if params.Type != nil {
		chart.DataMapping.Aggregation.Type = *params.Type
	}
	if params.Field != nil {
		chart.DataMapping.Aggregation.Field = *params.Field
	}
	if params.SortBy != nil {
		chart.DataMapping.Aggregation.SortBy = *params.SortBy
	}
	if params.Count != nil {
		chart.DataMapping.Aggregation.Count = *params.Count
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      "Updated aggregation configuration",
		ChartUpdated: true,
	}, nil
}

// executeUpdateSlidingWindow updates sliding window configuration for time-based data filtering
func (e *ToolExecutor) executeUpdateSlidingWindow(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Duration     *int    `json:"duration,omitempty"`
		TimestampCol *string `json:"timestamp_col,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize DataMapping if nil
	if chart.DataMapping == nil {
		chart.DataMapping = &models.ChartDataMapping{}
	}
	if chart.DataMapping.SlidingWindow == nil {
		chart.DataMapping.SlidingWindow = &models.SlidingWindow{}
	}

	if params.Duration != nil {
		chart.DataMapping.SlidingWindow.Duration = *params.Duration
	}
	if params.TimestampCol != nil {
		chart.DataMapping.SlidingWindow.TimestampCol = *params.TimestampCol
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Updated sliding window: %d seconds on column '%s'", chart.DataMapping.SlidingWindow.Duration, chart.DataMapping.SlidingWindow.TimestampCol),
		ChartUpdated: true,
	}, nil
}

// executeUpdateTimeBucket updates time-bucketed aggregation configuration for streaming data
func (e *ToolExecutor) executeUpdateTimeBucket(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Interval     *int      `json:"interval,omitempty"`
		Function     *string   `json:"function,omitempty"`
		ValueCols    *[]string `json:"value_cols,omitempty"`
		TimestampCol *string   `json:"timestamp_col,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize DataMapping if nil
	if chart.DataMapping == nil {
		chart.DataMapping = &models.ChartDataMapping{}
	}
	if chart.DataMapping.TimeBucket == nil {
		chart.DataMapping.TimeBucket = &models.TimeBucket{}
	}

	if params.Interval != nil {
		chart.DataMapping.TimeBucket.Interval = *params.Interval
	}
	if params.Function != nil {
		// Validate function
		validFunctions := map[string]bool{"avg": true, "min": true, "max": true, "sum": true, "count": true}
		if !validFunctions[*params.Function] {
			return &ToolResult{Success: false, Error: "invalid function, must be: avg, min, max, sum, or count"}, nil
		}
		chart.DataMapping.TimeBucket.Function = *params.Function
	}
	if params.ValueCols != nil {
		chart.DataMapping.TimeBucket.ValueCols = *params.ValueCols
	}
	if params.TimestampCol != nil {
		chart.DataMapping.TimeBucket.TimestampCol = *params.TimestampCol
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      fmt.Sprintf("Updated time bucket: %d second intervals using '%s' function on columns %v", chart.DataMapping.TimeBucket.Interval, chart.DataMapping.TimeBucket.Function, chart.DataMapping.TimeBucket.ValueCols),
		ChartUpdated: true,
	}, nil
}

// executeSetCustomCode enables custom code mode and sets component code
func (e *ToolExecutor) executeSetCustomCode(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ComponentCode string `json:"component_code"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ComponentCode == "" {
		return &ToolResult{Success: false, Error: "component_code is required"}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	chart.UseCustomCode = true
	chart.ComponentCode = params.ComponentCode

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      "Enabled custom code mode and updated component code",
		ChartUpdated: true,
	}, nil
}

// executeUpdateChartOptions updates ECharts-specific options
func (e *ToolExecutor) executeUpdateChartOptions(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Title          *string   `json:"title,omitempty"`
		ShowLegend     *bool     `json:"show_legend,omitempty"`
		LegendPosition *string   `json:"legend_position,omitempty"`
		ShowTooltip    *bool     `json:"show_tooltip,omitempty"`
		ColorPalette   *[]string `json:"color_palette,omitempty"`
		StackSeries    *bool     `json:"stack_series,omitempty"`
		SmoothLines    *bool     `json:"smooth_lines,omitempty"`
		ShowDataLabels *bool     `json:"show_data_labels,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	// Initialize Options if nil
	if chart.Options == nil {
		chart.Options = make(map[string]interface{})
	}

	if params.Title != nil {
		chart.Options["title"] = *params.Title
	}
	if params.ShowLegend != nil {
		chart.Options["showLegend"] = *params.ShowLegend
	}
	if params.LegendPosition != nil {
		chart.Options["legendPosition"] = *params.LegendPosition
	}
	if params.ShowTooltip != nil {
		chart.Options["showTooltip"] = *params.ShowTooltip
	}
	if params.ColorPalette != nil {
		chart.Options["colorPalette"] = *params.ColorPalette
	}
	if params.StackSeries != nil {
		chart.Options["stackSeries"] = *params.StackSeries
	}
	if params.SmoothLines != nil {
		chart.Options["smoothLines"] = *params.SmoothLines
	}
	if params.ShowDataLabels != nil {
		chart.Options["showDataLabels"] = *params.ShowDataLabels
	}

	if err := e.componentRepo.Update(ctx, chartID, chartVersion, chart); err != nil {
		return &ToolResult{Success: false, Error: "failed to update chart: " + err.Error()}, nil
	}

	// Broadcast chart update to all subscribers
	e.broadcastComponentUpdate(chart)

	return &ToolResult{
		Success:      true,
		Message:      "Updated chart options",
		ChartUpdated: true,
	}, nil
}

// executeQueryConnection executes a query against a connection
func (e *ToolExecutor) executeQueryConnection(ctx context.Context, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID string  `json:"connection_id"`
		Query        *string `json:"query,omitempty"`
		Limit        *int    `json:"limit,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "connection_id is required"}, nil
	}

	// Set default limit
	limit := 10
	if params.Limit != nil {
		limit = *params.Limit
	}

	query := ""
	if params.Query != nil {
		query = *params.Query
	}

	req := &models.QueryRequest{
		Query: models.Query{
			Raw: query,
			Params: map[string]interface{}{
				"limit": limit,
			},
		},
	}

	response, err := e.connectionSvc.QueryConnection(ctx, params.ConnectionID, req)
	if err != nil {
		return &ToolResult{Success: false, Error: "query failed: " + err.Error()}, nil
	}

	if response.ResultSet == nil {
		return &ToolResult{Success: true, Message: "Query returned no results", Data: nil}, nil
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Query returned %d rows", len(response.ResultSet.Rows)),
		Data:    response.ResultSet,
	}, nil
}

// executeListConnections lists all available connections
func (e *ToolExecutor) executeListConnections(ctx context.Context) (*ToolResult, error) {
	datasources, err := e.connectionRepo.FindAll(ctx, 100, 0) // limit 100, offset 0
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to list connections: " + err.Error()}, nil
	}

	// Build summary list
	type connSummary struct {
		ID          string   `json:"id"`
		Name        string   `json:"name"`
		Type        string   `json:"type"`
		Description string   `json:"description,omitempty"`
		Columns     []string `json:"columns,omitempty"`
	}

	summaries := make([]connSummary, len(datasources))
	for i, ds := range datasources {
		summaries[i] = connSummary{
			ID:          ds.ID,
			Name:        ds.Name,
			Type:        string(ds.Type),
			Description: ds.Description,
		}
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Found %d connection(s)", len(datasources)),
		Data:    summaries,
	}, nil
}

// executeListDeviceTypes lists all available device types for control configuration
func (e *ToolExecutor) executeListDeviceTypes(ctx context.Context) (*ToolResult, error) {
	deviceTypes, _, err := e.deviceTypeRepo.List(ctx, &models.DeviceTypeQueryParams{PageSize: 100})
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to list device types: " + err.Error()}, nil
	}

	type dtSummary struct {
		ID             string   `json:"id"`
		Name           string   `json:"name"`
		Description    string   `json:"description,omitempty"`
		Category       string   `json:"category"`
		Protocol       string   `json:"protocol"`
		SupportedTypes []string `json:"supported_types"`
	}

	summaries := make([]dtSummary, len(deviceTypes))
	for i, dt := range deviceTypes {
		summaries[i] = dtSummary{
			ID:             dt.ID,
			Name:           dt.Name,
			Description:    dt.Description,
			Category:       dt.Category,
			Protocol:       dt.Protocol,
			SupportedTypes: dt.SupportedTypes,
		}
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Found %d device type(s). Set device_type_id in update_control_config to one of these IDs.", len(deviceTypes)),
		Data:    summaries,
	}, nil
}

// executeGetConnectionSchema gets the schema (tables and columns) for a SQL data source
func (e *ToolExecutor) executeGetConnectionSchema(ctx context.Context, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID string `json:"connection_id"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "connection_id is required"}, nil
	}

	response, err := e.connectionSvc.GetSchema(ctx, params.ConnectionID)
	if err != nil {
		return &ToolResult{Success: false, Error: "schema discovery failed: " + err.Error()}, nil
	}

	if !response.Success {
		return &ToolResult{Success: false, Error: response.Error}, nil
	}

	// Format schema info for AI consumption
	tableCount := len(response.Schema.Tables)
	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Found %d table(s) in database", tableCount),
		Data:    response.Schema,
	}, nil
}

// executeGetEdgeLakeSchema gets databases, tables, and columns from an EdgeLake data source
func (e *ToolExecutor) executeGetEdgeLakeSchema(ctx context.Context, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID string `json:"connection_id"`
		Database     string `json:"database,omitempty"`
		Table        string `json:"table,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "connection_id is required"}, nil
	}

	// Verify this is an EdgeLake data source
	ds, err := e.connectionSvc.GetConnection(ctx, params.ConnectionID)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get data source: " + err.Error()}, nil
	}
	if ds.Type != "edgelake" {
		return &ToolResult{Success: false, Error: "This data source is not an EdgeLake data source. Use get_datasource_schema for SQL sources or get_prometheus_schema for Prometheus."}, nil
	}

	// If no database specified, return list of databases
	if params.Database == "" {
		databases, err := e.connectionSvc.GetEdgeLakeDatabases(ctx, params.ConnectionID)
		if err != nil {
			return &ToolResult{Success: false, Error: "failed to get databases: " + err.Error()}, nil
		}
		return &ToolResult{
			Success: true,
			Message: fmt.Sprintf("Found %d database(s) in EdgeLake. Specify a database to see its tables.", len(databases)),
			Data:    map[string]interface{}{"databases": databases},
		}, nil
	}

	// If database specified but no table, return list of tables
	if params.Table == "" {
		tables, err := e.connectionSvc.GetEdgeLakeTables(ctx, params.ConnectionID, params.Database)
		if err != nil {
			return &ToolResult{Success: false, Error: "failed to get tables: " + err.Error()}, nil
		}
		return &ToolResult{
			Success: true,
			Message: fmt.Sprintf("Found %d table(s) in database '%s'. Specify a table to see its columns.", len(tables), params.Database),
			Data:    map[string]interface{}{"database": params.Database, "tables": tables},
		}, nil
	}

	// Database and table specified, return column schema
	columns, err := e.connectionSvc.GetEdgeLakeSchema(ctx, params.ConnectionID, params.Database, params.Table)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get table schema: " + err.Error()}, nil
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Table '%s.%s' has %d column(s)", params.Database, params.Table, len(columns)),
		Data: map[string]interface{}{
			"database": params.Database,
			"table":    params.Table,
			"columns":  columns,
		},
	}, nil
}

// executeGetPrometheusSchema gets the schema (metrics and labels) for a Prometheus data source
func (e *ToolExecutor) executeGetPrometheusSchema(ctx context.Context, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID string `json:"connection_id"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "connection_id is required"}, nil
	}

	response, err := e.connectionSvc.GetSchema(ctx, params.ConnectionID)
	if err != nil {
		return &ToolResult{Success: false, Error: "Prometheus schema discovery failed: " + err.Error()}, nil
	}

	if !response.Success {
		return &ToolResult{Success: false, Error: response.Error}, nil
	}

	// Check if this is a Prometheus schema response
	if response.PrometheusSchema == nil {
		return &ToolResult{Success: false, Error: "This data source is not a Prometheus data source. Use get_datasource_schema for SQL sources."}, nil
	}

	// Format schema info for AI consumption
	metricCount := len(response.PrometheusSchema.Metrics)
	labelCount := len(response.PrometheusSchema.Labels)

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Found %d metric(s) and %d label(s) in Prometheus", metricCount, labelCount),
		Data:    response.PrometheusSchema,
	}, nil
}

// executePreviewData gets sample data for the current chart configuration
func (e *ToolExecutor) executePreviewData(ctx context.Context, chartID string, chartVersion int, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Limit *int `json:"limit,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	if chart.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "chart has no data source configured"}, nil
	}

	limit := 10
	if params.Limit != nil {
		limit = *params.Limit
	}

	query := ""
	if chart.QueryConfig != nil && chart.QueryConfig.Raw != "" {
		query = chart.QueryConfig.Raw
	}

	req := &models.QueryRequest{
		Query: models.Query{
			Raw: query,
			Params: map[string]interface{}{
				"limit": limit,
			},
		},
	}

	response, err := e.connectionSvc.QueryConnection(ctx, chart.ConnectionID, req)
	if err != nil {
		return &ToolResult{Success: false, Error: "query failed: " + err.Error()}, nil
	}

	// Check if ResultSet is nil (datasource may not have returned data)
	if response == nil || response.ResultSet == nil {
		return &ToolResult{
			Success: true,
			Message: "Preview returned 0 rows (no data available)",
			Data:    nil,
		}, nil
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Preview returned %d rows", len(response.ResultSet.Rows)),
		Data:    response.ResultSet,
	}, nil
}

// executeGetComponentState returns the current component state
func (e *ToolExecutor) executeGetComponentState(ctx context.Context, chartID string, chartVersion int) (*ToolResult, error) {
	chart, err := e.componentRepo.FindByIDAndVersion(ctx, chartID, chartVersion)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get chart: " + err.Error()}, nil
	}
	if chart == nil {
		return &ToolResult{Success: false, Error: fmt.Sprintf("chart not found: %s v%d", chartID, chartVersion)}, nil
	}

	return &ToolResult{
		Success: true,
		Data:    chart,
	}, nil
}

// executeSuggestMissing handles the suggest_missing_tools tool
func (e *ToolExecutor) executeSuggestMissing(input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Feature    string `json:"feature"`
		Suggestion string `json:"suggestion"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	return &ToolResult{
		Success: true,
		Message: fmt.Sprintf("Feature '%s' is not directly supported. %s", params.Feature, params.Suggestion),
		Data: map[string]string{
			"feature":    params.Feature,
			"suggestion": params.Suggestion,
		},
	}, nil
}

// executeGetSchema returns unified schema information for any datasource type
func (e *ToolExecutor) executeGetSchema(ctx context.Context, input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ConnectionID string `json:"connection_id"`
		Database     string `json:"database,omitempty"`
		Table        string `json:"table,omitempty"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ConnectionID == "" {
		return &ToolResult{Success: false, Error: "connection_id is required"}, nil
	}

	// Get the datasource
	ds, err := e.connectionRepo.FindByID(ctx, params.ConnectionID)
	if err != nil {
		return &ToolResult{Success: false, Error: "failed to get data source: " + err.Error()}, nil
	}
	if ds == nil {
		return &ToolResult{Success: false, Error: "data source not found: " + params.ConnectionID}, nil
	}

	sourceInfo := models.UnifiedSchemaSourceInfo{
		ID:   ds.ID,
		Name: ds.Name,
		Type: string(ds.Type),
	}

	var schema models.UnifiedSchema

	switch ds.Type {
	case models.ConnectionTypeSQL:
		schema, err = e.getSQLUnifiedSchema(ctx, params.ConnectionID, params.Table)
	case models.ConnectionTypePrometheus:
		schema, err = e.getPrometheusUnifiedSchema(ctx, params.ConnectionID)
	case models.ConnectionTypeEdgeLake:
		schema, err = e.getEdgeLakeUnifiedSchema(ctx, params.ConnectionID, params.Database, params.Table)
	case models.ConnectionTypeAPI, models.ConnectionTypeCSV, models.ConnectionTypeSocket, models.ConnectionTypeTSStore:
		schema, err = e.inferSchemaFromData(ctx, params.ConnectionID)
	default:
		return &ToolResult{Success: false, Error: fmt.Sprintf("unsupported datasource type: %s", ds.Type)}, nil
	}

	if err != nil {
		return &ToolResult{Success: false, Error: "schema discovery failed: " + err.Error()}, nil
	}

	response := models.UnifiedSchemaResponse{
		Connection: sourceInfo,
		Schema:     schema,
	}

	// Generate summary message
	var message string
	if len(schema.Tables) > 0 {
		message = fmt.Sprintf("Found %d table(s)", len(schema.Tables))
	} else if len(schema.Columns) > 0 {
		message = fmt.Sprintf("Found %d column(s)", len(schema.Columns))
	} else if len(schema.Metrics) > 0 {
		message = fmt.Sprintf("Found %d metric(s) and %d label(s)", len(schema.Metrics), len(schema.Labels))
	} else {
		message = "Schema retrieved successfully"
	}

	return &ToolResult{
		Success: true,
		Message: message,
		Data:    response,
	}, nil
}

// getSQLUnifiedSchema gets schema from SQL datasource in unified format
func (e *ToolExecutor) getSQLUnifiedSchema(ctx context.Context, connectionID, tableName string) (models.UnifiedSchema, error) {
	response, err := e.connectionSvc.GetSchema(ctx, connectionID)
	if err != nil {
		return models.UnifiedSchema{}, err
	}
	if !response.Success || response.Schema == nil {
		return models.UnifiedSchema{}, fmt.Errorf("schema discovery failed: %s", response.Error)
	}

	schema := models.UnifiedSchema{
		Tables: make([]models.UnifiedSchemaTable, 0),
	}

	for _, table := range response.Schema.Tables {
		// If tableName specified, only include that table
		if tableName != "" && table.Name != tableName {
			continue
		}

		unifiedTable := models.UnifiedSchemaTable{
			Name:    table.Name,
			Columns: make([]models.UnifiedSchemaColumn, len(table.Columns)),
		}

		for i, col := range table.Columns {
			unifiedTable.Columns[i] = models.UnifiedSchemaColumn{
				Name: col.Name,
				Type: normalizeColumnType(col.Type),
			}
		}

		schema.Tables = append(schema.Tables, unifiedTable)
	}

	return schema, nil
}

// getPrometheusUnifiedSchema gets schema from Prometheus datasource in unified format
func (e *ToolExecutor) getPrometheusUnifiedSchema(ctx context.Context, connectionID string) (models.UnifiedSchema, error) {
	response, err := e.connectionSvc.GetSchema(ctx, connectionID)
	if err != nil {
		return models.UnifiedSchema{}, err
	}
	if !response.Success || response.PrometheusSchema == nil {
		return models.UnifiedSchema{}, fmt.Errorf("Prometheus schema discovery failed: %s", response.Error)
	}

	metrics := make([]string, len(response.PrometheusSchema.Metrics))
	for i, m := range response.PrometheusSchema.Metrics {
		metrics[i] = m.Name
	}

	return models.UnifiedSchema{
		Metrics: metrics,
		Labels:  response.PrometheusSchema.Labels,
	}, nil
}

// getEdgeLakeUnifiedSchema gets schema from EdgeLake datasource in unified format
func (e *ToolExecutor) getEdgeLakeUnifiedSchema(ctx context.Context, connectionID, database, table string) (models.UnifiedSchema, error) {
	schema := models.UnifiedSchema{}

	// If no database specified, return list of databases
	if database == "" {
		databases, err := e.connectionSvc.GetEdgeLakeDatabases(ctx, connectionID)
		if err != nil {
			return schema, err
		}
		// Return as empty tables list with a note - caller should specify database
		// Using tables structure to hold database names as table names
		schema.Tables = make([]models.UnifiedSchemaTable, len(databases))
		for i, db := range databases {
			schema.Tables[i] = models.UnifiedSchemaTable{Name: db}
		}
		return schema, nil
	}

	// If database but no table, return list of tables
	if table == "" {
		tables, err := e.connectionSvc.GetEdgeLakeTables(ctx, connectionID, database)
		if err != nil {
			return schema, err
		}
		schema.Tables = make([]models.UnifiedSchemaTable, len(tables))
		for i, t := range tables {
			schema.Tables[i] = models.UnifiedSchemaTable{Name: t}
		}
		return schema, nil
	}

	// Database and table specified, return columns
	columns, err := e.connectionSvc.GetEdgeLakeSchema(ctx, connectionID, database, table)
	if err != nil {
		return schema, err
	}

	unifiedTable := models.UnifiedSchemaTable{
		Name:    table,
		Columns: make([]models.UnifiedSchemaColumn, len(columns)),
	}
	for i, col := range columns {
		unifiedTable.Columns[i] = models.UnifiedSchemaColumn{
			Name: col.Name,
			Type: normalizeColumnType(col.Type),
		}
	}
	schema.Tables = []models.UnifiedSchemaTable{unifiedTable}

	return schema, nil
}

// inferSchemaFromData infers schema by querying sample data
func (e *ToolExecutor) inferSchemaFromData(ctx context.Context, connectionID string) (models.UnifiedSchema, error) {
	// Query sample data (limit to 100 rows for inference)
	req := &models.QueryRequest{
		Query: models.Query{
			Raw: "",
			Params: map[string]interface{}{
				"limit": 100,
			},
		},
	}

	response, err := e.connectionSvc.QueryConnection(ctx, connectionID, req)
	if err != nil {
		return models.UnifiedSchema{}, fmt.Errorf("failed to query sample data: %w", err)
	}

	if response.ResultSet == nil || len(response.ResultSet.Columns) == 0 {
		return models.UnifiedSchema{}, fmt.Errorf("no data available for schema inference")
	}

	schema := models.UnifiedSchema{
		Columns:  make([]models.UnifiedSchemaColumn, len(response.ResultSet.Columns)),
		RowCount: len(response.ResultSet.Rows),
	}

	for i, colName := range response.ResultSet.Columns {
		// Collect all values for this column
		values := make([]interface{}, 0, len(response.ResultSet.Rows))
		for _, row := range response.ResultSet.Rows {
			if i < len(row) {
				values = append(values, row[i])
			}
		}

		col := inferColumnSchema(colName, values)
		schema.Columns[i] = col
	}

	return schema, nil
}

// inferColumnSchema infers the schema for a single column from its values
func inferColumnSchema(colName string, values []interface{}) models.UnifiedSchemaColumn {
	col := models.UnifiedSchemaColumn{
		Name: colName,
		Type: "mixed",
	}

	if len(values) == 0 {
		return col
	}

	// Track types seen
	var hasInt, hasFloat, hasBool, hasString bool
	var firstNonNil interface{}
	uniqueStrings := make(map[string]bool)
	var minNum, maxNum float64
	var hasNumeric bool

	for _, v := range values {
		if v == nil {
			continue
		}

		if firstNonNil == nil {
			firstNonNil = v
		}

		switch val := v.(type) {
		case bool:
			hasBool = true
		case int, int8, int16, int32, int64:
			hasInt = true
			num := toFloat64(v)
			if !hasNumeric {
				minNum, maxNum = num, num
				hasNumeric = true
			} else {
				if num < minNum {
					minNum = num
				}
				if num > maxNum {
					maxNum = num
				}
			}
		case uint, uint8, uint16, uint32, uint64:
			hasInt = true
			num := toFloat64(v)
			if !hasNumeric {
				minNum, maxNum = num, num
				hasNumeric = true
			} else {
				if num < minNum {
					minNum = num
				}
				if num > maxNum {
					maxNum = num
				}
			}
		case float32, float64:
			hasFloat = true
			num := toFloat64(v)
			if !hasNumeric {
				minNum, maxNum = num, num
				hasNumeric = true
			} else {
				if num < minNum {
					minNum = num
				}
				if num > maxNum {
					maxNum = num
				}
			}
		case json.Number:
			// Try to parse as int first, then float
			if _, err := val.Int64(); err == nil {
				hasInt = true
			} else {
				hasFloat = true
			}
			num, _ := val.Float64()
			if !hasNumeric {
				minNum, maxNum = num, num
				hasNumeric = true
			} else {
				if num < minNum {
					minNum = num
				}
				if num > maxNum {
					maxNum = num
				}
			}
		case string:
			hasString = true
			uniqueStrings[val] = true
		default:
			// Check if it's a numeric type via reflection
			num := toFloat64(v)
			if num != 0 || fmt.Sprintf("%v", v) == "0" {
				hasFloat = true
				if !hasNumeric {
					minNum, maxNum = num, num
					hasNumeric = true
				} else {
					if num < minNum {
						minNum = num
					}
					if num > maxNum {
						maxNum = num
					}
				}
			} else {
				hasString = true
				uniqueStrings[fmt.Sprintf("%v", v)] = true
			}
		}
	}

	col.Sample = firstNonNil

	// Determine type
	typeCount := 0
	if hasBool {
		typeCount++
	}
	if hasInt || hasFloat {
		typeCount++
	}
	if hasString {
		typeCount++
	}

	if typeCount > 1 {
		col.Type = "mixed"
	} else if hasBool {
		col.Type = "boolean"
	} else if hasInt && !hasFloat {
		// Check if this looks like a timestamp
		if isTimestampColumn(colName, minNum, maxNum) {
			col.Type = "timestamp"
		} else {
			col.Type = "integer"
			col.Min = int64(minNum)
			col.Max = int64(maxNum)
		}
	} else if hasFloat || hasInt {
		col.Type = "float"
		col.Min = minNum
		col.Max = maxNum
	} else if hasString {
		col.Type = "string"
		// Include unique values if ≤20
		if len(uniqueStrings) <= 20 {
			col.UniqueValues = make([]interface{}, 0, len(uniqueStrings))
			for s := range uniqueStrings {
				col.UniqueValues = append(col.UniqueValues, s)
			}
		}
		col.UniqueCount = len(uniqueStrings)
	}

	return col
}

// isTimestampColumn checks if a numeric column is likely a timestamp
func isTimestampColumn(colName string, min, max float64) bool {
	// Check column name hints
	nameLower := string(colName)
	if contains(nameLower, "time") || contains(nameLower, "date") || contains(nameLower, "timestamp") || contains(nameLower, "created") || contains(nameLower, "updated") {
		return true
	}

	// Check if values are in Unix timestamp range (seconds: 1970-2100)
	// Seconds: 0 to ~4102444800 (year 2100)
	// Milliseconds: > 1000000000000
	if min >= 1000000000 && max <= 4102444800000 {
		return true
	}

	return false
}

// contains checks if a string contains a substring (case insensitive)
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) == 0 ||
		(len(s) > 0 && containsLower(toLower(s), toLower(substr))))
}

func containsLower(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}

func toLower(s string) string {
	result := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'A' && c <= 'Z' {
			result[i] = c + 32
		} else {
			result[i] = c
		}
	}
	return string(result)
}

// toFloat64 converts a numeric value to float64
func toFloat64(v interface{}) float64 {
	switch val := v.(type) {
	case int:
		return float64(val)
	case int8:
		return float64(val)
	case int16:
		return float64(val)
	case int32:
		return float64(val)
	case int64:
		return float64(val)
	case uint:
		return float64(val)
	case uint8:
		return float64(val)
	case uint16:
		return float64(val)
	case uint32:
		return float64(val)
	case uint64:
		return float64(val)
	case float32:
		return float64(val)
	case float64:
		return val
	case json.Number:
		f, _ := val.Float64()
		return f
	default:
		return 0
	}
}

// normalizeColumnType normalizes database column types to unified types
func normalizeColumnType(dbType string) string {
	lower := toLower(dbType)

	// Timestamp types
	if contains(lower, "timestamp") || contains(lower, "datetime") || contains(lower, "date") || contains(lower, "time") {
		return "timestamp"
	}

	// Integer types
	if contains(lower, "int") || contains(lower, "serial") || lower == "bigint" || lower == "smallint" || lower == "tinyint" {
		return "integer"
	}

	// Float types
	if contains(lower, "float") || contains(lower, "double") || contains(lower, "decimal") || contains(lower, "numeric") || contains(lower, "real") {
		return "float"
	}

	// Boolean
	if contains(lower, "bool") {
		return "boolean"
	}

	// Default to string for text, varchar, char, etc.
	return "string"
}
