// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package auth defines the pluggable identity-verifier interface used
// by the dashboard's authentication middleware. Concrete verifiers
// (Clerk today; generic OIDC and trusted reverse-proxy in future
// releases) live in sibling files in this package.
//
// The interface lets the middleware stay provider-agnostic: it asks a
// verifier "is this token valid? if so, who's it for?" and translates
// the (subject, email) tuple into an internal User via
// ResolveUserByVerifiedIdentity. Adding a new auth source is a new
// IdentityVerifier implementation — no middleware changes.
package auth

import (
	"context"
	"errors"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// VerifiedIdentity is what a successful token verification returns.
// Subject is the provider-specific stable identifier (Clerk's
// `sub` claim, an OIDC `sub`, etc.). Email is the verified email
// claim when the provider supplies one — used for first-time
// JIT-linking to an existing User record. Either field may be empty
// only if the provider doesn't supply it; ResolveUserByVerifiedIdentity
// requires at least one to find a matching User.
type VerifiedIdentity struct {
	Subject string
	Email   string
}

// IdentityVerifier validates a bearer token from an external identity
// provider. Implementations must:
//
//   - return ErrInvalidToken (or wrap it) when the token can't be
//     verified — bad signature, expired, wrong issuer, etc.
//   - never return a partially-populated VerifiedIdentity on error.
//   - be safe for concurrent use; the middleware calls VerifyToken
//     on the request hot path.
//
// The token argument is the raw bearer value (no "Bearer " prefix).
type IdentityVerifier interface {
	VerifyToken(ctx context.Context, token string) (*VerifiedIdentity, error)
	// ProviderName is used in log lines and error messages. e.g.
	// "clerk", "oidc", "proxy-header".
	ProviderName() string
}

// ErrInvalidToken is the umbrella error verifiers wrap when a token
// fails any verification step. The middleware maps this to a 401.
var ErrInvalidToken = errors.New("invalid token")

// ErrUserNotAuthorized is returned by ResolveUserByVerifiedIdentity
// when the token verifies but no matching User record exists in the
// dashboard. The middleware maps this to 401 with a "your account
// exists in the IdP but isn't authorized for this deployment" message
// so admins can pre-provision intentionally.
var ErrUserNotAuthorized = errors.New("user not authorized for this deployment")

// UserResolver is the narrow shape ResolveUserByVerifiedIdentity needs
// from the user repository. Defined here as an interface so the
// resolution function isn't tied to *repository.UserRepository — keeps
// it testable and lets a future implementation (e.g. caching layer)
// drop in transparently.
type UserResolver interface {
	FindByClerkID(ctx context.Context, clerkID string) (*models.User, error)
	FindByEmail(ctx context.Context, email string) (*models.User, error)
	SetClerkID(ctx context.Context, userID, clerkID string) error
}

// ResolveUserByVerifiedIdentity translates a verified identity into a
// dashboard User using the hybrid match-and-JIT-link policy:
//
//  1. Subject lookup. If the user already has the verifier's subject
//     stored on their record (`clerk_user_id` for Clerk), return that
//     user. This is the steady-state path — fastest, most stable.
//  2. Email JIT link. If subject lookup misses but the verified email
//     matches an existing User's email, persist the subject onto that
//     User and return them. The next request takes the fast path.
//  3. Otherwise return ErrUserNotAuthorized. We never auto-create
//     User records — admins pre-provision deliberately.
//
// The resolver is verifier-agnostic: it stores whatever Subject the
// verifier gave us, in the same `clerk_user_id` field. When OIDC and
// proxy modes land, they'll either share the field (if we accept the
// "one external identity per user" assumption) or get their own
// fields. That's a v0.11.0 decision — for v0.10.0 there's only Clerk.
func ResolveUserByVerifiedIdentity(
	ctx context.Context,
	repo UserResolver,
	identity *VerifiedIdentity,
) (*models.User, error) {
	if identity == nil || (identity.Subject == "" && identity.Email == "") {
		return nil, fmt.Errorf("%w: empty identity", ErrInvalidToken)
	}

	// Step 1: subject lookup.
	if identity.Subject != "" {
		user, err := repo.FindByClerkID(ctx, identity.Subject)
		if err != nil {
			return nil, fmt.Errorf("clerk-id lookup: %w", err)
		}
		if user != nil {
			return user, nil
		}
	}

	// Step 2: email JIT link.
	if identity.Email != "" {
		user, err := repo.FindByEmail(ctx, identity.Email)
		if err != nil {
			return nil, fmt.Errorf("email lookup: %w", err)
		}
		if user != nil {
			// Persist the link so future requests take the fast path.
			// Best-effort: a failure here doesn't deny the current
			// request — the user is already authenticated. We just
			// pay the email lookup cost again next time.
			if identity.Subject != "" {
				_ = repo.SetClerkID(ctx, user.ID, identity.Subject)
			}
			return user, nil
		}
	}

	return nil, ErrUserNotAuthorized
}

// EnsureRepoSatisfiesUserResolver is a compile-time assertion that
// the live UserRepository implements the narrow UserResolver shape.
// If you change the interface, this won't compile until the repo
// catches up.
var _ UserResolver = (*repository.UserRepository)(nil)
