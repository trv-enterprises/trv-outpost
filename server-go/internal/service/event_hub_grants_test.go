// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// subCtx builds a subscriber context carrying a restricted grant set,
// mirroring what the auth middleware stamps on an SSE request.
func subCtx(allowed ...string) context.Context {
	set := make(map[string]struct{}, len(allowed))
	for _, ns := range allowed {
		set[ns] = struct{}{}
	}
	return authz.WithGrants(context.Background(), &models.User{GUID: "u"},
		authz.Grants{Restricted: true, Allowed: set})
}

// drain reports whether an event landed in the subscriber's channel.
// Non-blocking: Publish is synchronous, so anything delivered is
// already buffered by the time we look.
func drain(sub *Subscription) bool {
	select {
	case <-sub.Events:
		return true
	default:
		return false
	}
}

// TestEventHubFiltersByGrant covers the #4 push-path gate. Filtering
// the bell's REST list alone is NOT enough: a live-fired alert would
// still push straight to every open tab, so Publish has to filter too.
func TestEventHubFiltersByGrant(t *testing.T) {
	t.Run("restricted subscriber only gets granted namespaces", func(t *testing.T) {
		h := NewEventHub()
		sub := h.Subscribe(subCtx("home"), "u1")
		defer sub.Close()

		h.Publish(Event{Kind: "alert", Namespace: "home"})
		if !drain(sub) {
			t.Error("granted-namespace event was not delivered")
		}

		h.Publish(Event{Kind: "alert", Namespace: "prod"})
		if drain(sub) {
			t.Error("LEAK: ungranted-namespace event was delivered")
		}
	})

	t.Run("namespace-less events are system-wide", func(t *testing.T) {
		h := NewEventHub()
		sub := h.Subscribe(subCtx("home"), "u1")
		defer sub.Close()

		// No namespace = not connection-scoped = everyone sees it.
		h.Publish(Event{Kind: "system"})
		if !drain(sub) {
			t.Error("system-wide event was filtered out")
		}
	})

	t.Run("unrestricted subscriber gets everything", func(t *testing.T) {
		h := NewEventHub()
		unrestricted := authz.WithGrants(context.Background(), &models.User{GUID: "a"}, authz.Grants{})
		sub := h.Subscribe(unrestricted, "admin")
		defer sub.Close()

		h.Publish(Event{Kind: "alert", Namespace: "prod"})
		if !drain(sub) {
			t.Error("unrestricted subscriber missed an event")
		}
	})

	t.Run("unstamped ctx is an internal subscriber and gets everything", func(t *testing.T) {
		h := NewEventHub()
		sub := h.Subscribe(context.Background(), "internal")
		defer sub.Close()

		h.Publish(Event{Kind: "alert", Namespace: "prod"})
		if !drain(sub) {
			t.Error("internal subscriber was filtered (fail-open invariant broken)")
		}
	})

	t.Run("one subscriber's grant does not affect another's", func(t *testing.T) {
		h := NewEventHub()
		home := h.Subscribe(subCtx("home"), "u1")
		defer home.Close()
		prod := h.Subscribe(subCtx("prod"), "u2")
		defer prod.Close()

		h.Publish(Event{Kind: "alert", Namespace: "prod"})
		if drain(home) {
			t.Error("LEAK: home-only subscriber received a prod event")
		}
		if !drain(prod) {
			t.Error("prod subscriber missed its own event")
		}
	})
}
