// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// CommandHandler handles command execution for bidirectional datasources and controls
type CommandHandler struct {
	connectionService  *service.ConnectionService
	componentService       *service.ComponentService
	deviceTypeService  *service.DeviceTypeService
}

// NewCommandHandler creates a new command handler
func NewCommandHandler(connectionService *service.ConnectionService, componentService *service.ComponentService, deviceTypeService *service.DeviceTypeService) *CommandHandler {
	return &CommandHandler{
		connectionService:  connectionService,
		componentService:       componentService,
		deviceTypeService:  deviceTypeService,
	}
}

// ExecuteCommandRequest represents a command to execute
type ExecuteCommandRequest struct {
	Action  string                 `json:"action" binding:"required"`
	Target  string                 `json:"target,omitempty"`
	Payload map[string]interface{} `json:"payload,omitempty"`
}

// ExecuteCommandResponse represents the command execution result
type ExecuteCommandResponse struct {
	Success   bool                   `json:"success"`
	Message   string                 `json:"message,omitempty"`
	Data      map[string]interface{} `json:"data,omitempty"`
	Timestamp string                 `json:"timestamp"`
}

// ExecuteCommand godoc
// @Summary Execute a command on a bidirectional datasource
// @Description Send a command to a datasource that supports write operations (e.g., stream.websocket-bidir)
// @Tags datasources
// @Accept json
// @Produce json
// @Param id path string true "Datasource ID"
// @Param command body ExecuteCommandRequest true "Command to execute"
// @Success 200 {object} ExecuteCommandResponse
// @Failure 400 {object} map[string]interface{} "Bad request - connection does not support write"
// @Failure 404 {object} map[string]interface{} "Datasource not found"
// @Failure 500 {object} map[string]interface{} "Internal server error"
// @Router /api/datasources/{id}/command [post]
func (h *CommandHandler) ExecuteCommand(c *gin.Context) {
	id := c.Param("id")

	var req ExecuteCommandRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get the datasource
	datasource, err := h.connectionService.GetConnection(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "datasource not found"})
		return
	}

	// Create adapter from datasource
	adapter, err := h.connectionService.CreateAdapter(c.Request.Context(), datasource)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer adapter.Close()

	// Check if adapter supports write
	if !adapter.Capabilities().CanWrite {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "connection does not support write operations",
			"type_id": adapter.TypeID(),
			"hint":    "Use a bidirectional connection type (e.g., stream.websocket-bidir)",
		})
		return
	}

	// Connect first
	if err := adapter.Connect(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to connect: " + err.Error()})
		return
	}

	// Execute the command
	cmd := registry.Command{
		Action:  req.Action,
		Target:  req.Target,
		Payload: req.Payload,
	}

	result, err := adapter.Write(c.Request.Context(), cmd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, ExecuteCommandResponse{
		Success:   result.Success,
		Message:   result.Message,
		Data:      result.Data,
		Timestamp: result.Timestamp.Format("2006-01-02T15:04:05Z07:00"),
	})
}

// ExecuteControlRequest represents a control execution request
type ExecuteControlRequest struct {
	Value interface{} `json:"value"` // The value from the control (bool, number, string, or null for buttons)
}

