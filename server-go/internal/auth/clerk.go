// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package auth

import (
	"context"
	"fmt"
	"strings"

	"github.com/clerk/clerk-sdk-go/v2"
	clerkjwt "github.com/clerk/clerk-sdk-go/v2/jwt"
	clerkuser "github.com/clerk/clerk-sdk-go/v2/user"
)

// ClerkVerifier validates session JWTs issued by Clerk and translates
// them into VerifiedIdentity. It uses the Clerk SDK's JWT verifier
// (which handles JWKS fetch, caching, and signature validation) and
// optionally calls the Clerk Users API on first verification to
// retrieve the verified email — Clerk's default JWT template doesn't
// embed email, so we look it up by user ID once and the
// JIT-linking step (handled by ResolveUserByVerifiedIdentity) bakes
// the link onto the User record. Subsequent requests resolve via the
// dashboard's `clerk_user_id` field, no extra Clerk API calls needed.
//
// The verifier is constructed only when CLERK_SECRET_KEY is set in
// the environment. The constructor configures the SDK's package-level
// default backend with the secret — that's how the SDK's User and
// JWKS clients pick up authentication. There is no per-request
// secret-passing.
type ClerkVerifier struct {
	userClient *clerkuser.Client
}

// NewClerkVerifier configures the Clerk SDK with the given secret key
// and returns a verifier ready to validate session JWTs. The secret
// key is what makes the verifier work — without it, JWKS fetches and
// User API calls would be unauthenticated and rejected by Clerk.
//
// Returns an error if secretKey is empty so the caller (main.go) can
// distinguish "Clerk disabled" from "Clerk misconfigured."
func NewClerkVerifier(secretKey string) (*ClerkVerifier, error) {
	if secretKey == "" {
		return nil, fmt.Errorf("clerk secret key is required")
	}
	clerk.SetKey(secretKey)
	return &ClerkVerifier{
		userClient: clerkuser.NewClient(&clerk.ClientConfig{}),
	}, nil
}

// ProviderName implements IdentityVerifier.
func (v *ClerkVerifier) ProviderName() string { return "clerk" }

// VerifyToken validates a Clerk session JWT and returns the verified
// identity. The Clerk SDK does the heavy lifting: parses the token,
// fetches the appropriate JWK from Clerk's JWKS endpoint, validates
// the signature, and checks `iss`/`exp`/`nbf`.
//
// On success, the returned identity carries:
//   - Subject: the Clerk user ID (`sub` claim, e.g. `user_2abc…`)
//   - Email:   the user's primary verified email, fetched via the
//     Users API on demand. Empty if the lookup fails — the
//     resolver will fall through to ErrUserNotAuthorized in
//     that case (subject lookup may still succeed if a prior
//     JIT-link or admin override populated `clerk_user_id`).
//
// Errors from the SDK are wrapped in ErrInvalidToken so the middleware
// emits a uniform 401 regardless of which validation step failed.
func (v *ClerkVerifier) VerifyToken(ctx context.Context, token string) (*VerifiedIdentity, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, fmt.Errorf("%w: empty token", ErrInvalidToken)
	}

	claims, err := clerkjwt.Verify(ctx, &clerkjwt.VerifyParams{Token: token})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if claims == nil || claims.Subject == "" {
		return nil, fmt.Errorf("%w: missing subject claim", ErrInvalidToken)
	}

	// Email isn't on the default Clerk session JWT, so look it up via
	// the Users API. This is one extra round-trip on first-time
	// sign-in; once the JIT link is persisted in the dashboard the
	// resolver finds the user via clerk_user_id and we skip back to
	// just the JWT verification path.
	email := v.fetchPrimaryEmail(ctx, claims.Subject)

	return &VerifiedIdentity{
		Subject: claims.Subject,
		Email:   email,
	}, nil
}

// fetchPrimaryEmail returns the primary verified email for a Clerk
// user, or "" if the lookup fails or no primary email is set. Failures
// are deliberately swallowed — the caller treats empty email as
// "unable to JIT-link," which falls through to the steady-state
// subject-lookup path. We never block authentication on a Clerk API
// hiccup.
func (v *ClerkVerifier) fetchPrimaryEmail(ctx context.Context, clerkUserID string) string {
	if v.userClient == nil {
		return ""
	}
	u, err := v.userClient.Get(ctx, clerkUserID)
	if err != nil || u == nil || u.PrimaryEmailAddressID == nil {
		return ""
	}
	primaryID := *u.PrimaryEmailAddressID
	for _, em := range u.EmailAddresses {
		if em != nil && em.ID == primaryID {
			return em.EmailAddress
		}
	}
	return ""
}
