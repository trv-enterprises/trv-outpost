// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Tier discriminates which prompt-assembly phase a tool's schema
// loads in. Step 5 wires this to actual on-demand loading; for now
// every registered tool is Tier-A (always inlined).
type Tier int

const (
	// TierA — schema always inlined into the per-turn prompt.
	TierA Tier = iota
	// TierB — schema loaded on demand via describe_tool meta-tool
	// (step 5).
	TierB
)

// Tool is the chat agent's per-tool record. Combines Anthropic's
// tool shape with the chat-side extras (tier + capability + handler).
type Tool struct {
	Name        string
	Description string
	Tier        Tier

	// Capability — minimum required capability. Empty means
	// "no capability gate" (any authenticated caller). Step 3 wires
	// this to enforcement.
	Capability string

	// InputSchema is the JSON-schema map the Anthropic SDK marshals
	// into its tool spec. Tier-B tools may keep this nil until their
	// schema is requested via describe_tool.
	InputSchema map[string]interface{}

	// Handler is the in-process dispatcher.
	Handler ToolHandler
}

// DispatchEnv carries per-call context the handler needs: the session
// the call originated from, plus eventually the resolved caller and
// active namespace. Step 3 fleshes this out; step 2 only needs the
// session.
type DispatchEnv struct {
	Session *models.AISession
	// Caller and Namespace land in step 3.
}

// ToolHandler is the in-process dispatcher signature. Returns the
// result the model will see — typically JSON-encoded structured data
// but plain text is fine. Errors are surfaced to the model as
// is_error tool results so it can reason about them.
type ToolHandler func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error)

// ToolRegistry holds the registered tools. Step 5 splits this by
// tier for on-demand loading; step 2 just stores them flat.
type ToolRegistry struct {
	tools []Tool
}

// NewToolRegistry creates an empty registry. Callers Register tools
// before passing the registry to NewAgent.
func NewToolRegistry() *ToolRegistry {
	return &ToolRegistry{}
}

// Register adds a tool to the registry.
func (r *ToolRegistry) Register(t Tool) {
	r.tools = append(r.tools, t)
}

// AnthropicToolParams returns the Anthropic SDK ToolUnionParam slice
// for every Tier-A tool — these are what go in the per-turn prompt.
// Tier-B tools land in step 5 via the describe_tool meta-tool flow.
func (r *ToolRegistry) AnthropicToolParams() []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(r.tools))
	for _, t := range r.tools {
		if t.Tier != TierA {
			continue
		}
		schema := t.InputSchema
		if schema == nil {
			schema = map[string]interface{}{"type": "object"}
		}
		out = append(out, anthropic.ToolUnionParam{
			OfTool: &anthropic.ToolParam{
				Name:        t.Name,
				Description: anthropic.String(t.Description),
				InputSchema: anthropic.ToolInputSchemaParam{
					Properties: schema["properties"],
				},
			},
		})
	}
	return out
}

// Dispatch invokes a registered tool by name. Returns the tool's
// string output (for the model). If the tool isn't found, returns
// an error so the model sees an is_error tool result and can adjust.
func (r *ToolRegistry) Dispatch(ctx context.Context, env *DispatchEnv, name string, args json.RawMessage) (string, error) {
	for _, t := range r.tools {
		if t.Name == name {
			return t.Handler(ctx, env, args)
		}
	}
	return "", fmt.Errorf("unknown tool: %s", name)
}
