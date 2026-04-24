// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"encoding/json"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/componenttemplates"
)

// executeGetComponentTemplate returns the template for a specific chart type.
// The template registry itself lives in internal/componenttemplates so the
// MCP tool surface can read from the same source without this package
// becoming a dependency of internal/mcp.
func (e *ToolExecutor) executeGetComponentTemplate(input json.RawMessage) (*ToolResult, error) {
	var params struct {
		ChartType string `json:"chart_type"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}

	if params.ChartType == "" {
		return &ToolResult{Success: false, Error: "chart_type is required"}, nil
	}

	template, exists := componenttemplates.Get(params.ChartType)
	if !exists {
		return &ToolResult{
			Success: false,
			Error:   fmt.Sprintf("No template for chart type '%s'. Use 'custom' for general guidelines.", params.ChartType),
		}, nil
	}

	message := fmt.Sprintf("Template for %s chart. Replace column names (timestamp, value, etc.) with actual columns from get_schema.", params.ChartType)
	if params.ChartType == "custom" {
		message = "Custom component template with Carbon g100 colors and formatting guidelines."
	}

	return &ToolResult{
		Success: true,
		Message: message,
		Data: map[string]string{
			"template": template,
		},
	}, nil
}
