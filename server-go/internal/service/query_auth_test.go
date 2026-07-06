// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

func userWith(caps ...models.Capability) *models.User {
	return &models.User{Capabilities: caps}
}

// TestRawQueryAuthorized covers the #23 default-deny gate for raw queries
// against guarded (SQL/EdgeLake) connections.
func TestRawQueryAuthorized(t *testing.T) {
	tests := []struct {
		name string
		az   queryAuth
		want bool
	}{
		{"no auth stamped → denied (fail closed)", queryAuth{}, false},
		{"trusted internal call → allowed", queryAuth{trusted: true}, true},
		{"view-only caller → denied", queryAuth{caller: userWith(models.CapabilityView)}, false},
		{"view+control caller → denied", queryAuth{caller: userWith(models.CapabilityView, models.CapabilityControl)}, false},
		{"design caller → allowed", queryAuth{caller: userWith(models.CapabilityView, models.CapabilityDesign)}, true},
		{"manage caller → allowed", queryAuth{caller: userWith(models.CapabilityManage)}, true},
		{"nil caller, not trusted → denied", queryAuth{caller: nil}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := rawQueryAuthorized(tt.az); got != tt.want {
				t.Errorf("rawQueryAuthorized(%+v) = %v, want %v", tt.az, got, tt.want)
			}
		})
	}
}

// The context helpers must round-trip the auth decision so the entry points
// (raw /query handler → caller, by-reference/AI/MCP → trusted) are honored.
func TestQueryAuthContextRoundTrip(t *testing.T) {
	if az := queryAuthFrom(context.Background()); az.trusted || az.caller != nil {
		t.Error("bare context must carry no auth (default-deny)")
	}

	trusted := queryAuthFrom(WithTrustedQuery(context.Background()))
	if !trusted.trusted {
		t.Error("WithTrustedQuery must stamp trusted")
	}
	if !rawQueryAuthorized(trusted) {
		t.Error("trusted context must authorize")
	}

	u := userWith(models.CapabilityDesign)
	withCaller := queryAuthFrom(WithQueryCaller(context.Background(), u))
	if withCaller.caller != u || withCaller.trusted {
		t.Error("WithQueryCaller must stamp the caller and not trusted")
	}

	viewCaller := queryAuthFrom(WithQueryCaller(context.Background(), userWith(models.CapabilityView)))
	if rawQueryAuthorized(viewCaller) {
		t.Error("a view caller must be denied")
	}
}
