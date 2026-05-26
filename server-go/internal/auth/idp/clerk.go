// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package idp

import (
	"context"
	"fmt"
	"log"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// ClerkJWTIdP wraps the existing auth.IdentityVerifier (a Clerk-
// backed JWT validator) as a provider. Only registered when Clerk
// is configured; main.go skips it otherwise.
//
// The bearer-shape dispatch is "starts with NOT-trve, looks like a
// JWT" — i.e. anything that isn't an API key. Order in the registry
// matters: APIKeyIdP runs first so its `trve_` prefix wins
// unambiguously.
type ClerkJWTIdP struct {
	verifier auth.IdentityVerifier
	users    *repository.UserRepository
}

func NewClerkJWTIdP(verifier auth.IdentityVerifier, users *repository.UserRepository) *ClerkJWTIdP {
	return &ClerkJWTIdP{verifier: verifier, users: users}
}

func (p *ClerkJWTIdP) Name() string { return "clerk" }

func (p *ClerkJWTIdP) Resolve(ctx context.Context, c *gin.Context) (*models.User, error) {
	if p.verifier == nil {
		return nil, nil
	}
	token := ExtractBearer(c)
	if token == "" {
		// Clerk SSE/WS bootstrap may put the JWT on the URL too —
		// same `?token=` channel the legacy stream paths used.
		token = c.Query("token")
	}
	if token == "" || LooksLikeAPIKey(token) {
		// Not our shape (either nothing, or an API key — APIKeyIdP
		// already had its shot).
		return nil, nil
	}

	// We log every failure path here. The bootstrap handler only
	// surfaces the error in the 401 response body — without these
	// logs, a silently-failing Clerk verifier is invisible from the
	// server side, which cost us hours to diagnose (turned out to be
	// a 15-hour clock skew on the prod-test VM that made every JWT
	// look future-dated to the verifier).
	identity, err := p.verifier.VerifyToken(ctx, token)
	if err != nil {
		log.Printf("[auth] clerk verify failed (token rejected by Clerk SDK): %v", err)
		return nil, fmt.Errorf("%w: clerk verify: %v", ErrCredentialInvalid, err)
	}
	user, err := auth.ResolveUserByVerifiedIdentity(ctx, p.users, identity)
	if err != nil {
		log.Printf("[auth] clerk user resolution failed for sub=%s email=%s: %v",
			identity.Subject, identity.Email, err)
		return nil, fmt.Errorf("%w: clerk resolve: %v", ErrCredentialInvalid, err)
	}
	if user == nil {
		log.Printf("[auth] clerk identity valid but no matching user record: sub=%s email=%s — set clerk_user_id on an existing user or create one with that email",
			identity.Subject, identity.Email)
		return nil, fmt.Errorf("%w: clerk user not authorized for this deployment", ErrCredentialInvalid)
	}
	if !user.Active {
		log.Printf("[auth] clerk identity matched user %s (%s) but user is inactive", user.ID, user.Email)
		return nil, fmt.Errorf("%w: clerk user inactive", ErrCredentialInvalid)
	}
	return user, nil
}
