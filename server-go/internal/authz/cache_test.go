// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package authz

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// fakeUsers counts lookups so tests can assert cache behavior.
type fakeUsers struct {
	users map[string]*models.User
	calls int
}

func (f *fakeUsers) GetUserByGUID(ctx context.Context, guid string) (*models.User, error) {
	f.calls++
	u, ok := f.users[guid]
	if !ok {
		return nil, fmt.Errorf("user not found")
	}
	return u, nil
}

// shim mimics middleware.claimsToUser output: no Created timestamp.
func shim(guid string) *models.User {
	return &models.User{GUID: guid, Active: true}
}

func fullUser(guid string, restricted bool, allowed ...string) *models.User {
	return &models.User{
		GUID:                 guid,
		Active:               true,
		NamespacesRestricted: restricted,
		AllowedNamespaces:    allowed,
		Created:              time.Now(),
	}
}

func TestResolverFullRecordSkipsCache(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{}}
	r := NewResolver(src)

	g, err := r.Resolve(context.Background(), fullUser("g1", true, "home"))
	if err != nil {
		t.Fatal(err)
	}
	if !g.Restricted || !g.Can("home") {
		t.Fatalf("grants wrong: %+v", g)
	}
	if src.calls != 0 {
		t.Fatalf("full record must not hit the user source; calls=%d", src.calls)
	}
}

func TestResolverCachesShimLookups(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{
		"g1": fullUser("g1", true, "home"),
	}}
	r := NewResolver(src)

	for i := 0; i < 5; i++ {
		g, err := r.Resolve(context.Background(), shim("g1"))
		if err != nil {
			t.Fatal(err)
		}
		if !g.Can("home") || g.Can("prod") {
			t.Fatalf("grants wrong on iteration %d: %+v", i, g)
		}
	}
	if src.calls != 1 {
		t.Fatalf("expected 1 lookup for 5 resolves, got %d", src.calls)
	}
}

func TestResolverTTLExpiry(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{
		"g1": fullUser("g1", false),
	}}
	r := NewResolver(src)
	now := time.Now()
	r.now = func() time.Time { return now }

	if _, err := r.Resolve(context.Background(), shim("g1")); err != nil {
		t.Fatal(err)
	}
	// Within TTL: cached.
	now = now.Add(r.ttl - time.Second)
	if _, err := r.Resolve(context.Background(), shim("g1")); err != nil {
		t.Fatal(err)
	}
	if src.calls != 1 {
		t.Fatalf("expected cached lookup within TTL, calls=%d", src.calls)
	}
	// Past TTL: reload.
	now = now.Add(2 * time.Second)
	if _, err := r.Resolve(context.Background(), shim("g1")); err != nil {
		t.Fatal(err)
	}
	if src.calls != 2 {
		t.Fatalf("expected reload past TTL, calls=%d", src.calls)
	}
}

func TestResolverInvalidate(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{
		"g1": fullUser("g1", true, "home"),
	}}
	r := NewResolver(src)

	if _, err := r.Resolve(context.Background(), shim("g1")); err != nil {
		t.Fatal(err)
	}

	// Grant change lands + invalidation → next resolve sees it immediately.
	src.users["g1"] = fullUser("g1", true, "home", "prod")
	r.Invalidate("g1")

	g, err := r.Resolve(context.Background(), shim("g1"))
	if err != nil {
		t.Fatal(err)
	}
	if !g.Can("prod") {
		t.Fatal("invalidation did not take effect")
	}
	if src.calls != 2 {
		t.Fatalf("calls=%d", src.calls)
	}
}

func TestResolverLRUEviction(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{}}
	r := NewResolver(src)
	r.cap = 3
	for i := 0; i < 5; i++ {
		guid := fmt.Sprintf("g%d", i)
		src.users[guid] = fullUser(guid, false)
		if _, err := r.Resolve(context.Background(), shim(guid)); err != nil {
			t.Fatal(err)
		}
	}
	if len(r.entries) > 3 {
		t.Fatalf("cache exceeded cap: %d", len(r.entries))
	}
	// g0/g1 evicted; resolving again re-fetches.
	before := src.calls
	if _, err := r.Resolve(context.Background(), shim("g0")); err != nil {
		t.Fatal(err)
	}
	if src.calls != before+1 {
		t.Fatal("evicted entry should re-fetch")
	}
}

func TestResolverFlush(t *testing.T) {
	src := &fakeUsers{users: map[string]*models.User{
		"g1": fullUser("g1", true, "old-name"),
	}}
	r := NewResolver(src)
	if _, err := r.Resolve(context.Background(), shim("g1")); err != nil {
		t.Fatal(err)
	}
	src.users["g1"] = fullUser("g1", true, "new-name")
	r.Flush()
	g, err := r.Resolve(context.Background(), shim("g1"))
	if err != nil {
		t.Fatal(err)
	}
	if !g.Can("new-name") || g.Can("old-name") {
		t.Fatal("flush did not drop stale grants")
	}
}

func TestResolverNilUser(t *testing.T) {
	r := NewResolver(&fakeUsers{})
	g, err := r.Resolve(context.Background(), nil)
	if err != nil || g.Restricted {
		t.Fatalf("nil user must resolve unrestricted: %+v %v", g, err)
	}
}
