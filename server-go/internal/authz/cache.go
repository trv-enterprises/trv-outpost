// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package authz

import (
	"container/list"
	"context"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Resolver turns an authenticated identity into Grants, caching the
// user-record lookup the JWT path needs. Answering "do we cache a
// certain number of active users?" — yes: TTL+LRU, defaultCacheTTL
// per entry, defaultCacheCap entries. Cost bound: ≤1 Mongo read per
// active user per TTL. Grant edits made through UserService invalidate
// the entry immediately (single-process server), so propagation is
// instant for same-process edits and ≤TTL otherwise.
//
// Grants deliberately do NOT ride the JWT: claims are frozen for the
// access-token TTL (default 15 min), and grant lists can be long.

const (
	defaultCacheTTL = 30 * time.Second
	defaultCacheCap = 500
)

// UserGetter is the slice of UserService the resolver needs.
type UserGetter interface {
	GetUserByGUID(ctx context.Context, guid string) (*models.User, error)
}

type cacheEntry struct {
	guid    string
	grants  Grants
	expires time.Time
}

// Resolver resolves and caches per-user grants.
type Resolver struct {
	users UserGetter

	mu      sync.Mutex
	entries map[string]*list.Element // guid -> lru element holding *cacheEntry
	lru     *list.List               // front = most recent
	ttl     time.Duration
	cap     int
	now     func() time.Time
}

// NewResolver builds a Resolver over the given user source.
func NewResolver(users UserGetter) *Resolver {
	return &Resolver{
		users:   users,
		entries: make(map[string]*list.Element),
		lru:     list.New(),
		ttl:     defaultCacheTTL,
		cap:     defaultCacheCap,
		now:     time.Now,
	}
}

// Resolve returns the grants for the authenticated user.
//
//   - Callers that already hold a FULL user record (API-key path loads
//     it per request) derive grants directly — no cache, no DB.
//   - JWT-shim callers (record has only claims-derived fields) go
//     through the cache; a miss loads the user by GUID.
//
// The full-vs-shim distinction: the JWT shim is built by
// middleware.claimsToUser with zero Created time; a loaded record
// always has Created set. hasFullRecord isolates that heuristic.
func (r *Resolver) Resolve(ctx context.Context, user *models.User) (Grants, error) {
	if user == nil {
		return Grants{}, nil
	}
	if hasFullRecord(user) {
		return GrantsFromUser(user), nil
	}

	if g, ok := r.get(user.GUID); ok {
		return g, nil
	}

	full, err := r.users.GetUserByGUID(ctx, user.GUID)
	if err != nil {
		return Grants{}, err
	}
	g := GrantsFromUser(full)
	r.put(user.GUID, g)
	return g, nil
}

// hasFullRecord reports whether the user came from the database (vs
// the claims-derived shim, which never has timestamps).
func hasFullRecord(u *models.User) bool {
	return !u.Created.IsZero()
}

// Invalidate drops the cached grants for one user. UserService calls
// this on every user update/delete so grant edits apply immediately.
func (r *Resolver) Invalidate(guid string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if el, ok := r.entries[guid]; ok {
		r.lru.Remove(el)
		delete(r.entries, guid)
	}
}

// Flush drops every cached entry. Namespace rename/delete cascades
// call this — a slug change invalidates any cached Allowed set.
func (r *Resolver) Flush() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.entries = make(map[string]*list.Element)
	r.lru.Init()
}

func (r *Resolver) get(guid string) (Grants, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	el, ok := r.entries[guid]
	if !ok {
		return Grants{}, false
	}
	entry := el.Value.(*cacheEntry)
	if r.now().After(entry.expires) {
		r.lru.Remove(el)
		delete(r.entries, guid)
		return Grants{}, false
	}
	r.lru.MoveToFront(el)
	return entry.grants, true
}

func (r *Resolver) put(guid string, g Grants) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if el, ok := r.entries[guid]; ok {
		el.Value.(*cacheEntry).grants = g
		el.Value.(*cacheEntry).expires = r.now().Add(r.ttl)
		r.lru.MoveToFront(el)
		return
	}
	for len(r.entries) >= r.cap {
		oldest := r.lru.Back()
		if oldest == nil {
			break
		}
		r.lru.Remove(oldest)
		delete(r.entries, oldest.Value.(*cacheEntry).guid)
	}
	el := r.lru.PushFront(&cacheEntry{guid: guid, grants: g, expires: r.now().Add(r.ttl)})
	r.entries[guid] = el
}
