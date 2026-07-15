// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package authz

import (
	"context"
	"errors"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

func TestGrantsCan(t *testing.T) {
	cases := []struct {
		name string
		g    Grants
		ns   string
		want bool
	}{
		{"unrestricted sees anything", Grants{}, "prod", true},
		{"unrestricted sees empty ns", Grants{}, "", true},
		{"restricted granted", Grants{Restricted: true, Allowed: map[string]struct{}{"prod": {}}}, "prod", true},
		{"restricted ungranted", Grants{Restricted: true, Allowed: map[string]struct{}{"prod": {}}}, "dev", false},
		{"restricted empty-ns fails closed", Grants{Restricted: true, Allowed: map[string]struct{}{"prod": {}}}, "", false},
		{"restricted to nothing", Grants{Restricted: true, Allowed: map[string]struct{}{}}, "prod", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.g.Can(tc.ns); got != tc.want {
				t.Errorf("Can(%q) = %v, want %v", tc.ns, got, tc.want)
			}
		})
	}
}

func TestGrantsFromUser(t *testing.T) {
	if g := GrantsFromUser(nil); g.Restricted {
		t.Error("nil user must be unrestricted")
	}
	if g := GrantsFromUser(&models.User{}); g.Restricted {
		t.Error("default user must be unrestricted (back-compat)")
	}
	g := GrantsFromUser(&models.User{
		NamespacesRestricted: true,
		AllowedNamespaces:    []string{"a", "b"},
	})
	if !g.Restricted || !g.Can("a") || !g.Can("b") || g.Can("c") {
		t.Errorf("restricted grants wrong: %+v", g)
	}
}

func TestContextRoundtripAndFailOpen(t *testing.T) {
	// INVARIANT: an unstamped ctx is an internal caller — allowed.
	bare := context.Background()
	if !Allowed(bare, "anything") {
		t.Fatal("unstamped ctx must be allowed (internal-caller invariant)")
	}
	if err := CheckNamespace(bare, "anything"); err != nil {
		t.Fatalf("unstamped ctx CheckNamespace: %v", err)
	}
	if list, restricted := AllowedList(bare); restricted || list != nil {
		t.Fatal("unstamped ctx must report unrestricted")
	}

	// Stamped restricted ctx enforces.
	user := &models.User{GUID: "g1", NamespacesRestricted: true, AllowedNamespaces: []string{"home"}}
	ctx := WithGrants(bare, user, GrantsFromUser(user))

	caller, g, ok := FromContext(ctx)
	if !ok || caller == nil || caller.GUID != "g1" || !g.Restricted {
		t.Fatalf("FromContext lost data: ok=%v caller=%v grants=%+v", ok, caller, g)
	}
	if !Allowed(ctx, "home") || Allowed(ctx, "prod") {
		t.Fatal("stamped grants not enforced")
	}
	if err := CheckNamespace(ctx, "prod"); !errors.Is(err, ErrNamespaceForbidden) {
		t.Fatalf("want ErrNamespaceForbidden, got %v", err)
	}
	list, restricted := AllowedList(ctx)
	if !restricted || len(list) != 1 || list[0] != "home" {
		t.Fatalf("AllowedList = %v/%v", list, restricted)
	}
}
