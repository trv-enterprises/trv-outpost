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

// TestGetRequiredCapability_NamespaceUsers covers the #4 reverse-lookup
// route: /api/namespaces/<id>/users returns USER records, so it needs
// Manage — unlike the other namespace reads, which stay open so every
// authenticated client can populate its namespace pickers.
func TestGetRequiredCapability_NamespaceUsers(t *testing.T) {
	m := &AuthMiddleware{rules: buildRouteRules()}

	tests := []struct {
		name   string
		path   string
		method string
		want   models.Capability
	}{
		{"namespace users lookup requires manage", "/api/namespaces/home/users", "GET", models.CapabilityManage},
		{"trailing slash too", "/api/namespaces/home/users/", "GET", models.CapabilityManage},
		{"plain namespace list stays open", "/api/namespaces", "GET", ""},
		{"single namespace read stays open", "/api/namespaces/home", "GET", ""},
		{"namespace usage read stays open", "/api/namespaces/home/usage", "GET", ""},
		{"namespace write still requires manage", "/api/namespaces/home", "PUT", models.CapabilityManage},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := m.getRequiredCapability(tt.path, tt.method); got != tt.want {
				t.Errorf("getRequiredCapability(%q, %q) = %q, want %q", tt.path, tt.method, got, tt.want)
			}
		})
	}
}

// TestGetRequiredCapability_Extensions locks the authz surface of the
// Design-mode extensions. Both gaps this covers were live on main:
//
//   - PUT /api/tsstore-alerts/rules/:id — added with the in-place edit
//     flow (v0.57.0) without a matching rule, so it fell through to the
//     view default and a read-only principal could edit a rule.
//   - POST /api/edgelake-terminal/execute — never had a rule, so a
//     read-only principal could run arbitrary AnyLog commands.
//
// getRequiredCapability matches on an EXACT method, so every write verb
// needs its own line. That is the failure mode being locked here: adding
// a route without adding its verb silently downgrades it to view.
func TestGetRequiredCapability_Extensions(t *testing.T) {
	m := &AuthMiddleware{rules: buildRouteRules()}

	tests := []struct {
		name   string
		path   string
		method string
		want   models.Capability
	}{
		// ts-store Alerts — every write verb is design-gated.
		{"alert create requires design", "/api/tsstore-alerts/rules", "POST", models.CapabilityDesign},
		{"alert edit requires design", "/api/tsstore-alerts/rules/abc-123", "PUT", models.CapabilityDesign},
		{"alert delete requires design", "/api/tsstore-alerts/rules/abc-123", "DELETE", models.CapabilityDesign},

		// EdgeLake Terminal — executing a command is a write.
		{"edgelake execute requires design", "/api/edgelake-terminal/execute", "POST", models.CapabilityDesign},

		// Reads are design-gated too: the extension is reached from
		// the Design menu, and the rule list names every ts-store
		// connection and the conditions being watched.
		{"alert list requires design", "/api/tsstore-alerts/rules", "GET", models.CapabilityDesign},
		{"alert detail requires design", "/api/tsstore-alerts/rules/abc-123", "GET", models.CapabilityDesign},
		{"alert probe requires design", "/api/tsstore-alerts/probe", "GET", models.CapabilityDesign},

		// Fired alerts must NOT be swept up by the prefix rule — they
		// reach the bell through the webhook receiver, which stays on
		// its own secret-gated public path. A view-only kiosk still
		// receives alerts; it just cannot browse the rules that made
		// them.
		{"secret-gated webhook receiver stays public", "/api/webhooks/tsstore/conn-1/s3cr3t", "POST", ""},
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
