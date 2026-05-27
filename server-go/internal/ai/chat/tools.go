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

// DispatchEnv carries per-call context the handler needs: the
// session the call originated from, the caller's identity (so
// tools like get_current_user can resolve it without re-reading
// auth), the agent's result store (for the get_full_result
// meta-tool), and a hook the describe_tool meta-tool uses to
// signal that a Tier-B tool should be revealed (i.e. its schema
// added to subsequent turns).
//
// Caller may be nil for anonymous test invocations; handlers
// that need an identity must check.
type DispatchEnv struct {
	Session     *models.AISession
	Caller      *CallerCtx
	ResultStore *ResultStore

	// RevealTierB is set by the agent. The describe_tool handler
	// calls it with each tool name it's loading; the agent records
	// the name in its per-call revealedTierB map so subsequent
	// turns include that tool's schema. May be nil for handlers
	// that don't need it.
	RevealTierB func(name string)
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
// for the per-turn prompt: every Tier-A tool unconditionally, plus
// any Tier-B tools that the model has previously asked about via
// describe_tool (the agent tracks this set per-call in
// `revealedTierB`). Pass nil for revealedTierB on the first turn.
//
// The schemas land in the API request's Tools field; the textual
// catalog of "what Tier-B tools exist" goes through buildSystemPrompt
// instead.
func (r *ToolRegistry) AnthropicToolParams(revealedTierB map[string]bool) []anthropic.ToolUnionParam {
	out := make([]anthropic.ToolUnionParam, 0, len(r.tools))
	for _, t := range r.tools {
		if t.Tier == TierB && !revealedTierB[t.Name] {
			continue
		}
		out = append(out, anthropicToolParamFor(t))
	}
	return out
}

func anthropicToolParamFor(t Tool) anthropic.ToolUnionParam {
	schema := t.InputSchema
	if schema == nil {
		schema = map[string]interface{}{"type": "object"}
	}
	return anthropic.ToolUnionParam{
		OfTool: &anthropic.ToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: schema["properties"],
			},
		},
	}
}

// CatalogEntry is the lightweight (name, description) shape the
// Tier-B catalog uses in the system prompt — schema-free, so the
// per-turn cost stays bounded as the Tier-B set grows.
type CatalogEntry struct {
	Name        string
	Description string
}

// tierBCatalog returns the names + descriptions of every Tier-B tool,
// in registration order. Used by buildSystemPrompt to surface the
// catalog to the model.
func (r *ToolRegistry) tierBCatalog() []CatalogEntry {
	out := make([]CatalogEntry, 0)
	for _, t := range r.tools {
		if t.Tier != TierB {
			continue
		}
		out = append(out, CatalogEntry{Name: t.Name, Description: t.Description})
	}
	return out
}

// findTool returns the registered tool with the given name, or nil
// if it isn't registered. Used by the describe_tool meta-tool.
func (r *ToolRegistry) findTool(name string) *Tool {
	for i := range r.tools {
		if r.tools[i].Name == name {
			return &r.tools[i]
		}
	}
	return nil
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
