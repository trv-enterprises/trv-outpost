// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"encoding/json"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/connectionguidance"
)

// executeGetConnectionTypeGuidance serves the in-built component agent's
// counterpart to the MCP `get_connection_type_guidance` tool. Reads from
// the same shared `connectionguidance` package so both surfaces stay in
// sync — adding a new adapter type updates the prose in one place.
func (e *ToolExecutor) executeGetConnectionTypeGuidance(input json.RawMessage) (*ToolResult, error) {
	var params struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(input, &params); err != nil {
		return &ToolResult{Success: false, Error: "invalid input: " + err.Error()}, nil
	}
	if params.Type == "" {
		return &ToolResult{Success: false, Error: "type is required"}, nil
	}

	text, ok := connectionguidance.Get(params.Type)
	message := fmt.Sprintf("Guidance for connection type %q.", params.Type)
	if !ok {
		message = fmt.Sprintf("No dedicated guidance for connection type %q — returning fallback discovery hint.", params.Type)
	}
	return &ToolResult{
		Success: true,
		Message: message,
		Data: map[string]string{
			"type":     params.Type,
			"guidance": text,
		},
	}, nil
}
