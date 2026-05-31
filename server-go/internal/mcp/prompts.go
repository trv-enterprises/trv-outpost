// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"fmt"
)

// Prompt names. The slash-command the user sees in Claude Desktop
// is the name verbatim, so keep it stable — renaming breaks any
// saved shortcuts.
const (
	PromptDashboardBuilder = "dashboard-builder"
)

// buildPromptCatalog returns the static list of prompts this server
// advertises. Today there's exactly one — the dashboard-builder
// persona. New personas (e.g. a future component-debugger or
// connection-troubleshooter) get appended here.
func buildPromptCatalog() []Prompt {
	return []Prompt{
		{
			Name: PromptDashboardBuilder,
			Description: "Persona that builds dashboards end-to-end: " +
				"discover connections and their data shape, create components " +
				"(charts/controls/displays), then assemble a dashboard. " +
				"Opinionated about naming, namespace stamping, the " +
				"create-component-then-template flow, and grid-fit. Pick this " +
				"when you want the model to act as a builder rather than a " +
				"free-form assistant.",
		},
	}
}

// handlePromptsList serves the `prompts/list` MCP method.
func (h *Handler) handlePromptsList() PromptsListResult {
	return PromptsListResult{Prompts: buildPromptCatalog()}
}

// handlePromptsGet serves the `prompts/get` MCP method. The client
// passes a name (and optionally arguments — unused today). We return
// the prompt's content wrapped in a single user-role message so the
// client treats it as system/role framing for the conversation.
func (h *Handler) handlePromptsGet(params map[string]interface{}) (PromptsGetResult, error) {
	name, _ := params["name"].(string)
	if name == "" {
		return PromptsGetResult{}, fmt.Errorf("prompts/get requires a name")
	}

	switch name {
	case PromptDashboardBuilder:
		text := dashboardBuilderRole + "\n\n" + dashboardBuilderFlow
		return PromptsGetResult{
			Description: "Dashboard-builder persona for trve-dashboard.",
			Messages: []PromptMessage{
				{
					Role: "user",
					Content: PromptContent{
						Type: "text",
						Text: text,
					},
				},
			},
		}, nil
	default:
		return PromptsGetResult{}, fmt.Errorf("unknown prompt: %s", name)
	}
}
