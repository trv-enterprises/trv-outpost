// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package idp

import (
	"context"
	"fmt"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// APIKeyIdP resolves `Authorization: Bearer trve_<base32>` API keys.
// These are the long-lived credentials we issue to non-interactive
// principals: system users (ts-store webhooks), kiosk displays
// (Kitchen Dashboard), and dashboard-agent. The API key remains the
// inbound bootstrap credential after the session-token refactor —
// it just gets traded for a JWT pair on the way in.
type APIKeyIdP struct {
	apiKeys *service.APIKeyService
	users   *service.UserService
}

// NewAPIKeyIdP wires the IdP to the existing services. Both are
// required.
func NewAPIKeyIdP(apiKeys *service.APIKeyService, users *service.UserService) *APIKeyIdP {
	return &APIKeyIdP{apiKeys: apiKeys, users: users}
}

func (p *APIKeyIdP) Name() string { return "apikey" }

func (p *APIKeyIdP) Resolve(ctx context.Context, c *gin.Context) (*models.User, error) {
	token := ExtractBearer(c)
	if token == "" {
		// Also check the query param — kiosks sometimes ship the
		// API key on the URL during bootstrap.
		token = c.Query("key")
	}
	if token == "" || !LooksLikeAPIKey(token) {
		// Not our credential shape — defer to the next provider.
		return nil, nil
	}

	key, err := p.apiKeys.Validate(ctx, token)
	if err != nil {
		return nil, fmt.Errorf("%w: apikey: %v", ErrCredentialInvalid, err)
	}
	if key == nil {
		return nil, fmt.Errorf("%w: apikey not found", ErrCredentialInvalid)
	}
	user, err := p.users.GetUserByGUID(ctx, key.UserGUID)
	if err != nil {
		return nil, fmt.Errorf("%w: lookup apikey owner: %v", ErrCredentialInvalid, err)
	}
	if user == nil {
		return nil, fmt.Errorf("%w: apikey owner not found", ErrCredentialInvalid)
	}
	if !user.Active {
		return nil, fmt.Errorf("%w: apikey owner inactive", ErrCredentialInvalid)
	}
	return user, nil
}
