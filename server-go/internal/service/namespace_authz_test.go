// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// grantsCtx stamps a restricted grant set onto a context for tests,
// mirroring what the auth middleware does per request.
func grantsCtx(allowed ...string) context.Context {
	set := make(map[string]struct{}, len(allowed))
	for _, ns := range allowed {
		set[ns] = struct{}{}
	}
	g := authz.Grants{Restricted: true, Allowed: set}
	return authz.WithGrants(context.Background(), &models.User{GUID: "t"}, g)
}

// TestNamespaceGrantsForList is the shared list-path decision used by
// every entity's list method (issue #4). It decides the grant fields
// to stamp on repo query params and whether an explicit namespace
// filter outside the grants should collapse to an empty page.
func TestNamespaceGrantsForList(t *testing.T) {
	tests := []struct {
		name          string
		ctx           context.Context
		explicitNS    string
		wantRestrict  bool
		wantAllowed   []string
		wantCanFilter bool
	}{
		{
			name:          "unrestricted caller, no explicit filter",
			ctx:           context.Background(),
			explicitNS:    "",
			wantRestrict:  false,
			wantCanFilter: true,
		},
		{
			name:          "unrestricted caller with explicit filter is fine",
			ctx:           context.Background(),
			explicitNS:    "prod",
			wantRestrict:  false,
			wantCanFilter: true,
		},
		{
			name:          "restricted caller, no explicit filter",
			ctx:           grantsCtx("home", "lab"),
			explicitNS:    "",
			wantRestrict:  true,
			wantAllowed:   []string{"home", "lab"},
			wantCanFilter: true,
		},
		{
			name:          "restricted caller, explicit filter inside grants",
			ctx:           grantsCtx("home", "lab"),
			explicitNS:    "home",
			wantRestrict:  true,
			wantCanFilter: true,
		},
		{
			name:          "restricted caller, explicit filter OUTSIDE grants → empty page",
			ctx:           grantsCtx("home"),
			explicitNS:    "prod",
			wantRestrict:  true,
			wantCanFilter: false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			allowed, restricted, canFilter := namespaceGrantsForList(tt.ctx, tt.explicitNS)
			if restricted != tt.wantRestrict {
				t.Errorf("restricted = %v, want %v", restricted, tt.wantRestrict)
			}
			if canFilter != tt.wantCanFilter {
				t.Errorf("filterAllowed = %v, want %v", canFilter, tt.wantCanFilter)
			}
			if tt.wantAllowed != nil {
				got := map[string]bool{}
				for _, ns := range allowed {
					got[ns] = true
				}
				for _, ns := range tt.wantAllowed {
					if !got[ns] {
						t.Errorf("allowed missing %q (got %v)", ns, allowed)
					}
				}
			}
		})
	}
}

// TestFilterConnectionsByGrant covers the in-service post-filter used
// by the legacy list-by-type path (the one the tsstore-alerts
// aggregator fans out over). Empty-namespace records fail closed.
func TestFilterConnectionsByGrant(t *testing.T) {
	conns := []*models.Connection{
		{ID: "1", Namespace: "home"},
		{ID: "2", Namespace: "prod"},
		{ID: "3", Namespace: "lab"},
		{ID: "4", Namespace: ""}, // stray pre-namespace record
	}
	got := filterConnectionsByGrant(conns, []string{"home", "lab"})
	if len(got) != 2 {
		t.Fatalf("expected 2 visible, got %d: %+v", len(got), got)
	}
	seen := map[string]bool{}
	for _, c := range got {
		seen[c.ID] = true
	}
	if !seen["1"] || !seen["3"] || seen["2"] || seen["4"] {
		t.Errorf("wrong visibility: %v", seen)
	}
}

// TestNamespaceGrantErrorsAreForbidden guards the sentinel identity so
// the handler layer's errors.Is check keeps mapping to 403.
func TestNamespaceGrantErrorsAreForbidden(t *testing.T) {
	err := authz.CheckNamespace(grantsCtx("home"), "prod")
	if !errors.Is(err, authz.ErrNamespaceForbidden) {
		t.Fatalf("expected ErrNamespaceForbidden, got %v", err)
	}
	if authz.CheckNamespace(grantsCtx("home"), "home") != nil {
		t.Error("granted namespace must not error")
	}
}
