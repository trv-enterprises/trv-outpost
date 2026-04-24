// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package dashboard

import (
	"context"
	"encoding/json"
	"fmt"
)

// RuntimeToolName identifies a tool the agent host (not the MCP
// server) handles. These are about the conversation, not the
// dashboard domain.
const (
	ToolRequestClarification = "request_clarification"
	ToolYieldFinalAnswer     = "yield_final_answer"
)

// ClarificationArgs is the payload shape for request_clarification.
type ClarificationArgs struct {
	Question string `json:"question"`
	Reason   string `json:"reason,omitempty"`
}

// YieldArgs is the payload shape for yield_final_answer.
type YieldArgs struct {
	DashboardID string `json:"dashboard_id"`
	Summary     string `json:"summary"`
}

// RuntimeTool describes a host-handled tool for the Anthropic API
// schema.
type RuntimeTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"input_schema"`
}

// RuntimeTools returns the schemas for the two host-handled tools.
func RuntimeTools() []RuntimeTool {
	return []RuntimeTool{
		{
			Name: ToolRequestClarification,
			Description: "Ask the user a clarifying question. Use this when required information is missing and no MCP tool can supply it. The harness will get an answer and inject it as the next turn. Do not call this when you can proceed with a sensible default.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"question": map[string]interface{}{
						"type":        "string",
						"description": "The exact question to present to the user, phrased concisely.",
					},
					"reason": map[string]interface{}{
						"type":        "string",
						"description": "Optional: a one-line explanation for why this question matters, shown alongside the question.",
					},
				},
				"required": []string{"question"},
			},
		},
		{
			Name: ToolYieldFinalAnswer,
			Description: "End the run. Call this once you have created the dashboard the user asked for. The harness will stop the loop when it sees this call.",
			InputSchema: map[string]interface{}{
				"type": "object",
				"properties": map[string]interface{}{
					"dashboard_id": map[string]interface{}{
						"type":        "string",
						"description": "The ID of the dashboard you created.",
					},
					"summary": map[string]interface{}{
						"type":        "string",
						"description": "A short natural-language summary of what you built. Include the component count and the key choices (chart types, connection used, etc.).",
					},
				},
				"required": []string{"dashboard_id", "summary"},
			},
		},
	}
}

// ClarificationResolver is the interface the harness implements to
// answer request_clarification calls. CLI mode prompts on stdin; a
// chat UI would route the question to a chat bubble and wait for the
// user's reply.
type ClarificationResolver interface {
	Resolve(ctx context.Context, args ClarificationArgs) (string, error)
}

// ClarificationResolverFunc adapts a plain function to the interface.
type ClarificationResolverFunc func(ctx context.Context, args ClarificationArgs) (string, error)

// Resolve implements ClarificationResolver.
func (f ClarificationResolverFunc) Resolve(ctx context.Context, args ClarificationArgs) (string, error) {
	return f(ctx, args)
}

// parseToolInput decodes an Anthropic tool_use content block's input
// JSON into a typed struct.
func parseToolInput(raw json.RawMessage, out interface{}) error {
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("tool input parse: %w", err)
	}
	return nil
}
