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

	// Only the custom template remains — canonical chart types are
	// spec-driven and configured via update_data_mapping /
	// update_chart_options, not scaffolded from a template.
	template, exists := componenttemplates.Get(params.ChartType)
	if !exists {
		return &ToolResult{
			Success: false,
			Error:   fmt.Sprintf("No template for chart type '%s'. Only 'custom' exists; canonical chart types are spec-driven — configure them with update_data_mapping / update_chart_options instead.", params.ChartType),
		}, nil
	}

	return &ToolResult{
		Success: true,
		Message: "Custom component template with the CARBON_COLORS palette and formatting guidelines. Use only when configuration can't express the request; pair with set_custom_code.",
		Data: map[string]string{
			"template": template,
		},
	}, nil
}
