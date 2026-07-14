// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package authz carries per-request namespace grants (issue #4).
//
// The model has two orthogonal planes:
//
//   - ADMIN plane (user CRUD, namespace CRUD, grant assignment,
//     settings): gated by the manage capability, namespace-blind.
//     Nothing in this package applies there.
//   - DATA plane (viewing/designing/querying connections, components,
//     dashboards, and all live data through them): governed by the
//     caller's namespace grants — for everyone, managers included.
//
// Grants are resolved once per request by the auth middleware (via
// Resolver) and stamped onto the request context. Services consult
// them with CheckNamespace / AllowedList.
//
// INVARIANT — fail-open for unstamped contexts: a context with no
// grants stamped is an INTERNAL caller (startup jobs, streaming
// manager internals, migrations) and is allowed everything, mirroring
// the WithTrustedQuery philosophy. The middleware guarantees every
// externally-originated request context IS stamped; the middleware
// tests assert it. Never call a grants-checking service method with a
// bare context.Background() on behalf of an external caller.
package authz

import (
	"context"
	"errors"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// ErrNamespaceForbidden is returned when the caller's grants do not
// include the target entity's namespace. Handlers map it to
// 403 {"error":"forbidden","code":"namespace_forbidden"} with no
// entity details.
var ErrNamespaceForbidden = errors.New("namespace forbidden")

// Grants is a caller's resolved data-plane namespace access.
type Grants struct {
	// Restricted false = unrestricted (all namespaces) — the default
	// for every user that predates the feature.
	Restricted bool
	// Allowed is the granted namespace set; only meaningful when
	// Restricted is true.
	Allowed map[string]struct{}
}

// GrantsFromUser derives Grants from a full user record.
func GrantsFromUser(u *models.User) Grants {
	if u == nil || !u.NamespacesRestricted {
		return Grants{}
	}
	allowed := make(map[string]struct{}, len(u.AllowedNamespaces))
	for _, ns := range u.AllowedNamespaces {
		allowed[ns] = struct{}{}
	}
	return Grants{Restricted: true, Allowed: allowed}
}

// Can reports whether the grants permit the given namespace.
// Fail-CLOSED on empty namespace: a restricted user cannot access
// records with a missing namespace (pre-migration strays). This is
// deliberately stricter than the list pages' old display rule.
func (g Grants) Can(ns string) bool {
	if !g.Restricted {
		return true
	}
	if ns == "" {
		return false
	}
	_, ok := g.Allowed[ns]
	return ok
}

// List returns the granted namespaces as a slice (order unspecified)
// plus the restricted flag — the shape repo filter injection wants.
func (g Grants) List() ([]string, bool) {
	if !g.Restricted {
		return nil, false
	}
	out := make([]string, 0, len(g.Allowed))
	for ns := range g.Allowed {
		out = append(out, ns)
	}
	return out, true
}

type ctxKey int

const (
	callerKey ctxKey = iota
	grantsKey
)

// WithGrants stamps the caller and their resolved grants onto ctx.
// The auth middleware calls this for every authenticated request.
func WithGrants(ctx context.Context, caller *models.User, g Grants) context.Context {
	ctx = context.WithValue(ctx, callerKey, caller)
	return context.WithValue(ctx, grantsKey, g)
}

// FromContext returns the stamped caller + grants. ok=false means the
// context was never stamped (internal caller — see package invariant).
func FromContext(ctx context.Context) (caller *models.User, g Grants, ok bool) {
	g, ok = ctx.Value(grantsKey).(Grants)
	caller, _ = ctx.Value(callerKey).(*models.User)
	return caller, g, ok
}

// Allowed reports whether ctx may access the namespace. Unstamped
// contexts are internal callers and always allowed (see invariant).
func Allowed(ctx context.Context, ns string) bool {
	_, g, ok := FromContext(ctx)
	if !ok {
		return true
	}
	return g.Can(ns)
}

// CheckNamespace returns ErrNamespaceForbidden when ctx may not access
// the namespace.
func CheckNamespace(ctx context.Context, ns string) error {
	if !Allowed(ctx, ns) {
		return ErrNamespaceForbidden
	}
	return nil
}

// AllowedList returns the granted-namespace slice + restricted flag
// for ctx, for injection into repository list filters. Unstamped or
// unrestricted → (nil, false) = no filter.
func AllowedList(ctx context.Context) ([]string, bool) {
	_, g, ok := FromContext(ctx)
	if !ok {
		return nil, false
	}
	return g.List()
}
