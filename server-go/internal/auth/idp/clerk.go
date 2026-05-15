// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package idp

import (
	"context"
	"fmt"

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

	identity, err := p.verifier.VerifyToken(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("%w: clerk verify: %v", ErrCredentialInvalid, err)
	}
	user, err := auth.ResolveUserByVerifiedIdentity(ctx, p.users, identity)
	if err != nil {
		return nil, fmt.Errorf("%w: clerk resolve: %v", ErrCredentialInvalid, err)
	}
	if user == nil {
		return nil, fmt.Errorf("%w: clerk user not authorized for this deployment", ErrCredentialInvalid)
	}
	if !user.Active {
		return nil, fmt.Errorf("%w: clerk user inactive", ErrCredentialInvalid)
	}
	return user, nil
}