// ExecuteControlCommand godoc
// @Summary Execute a control component command
// @Description Executes the command configured on a control component, using either schema-based or legacy template interpolation
// @Tags controls
// @Accept json
// @Produce json
// @Param id path string true "Control (Chart) ID"
// @Param request body ExecuteControlRequest true "Control value"
// @Success 200 {object} ExecuteCommandResponse
// @Failure 400 {object} map[string]interface{} "Bad request - not a control or missing connection"
// @Failure 404 {object} map[string]interface{} "Control not found"
// @Failure 500 {object} map[string]interface{} "Internal server error"
// @Router /api/controls/{id}/execute [post]
func (h *CommandHandler) ExecuteControlCommand(c *gin.Context) {
	controlID := c.Param("id")

	var req ExecuteControlRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Get the control (stored as a chart with component_type="control")
	chart, err := h.componentService.GetComponent(c.Request.Context(), controlID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "control not found"})
		return
	}

	// Validate it's a control type
	if chart.ComponentType != models.ComponentTypeControl {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":          "component is not a control",
			"component_type": chart.ComponentType,
		})
		return
	}

	// Validate control has configuration
	if chart.ControlConfig == nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "control has no configuration"})
		return
	}

	// Validate connection is set
	if chart.ConnectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "control has no connection configured"})
		return
	}

	// Get the connection
	datasource, err := h.connectionService.GetConnection(c.Request.Context(), chart.ConnectionID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "connection not found"})
		return
	}

	// Create adapter
	adapter, err := h.connectionService.CreateAdapter(c.Request.Context(), datasource)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	defer adapter.Close()

	// Check if adapter supports write
	if !adapter.Capabilities().CanWrite {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":   "connection does not support write operations",
			"type_id": adapter.TypeID(),
			"hint":    "Use a bidirectional connection type (e.g., stream.websocket-bidir)",
		})
		return
	}

	// Connect
	if err := adapter.Connect(c.Request.Context()); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to connect: " + err.Error()})
		return
	}

	// Build the command - use schema if available, otherwise use legacy command config
	var cmd registry.Command
	controlConfig := chart.ControlConfig

	if controlConfig.ControlType == models.ControlTypeMqttPublish {
		// mqtt_publish: raw topic + payload, no device type needed
		if controlConfig.Target == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "mqtt_publish control has no topic (target) configured"})
			return
		}
		payload, _ := controlConfig.UIConfig["payload"].(map[string]interface{})
		if payload == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "mqtt_publish control has no payload configured in ui_config"})
			return
		}
		cmd = registry.Command{
			Action:  "publish",
			Target:  controlConfig.Target,
			Payload: payload,
		}
	} else if controlConfig.DeviceTypeID != "" {
		// Device type-based control
		cmd, err = h.buildCommandFromDeviceType(c, controlConfig, req.Value)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	} else if controlConfig.CommandConfig != nil {
		// Legacy command config
		cmdConfig := controlConfig.CommandConfig
		payload := interpolatePayload(cmdConfig.PayloadTemplate, req.Value)
		cmd = registry.Command{
			Action:  cmdConfig.Action,
			Target:  cmdConfig.Target,
			Payload: payload,
		}
	} else {
		c.JSON(http.StatusBadRequest, gin.H{"error": "control has no device type or command configuration"})
		return
	}

	result, err := adapter.Write(c.Request.Context(), cmd)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, ExecuteCommandResponse{
		Success:   result.Success,
		Message:   result.Message,
		Data:      result.Data,
		Timestamp: result.Timestamp.Format("2006-01-02T15:04:05Z07:00"),
	})
}

// buildCommandFromDeviceType builds a command using a device type's command template
func (h *CommandHandler) buildCommandFromDeviceType(c *gin.Context, controlConfig *models.ControlConfig, value interface{}) (registry.Command, error) {
	// Get the device type
	deviceType, err := h.deviceTypeService.GetDeviceType(c.Request.Context(), controlConfig.DeviceTypeID)
	if err != nil {
		return registry.Command{}, fmt.Errorf("failed to load device type '%s': %w", controlConfig.DeviceTypeID, err)
	}

	// Get the command definition for this control type
	// Tile controls (tile_switch, tile_dimmer) map to their base type
	// "switch" maps to "plug" for backward compat with existing device type commands
	lookupType := controlConfig.ControlType
	if strings.HasPrefix(lookupType, "tile_") {
		lookupType = strings.TrimPrefix(lookupType, "tile_")
	}
	if lookupType == "switch" {
		lookupType = "plug"
	}
	commandDef, ok := deviceType.Commands[lookupType]
	if !ok {
		return registry.Command{}, fmt.Errorf("device type '%s' does not support control type '%s'", deviceType.ID, controlConfig.ControlType)
	}

	// Apply value mapping if present
	mappedValue := value
	if commandDef.ValueMap != nil && value != nil {
		valueStr := valueToString(value)
		if mapped, ok := commandDef.ValueMap[valueStr]; ok {
			mappedValue = mapped
		}
	}

	// Interpolate the template with {{value}} and {{target}}
	payload := interpolateSchemaTemplate(commandDef.Template, mappedValue, controlConfig.Target)

	// Extract action from payload if present, otherwise use a default
	action := "execute"
	if actionVal, ok := payload["action"]; ok {
		if actionStr, ok := actionVal.(string); ok {
			action = actionStr
		}
	}

	return registry.Command{
		Action:  action,
		Target:  controlConfig.Target,
		Payload: payload,
	}, nil
}

