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

// LegacyGUIDIdP resolves the X-User-ID header and the ?user_id=
// query param — two shapes for the same channel: "trust whoever
// presents this GUID." Honored only at the bootstrap endpoint and
// only when explicitly enabled in config (deployments going to
// production can turn it off; dev keeps it on for the user
// switcher and act-as flows).
//
// Trust model: anyone who knows a GUID becomes that user. This is
// identity assertion, not authentication. Acceptable on a homelab
// behind tailnet/VPN; never expose this provider on a public
// deployment without a separate access-control layer.
//
// System users cannot bootstrap via this provider — they must use
// an API key. Enforcing here keeps a stolen / leaked GUID from
// being usable to impersonate a service principal.
type LegacyGUIDIdP struct {
	users *service.UserService
}

func NewLegacyGUIDIdP(users *service.UserService) *LegacyGUIDIdP {
	return &LegacyGUIDIdP{users: users}
}

func (p *LegacyGUIDIdP) Name() string { return "legacy-guid" }

func (p *LegacyGUIDIdP) Resolve(ctx context.Context, c *gin.Context) (*models.User, error) {
	guid := c.GetHeader("X-User-ID")
	if guid == "" {
		guid = c.Query("user_id")
	}
	if guid == "" {
		return nil, nil
	}
	user, err := p.users.GetUserByGUID(ctx, guid)
	if err != nil {
		return nil, fmt.Errorf("%w: legacy guid: %v", ErrCredentialInvalid, err)
	}
	if user == nil {
		return nil, fmt.Errorf("%w: legacy guid not found", ErrCredentialInvalid)
	}
	if !user.Active {
		return nil, fmt.Errorf("%w: legacy guid user inactive", ErrCredentialInvalid)
	}
	if user.IsSystem() {
		return nil, fmt.Errorf("%w: system user cannot bootstrap via legacy GUID — use API key", ErrCredentialInvalid)
	}
	return user, nil
}
