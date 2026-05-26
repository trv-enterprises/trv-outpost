// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// RegisterBuiltinTools wires the minimum Tier-A tool set the smoke
// test needs. Step 3 expands this dramatically once the shared
// toolops layer lands.
//
// Today: one tool — `get_current_user`.
func RegisterBuiltinTools(reg *ToolRegistry, users *repository.UserRepository) {
	reg.Register(Tool{
		Name:        "get_current_user",
		Description: "Returns the calling user's profile (name, GUID, and capabilities). Use this to greet the user by name and to know what they're allowed to do.",
		Tier:        TierA,
		InputSchema: map[string]interface{}{
			"type":       "object",
			"properties": map[string]interface{}{},
		},
		Handler: getCurrentUserHandler(users),
	})
}

func getCurrentUserHandler(users *repository.UserRepository) ToolHandler {
	return func(ctx context.Context, env *DispatchEnv, args json.RawMessage) (string, error) {
		// Step 2 limitation: AISession doesn't yet carry the caller
		// identity, so we can't resolve a real user here. We return
		// a deliberately conspicuous placeholder so the smoke test
		// still demonstrates end-to-end tool dispatch.
		//
		// Step 3 wires the caller into DispatchEnv from the SSE
		// request context and this becomes a real lookup.
		_ = users // silence unused while the caller path is stubbed
		out := map[string]interface{}{
			"name":         "(caller identity not yet wired — step 3)",
			"guid":         "",
			"capabilities": []string{},
			"note":         "Step 2 smoke test — caller resolution lands in step 3.",
		}
		b, err := json.Marshal(out)
		if err != nil {
			return "", fmt.Errorf("marshal: %w", err)
		}
		return string(b), nil
	}
}
