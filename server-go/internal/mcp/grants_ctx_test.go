// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
)

// TestNoBackgroundContextInToolHandlers is the #4 regression guard for
// the MCP surface.
//
// Every MCP tool must run service calls on the CALLER's context — that's
// what carries their namespace grants. A context.Background() inside a
// tool handler silently reverts to the authz package's "unstamped ctx =
// internal caller = allowed everything" invariant, which would hand an
// MCP caller unrestricted access to every namespace with no visible
// symptom. This is exactly how the surface behaved before #4, so the
// mistake is an easy one to reintroduce.
//
// The one legitimate exception lives in handler.go (the initialize
// instructions' TYPE catalog — no namespaced entities), so this test
// scopes itself to tools.go/guidance.go where the entity tools live.
func TestNoBackgroundContextInToolHandlers(t *testing.T) {
	bgRE := regexp.MustCompile(`context\.Background\(\)`)

	for _, file := range []string{"tools.go", "guidance.go"} {
		src, err := os.ReadFile(file)
		if err != nil {
			t.Fatalf("read %s: %v", file, err)
		}
		for i, line := range strings.Split(string(src), "\n") {
			// Skip comments — they discuss the rule.
			if strings.HasPrefix(strings.TrimSpace(line), "//") {
				continue
			}
			if bgRE.MatchString(line) {
				t.Errorf("%s:%d uses context.Background() — MCP tools must thread the caller's context so namespace grants (#4) are enforced:\n\t%s",
					file, i+1, strings.TrimSpace(line))
			}
		}
	}
}

// TestCallToolThreadsContext asserts the registry actually hands the
// caller's context to the tool handler (rather than dropping it).
func TestCallToolThreadsContext(t *testing.T) {
	r := &ToolRegistry{handlers: map[string]ToolHandler{}}

	type ctxKey string
	const probe ctxKey = "probe"

	var got interface{}
	r.handlers["probe-tool"] = func(ctx context.Context, _ map[string]interface{}) (interface{}, error) {
		got = ctx.Value(probe)
		return nil, nil
	}

	ctx := context.WithValue(context.Background(), probe, "carried")
	if _, err := r.CallTool(ctx, "probe-tool", nil); err != nil {
		t.Fatal(err)
	}
	if got != "carried" {
		t.Fatalf("CallTool dropped the caller context (grants would be lost): got %v", got)
	}
}