// interpolateSchemaTemplate replaces {{value}} and {{target}} placeholders in a schema template
func interpolateSchemaTemplate(template map[string]interface{}, value interface{}, target string) map[string]interface{} {
	if template == nil {
		return map[string]interface{}{"value": value}
	}

	result := make(map[string]interface{})
	for key, val := range template {
		result[key] = interpolateSchemaValue(val, value, target)
	}
	return result
}

// interpolateSchemaValue recursively replaces {{value}} and {{target}} in nested structures
func interpolateSchemaValue(templateVal interface{}, value interface{}, target string) interface{} {
	switch v := templateVal.(type) {
	case string:
		// Check for exact placeholders first
		if v == "{{value}}" {
			return value
		}
		if v == "{{target}}" {
			return target
		}
		// Check for substring replacements
		result := v
		if strings.Contains(result, "{{value}}") {
			valueStr := valueToString(value)
			result = strings.ReplaceAll(result, "{{value}}", valueStr)
		}
		if strings.Contains(result, "{{target}}") {
			result = strings.ReplaceAll(result, "{{target}}", target)
		}
		return result
	case map[string]interface{}:
		// Recursively process nested maps
		result := make(map[string]interface{})
		for k, nestedVal := range v {
			result[k] = interpolateSchemaValue(nestedVal, value, target)
		}
		return result
	case []interface{}:
		// Recursively process arrays
		result := make([]interface{}, len(v))
		for i, item := range v {
			result[i] = interpolateSchemaValue(item, value, target)
		}
		return result
	default:
		return v
	}
}

// interpolatePayload replaces {{value}} placeholders in the payload template with the actual value
// (Legacy support for controls without device_type_id)
func interpolatePayload(template map[string]interface{}, value interface{}) map[string]interface{} {
	if template == nil {
		// If no template, just return the value as-is
		return map[string]interface{}{"value": value}
	}

	result := make(map[string]interface{})
	for key, val := range template {
		result[key] = interpolateValue(val, value)
	}
	return result
}

// interpolateValue recursively replaces {{value}} in nested structures
// (Legacy support for controls without device_type_id)
func interpolateValue(templateVal interface{}, value interface{}) interface{} {
	switch v := templateVal.(type) {
	case string:
		// Check if the entire string is "{{value}}"
		if v == "{{value}}" {
			return value
		}
		// Check if string contains {{value}} as a substring
		if strings.Contains(v, "{{value}}") {
			// Convert value to string for interpolation
			valueStr := valueToString(value)
			return strings.ReplaceAll(v, "{{value}}", valueStr)
		}
		return v
	case map[string]interface{}:
		// Recursively process nested maps
		result := make(map[string]interface{})
		for k, nestedVal := range v {
			result[k] = interpolateValue(nestedVal, value)
		}
		return result
	case []interface{}:
		// Recursively process arrays
		result := make([]interface{}, len(v))
		for i, item := range v {
			result[i] = interpolateValue(item, value)
		}
		return result
	default:
		return v
	}
}

// valueToString converts a value to its string representation
func valueToString(value interface{}) string {
	if value == nil {
		return "null"
	}
	switch v := value.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		return fmt.Sprintf("%g", v)
	case int:
		return fmt.Sprintf("%d", v)
	default:
		// For complex types, use JSON encoding
		bytes, _ := json.Marshal(v)
		return string(bytes)
	}
}
