// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/ai/toolops"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// RegisterBuiltinTools wires the chat agent's Tier-A toolset. Every
// tool here goes through the shared `toolops` layer so MCP and the
// chat agent stay in lock-step on what each operation actually does.
//
// Tier-A is the always-loaded set — schemas inline on every turn.
// Step 5 will add the Tier-B / describe_tool pattern for less-used
// operations.
func RegisterBuiltinTools(reg *ToolRegistry, ops *toolops.Toolset) {
	// ─── Identity / context ───
	reg.Register(Tool{
		Name:        "get_current_user",
		Description: "Returns the calling user's profile (name, GUID, and capabilities). Use this to greet the user by name and to know what they're allowed to do.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapGetCurrentUser(ops),
	})

	reg.Register(Tool{
		Name:        "list_namespaces",
		Description: "List every namespace in the deployment. Namespaces are the conflict-domain grouping on connections / components / dashboards — uniqueness of name is per-namespace.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListNamespaces(ops),
	})

	// ─── Connections ───
	reg.Register(Tool{
		Name:        "list_connections",
		Description: "List all configured connections (SQL, API, MQTT, EdgeLake, etc). Returns name, type, and ID for each.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListConnections(ops),
	})

	reg.Register(Tool{
		Name:        "get_connection",
		Description: "Get the full configuration for a single connection by ID.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"id": map[string]interface{}{
					"type":        "string",
					"description": "Connection ID",
				},
			},
			"required": []string{"id"},
		},
		Handler: wrapGetConnection(ops),
	})

	reg.Register(Tool{
		Name:        "query_connection",
		Description: "Execute an ad-hoc query against a connection. Pass `connection_id`, `raw` (the query string), `type` (sql / api / csv_filter / stream_filter), and optional `params`. Pass `limit` to cap rows returned — useful when you only need to verify the result shape before building a chart. `limit: 1` is the common shape-probe pattern.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"connection_id": map[string]interface{}{"type": "string", "description": "Connection ID to query"},
				"raw":           map[string]interface{}{"type": "string", "description": "The query string (SQL, API path, filter expression, etc)"},
				"type":          map[string]interface{}{"type": "string", "description": "Query type — sql, api, csv_filter, stream_filter"},
				"params":        map[string]interface{}{"type": "object", "description": "Optional query parameters"},
				"limit":         map[string]interface{}{"type": "integer", "description": "Cap rows returned. Use small (1-5) for shape probes; omit for full results."},
			},
			"required": []string{"connection_id", "raw"},
		},
		Handler: wrapQueryConnection(ops),
	})

	// ─── Components ───
	reg.Register(Tool{
		Name:        "list_components",
		Description: "List components (charts/controls/displays). Optionally filter by chart_type, connection_id, or tag.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"chart_type":    map[string]interface{}{"type": "string", "description": "Filter by chart subtype (bar, line, etc)"},
				"connection_id": map[string]interface{}{"type": "string", "description": "Filter by connection ID"},
				"tag":           map[string]interface{}{"type": "string", "description": "Filter by tag"},
			},
		},
		Handler: wrapListComponents(ops),
	})

	// ─── Dashboards ───
	reg.Register(Tool{
		Name:        "list_dashboards",
		Description: "List all dashboards in the deployment.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapListDashboards(ops),
	})

	// ─── Type catalog ───
	reg.Register(Tool{
		Name:        "get_type_catalog",
		Description: "Returns the unified catalog of every type the dashboard knows about: connection types, chart subtypes, control subtypes, display subtypes, device types. Call this when planning to build something so you know what's available.",
		Tier:        TierA,
		InputSchema: emptyObjectSchema(),
		Handler:     wrapGetCatalog(ops),
	})

	// ─── Meta: result store ───
	// get_full_result fetches the verbatim content of a tool result
	// that was stored server-side because it was too large to inline
	// (the result-store layer; see internal/ai/chat/result_store.go).
	// Most of the time the inline summary already answers the
	// question — only call this when you genuinely need the full
	// payload, because retrieving it can consume significant
	// context.
	reg.Register(Tool{
		Name:        "get_full_result",
		Description: "Retrieve the verbatim content of a previously-stored large tool result by its result_id. Only call this when the inline summary doesn't have what you need — fetching the full payload can consume significant context. result_id looks like `r_abc12345` and is returned in the summary of any large tool call.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"result_id": map[string]interface{}{
					"type":        "string",
					"description": "The result ID returned in the summary of a large tool call (e.g. r_abc12345).",
				},
			},
			"required": []string{"result_id"},
		},
		Handler: wrapGetFullResult(),
	})
}

