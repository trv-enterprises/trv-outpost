// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TestGetRequiredCapability_ComponentData covers the execute-by-reference
// data endpoint (#23): POST /api/components/:id/data is a read despite the
// verb, so it must resolve to no specific capability (→ view in Authorize)
// while ordinary component writes still require design.
func TestGetRequiredCapability_ComponentData(t *testing.T) {
	m := &AuthMiddleware{rules: buildRouteRules()}

	tests := []struct {
		name   string
		path   string
		method string
		want   models.Capability
	}{
		{"component data POST is view-level", "/api/components/abc-123/data", "POST", ""},
		{"component data with trailing slash", "/api/components/abc-123/data/", "POST", ""},
		{"component create still requires design", "/api/components", "POST", models.CapabilityDesign},
		{"component update still requires design", "/api/components/abc-123", "PUT", models.CapabilityDesign},
		{"component delete still requires design", "/api/components/abc-123", "DELETE", models.CapabilityDesign},
		// A nested write under /:id must not be swallowed by the data rule.
		{"version delete still requires design", "/api/components/abc-123/versions/2", "DELETE", models.CapabilityDesign},
		// The data rule must not leak onto other POST shapes.
		{"draft-like POST path is not exempted", "/api/components/abc-123/data/extra", "POST", models.CapabilityDesign},
		// Pre-existing suffix special-cases stay intact. The raw /query
		// endpoint is still route-open; the design/manage gate for it is
		// enforced in the service layer (#23), not here.
		{"raw query endpoint stays route-open", "/api/connections/abc-123/query", "POST", ""},
		{"stream endpoint stays open", "/api/connections/abc-123/stream", "GET", ""},
		// MCP bridge is design-gated at the route (#23).
		{"mcp message requires design", "/mcp/message", "POST", models.CapabilityDesign},
		{"mcp sse requires design", "/mcp/sse", "GET", models.CapabilityDesign},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := m.getRequiredCapability(tt.path, tt.method)
			if got != tt.want {
				t.Errorf("getRequiredCapability(%q, %q) = %q, want %q", tt.path, tt.method, got, tt.want)
			}
		})
	}
}
