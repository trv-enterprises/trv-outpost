// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package idp holds the pluggable identity-provider implementations
// used by the bootstrap endpoint (/api/auth/session). Each provider
// knows how to inspect an inbound request for ITS credential shape
// (Clerk JWT, API key, X-User-ID header, etc.), validate it against
// the relevant upstream (Clerk, our user DB, etc.), and return the
// resolved User. The bootstrap handler iterates the registry and
// stops at the first provider that resolves the caller.
//
// Adding a new IdP (SAML, OIDC against a non-Clerk provider, hardware
// keys, anything) means writing one file in this package that
// implements IdentityProvider and registering it in main.go. The
// session/token layer and every other consumer is unchanged.
package idp

import (
	"context"
	"errors"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// IdentityProvider validates an inbound credential and resolves it to
// a dashboard User. Implementations are tried in order at the
// bootstrap endpoint; the first one whose Resolve() returns a non-
// nil user wins.
//
// Resolve returns (nil, nil) when the provider DIDN'T see its kind
// of credential on this request (e.g. no Authorization header at
// all). It returns (nil, err) when it saw its credential but the
// credential failed validation. The distinction lets the registry
// fall through cleanly without burying real auth failures.
type IdentityProvider interface {
	// Name identifies the provider in audit logs and the
	// SourceChannel claim on issued tokens. Conventional values:
	// "clerk", "apikey", "x-user-id", "userid-query".
	Name() string

	// Resolve inspects the incoming request for this provider's
	// credential shape.
	//
	// Returns:
	//   - (*User, nil) on successful resolution
	//   - (nil, nil)   when this provider's credential isn't
	//                  present on the request (registry moves on)
	//   - (nil, err)   when the credential WAS present but invalid
	//                  (registry stops; handler returns 401)
	Resolve(ctx context.Context, c *gin.Context) (*models.User, error)
}

// Registry holds the ordered list of providers. Order matters —
// providers earlier in the list win in cases where a request
// carries multiple credentials (e.g. both an API key AND an
// X-User-ID header — the API key wins because it's a stronger
// authentication signal).
type Registry struct {
	providers []IdentityProvider
}

// NewRegistry builds a registry from the given providers, preserving
// the order they were passed. main.go composes the list at startup;
// the order is deliberate.
func NewRegistry(providers ...IdentityProvider) *Registry {
	return &Registry{providers: providers}
}

// Resolve walks the registry in order. Returns the first non-nil
// User any provider produces. Returns (nil, nil) when no provider's
// credential is on the request (caller decides: 401, or fall through
// to anonymous/Public:true rules). Returns (nil, err) the moment a
// provider's credential validates as bad — short-circuits rather
// than continuing to try weaker providers, because the inbound
// caller stated which auth they intended.
//
// The provider that resolved is returned as the third value so the
// caller can stamp the SourceChannel claim onto the issued token.
func (r *Registry) Resolve(ctx context.Context, c *gin.Context) (*models.User, IdentityProvider, error) {
	for _, p := range r.providers {
		user, err := p.Resolve(ctx, c)
		if err != nil {
			return nil, p, err
		}
		if user != nil {
			return user, p, nil
		}
	}
	return nil, nil, nil
}

// Providers returns the ordered list. Useful for diagnostic endpoints
// and tests.
func (r *Registry) Providers() []IdentityProvider {
	return r.providers
}

// ErrCredentialInvalid is the umbrella any provider can return when
// its credential was present but didn't validate. The bootstrap
// handler maps this to 401. Each provider should wrap this with
// detail (e.g. "clerk: signature failed", "apikey: not found")
// for the logs.
var ErrCredentialInvalid = errors.New("inbound credential invalid")