// emptyObjectSchema is the JSON-schema for tools that take no input.
func emptyObjectSchema() map[string]interface{} {
	return map[string]interface{}{
		"type":       "object",
		"properties": map[string]interface{}{},
	}
}

// ─── Handler wrappers ─────────────────────────────────────────────
// Each wrapper unmarshals model-supplied args into the toolops Input
// type, invokes the operation, and marshals the result back to JSON
// for the model. Capability gating and namespace injection happen
// here once they're wired through DispatchEnv (step 3.5+).

func wrapGetCurrentUser(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		// Caller resolution from request context will land alongside
		// the SSE auth wiring (step 11). For now we pass through
		// whatever the session has — chat sessions don't yet carry
		// the caller, so this returns the placeholder until then.
		out, err := ops.GetCurrentUser(ctx, toolops.GetCurrentUserInput{
			CallerGUID: callerGUIDFromEnv(env),
		})
		if err != nil {
			return jsonResult(map[string]interface{}{
				"note": "Caller identity not yet wired into chat sessions — landing in step 11 alongside SSE auth.",
				"err":  err.Error(),
			})
		}
		return jsonResult(out)
	}
}

func wrapListNamespaces(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.ListNamespaces(ctx)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListConnections(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.ListConnections(ctx)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetConnection(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.GetConnectionInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.GetConnection(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapQueryConnection(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.QueryConnectionInput
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		out, err := ops.QueryConnection(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListComponents(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in toolops.ListComponentsInput
		if len(args) > 0 {
			// Decode the model-facing shape (snake_case) into the
			// strongly-typed input. JSON tags would be cleaner but the
			// surface is small enough to do manually.
			var raw struct {
				ChartType    string `json:"chart_type"`
				ConnectionID string `json:"connection_id"`
				Tag          string `json:"tag"`
			}
			if err := json.Unmarshal(args, &raw); err != nil {
				return "", fmt.Errorf("invalid args: %w", err)
			}
			in.ChartType = raw.ChartType
			in.ConnectionID = raw.ConnectionID
			in.Tag = raw.Tag
		}
		out, err := ops.ListComponents(ctx, in)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapListDashboards(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.ListDashboards(ctx)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

func wrapGetFullResult() ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		var in struct {
			ResultID string `json:"result_id"`
		}
		if err := json.Unmarshal(args, &in); err != nil {
			return "", fmt.Errorf("invalid args: %w", err)
		}
		if env == nil || env.ResultStore == nil {
			return "", fmt.Errorf("result store not wired — get_full_result cannot run")
		}
		full, err := env.ResultStore.FetchFull(ctx, in.ResultID)
		if err != nil {
			return "", err
		}
		return full, nil
	}
}

func wrapGetCatalog(ops *toolops.Toolset) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		out, err := ops.GetCatalog(ctx)
		if err != nil {
			return "", err
		}
		return jsonResult(out)
	}
}

// callerGUIDFromEnv pulls the auth GUID off the DispatchEnv. Today's
// DispatchEnv only carries the session; step 11 wires the caller
// identity through from SSE auth, at which point this becomes a real
// lookup. Until then it returns "" and the get_current_user tool
// returns its placeholder.
func callerGUIDFromEnv(env *DispatchEnv) string {
	if env == nil || env.Session == nil {
		return ""
	}
	// Future: env.Caller.GUID once that field lands. For now the
	// session record doesn't carry the caller; we just return empty
	// and let the toolops function surface a helpful note.
	_ = models.AISessionKindChat
	return ""
}

// jsonResult marshals any value to a JSON string for handing back to
// the model.
func jsonResult(v interface{}) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", fmt.Errorf("marshal result: %w", err)
	}
	return string(b), nil
}
