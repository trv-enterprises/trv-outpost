// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/connectionguidance"
)

// registerGuidanceTools wires the small "answer my question about
// THIS specific axis of the system" tools — things the LLM can't
// infer from training data because they're TRVE-dashboard-specific
// envelope shapes, but that also don't deserve to bloat the
// initialize Instructions string for every MCP consumer regardless
// of whether they need them.
func (r *ToolRegistry) registerGuidanceTools() {
	r.registerTool(
		Tool{
			Name: "list_dashboard_dimensions",
			Description: "List the canvas-size presets configured for this deployment, plus the deployment's default. " +
				"Returns `dimensions` (array of `{name, width, height}`) and `default_name`. " +
				"Call this when the user hasn't specified a canvas size — the presets are what the dashboard editor uses and what the grid math (cols/rows) is keyed off.",
			InputSchema: InputSchema{Type: "object"},
		},
		func(args map[string]interface{}) (interface{}, error) {
			return r.handleListDashboardDimensions()
		},
	)

	r.registerTool(
		Tool{
			Name: "get_connection_type_guidance",
			Description: "Get the `query_config` envelope shape and return-column conventions for a specific connection adapter type. " +
				"Call this AFTER you've picked which connection to use — it tells you how to build `query_config` for that adapter type. " +
				"The general 'what charts make sense for this data' question is your own to answer; this tool only covers TRVE-dashboard-specific envelope wrapping.",
			InputSchema: InputSchema{
				Type: "object",
				Properties: map[string]PropertySchema{
					"type": {
						Type:        "string",
						Description: "Connection type id — e.g. `sql.postgres`, `api.prometheus`, `stream.mqtt`, `api.edgelake`. Match the values returned by `list_connection_types`.",
					},
				},
				Required: []string{"type"},
			},
		},
		func(args map[string]interface{}) (interface{}, error) {
			typeID := getString(args, "type")
			if typeID == "" {
				return nil, fmt.Errorf("type is required")
			}
			text, _ := connectionguidance.Get(typeID)
			return map[string]interface{}{
				"type":     typeID,
				"guidance": text,
			}, nil
		},
	)
}

func (r *ToolRegistry) handleListDashboardDimensions() (interface{}, error) {
	if r.settingsService == nil {
		return nil, fmt.Errorf("settings service unavailable")
	}
	ctx := context.Background()

	presets, err := r.settingsService.GetSetting(ctx, "layout_dimensions")
	if err != nil {
		return nil, fmt.Errorf("layout_dimensions: %w", err)
	}
	defaultName, err := r.settingsService.GetSetting(ctx, "default_layout_dimension")
	if err != nil {
		// Not fatal — surface what we have. The agent can fall back to
		// the first preset by convention.
		return map[string]interface{}{
			"dimensions":   presets.Value,
			"default_name": "",
			"note":         "default_layout_dimension not configured; falling back to the first preset is reasonable.",
		}, nil
	}
	return map[string]interface{}{
		"dimensions":   presets.Value,
		"default_name": defaultName.Value,
	}, nil
}
