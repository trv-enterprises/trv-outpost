// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"slices"

	"github.com/trv-enterprises/trve-dashboard/internal/authz"
)

// namespaceGrantsForList resolves the caller's namespace grants for a
// list query (issue #4). explicitNS is the user-supplied namespace
// filter ("" = none). Returns the grant fields to stamp onto the
// query params plus filterAllowed=false when the explicit filter is
// OUTSIDE the caller's grants — the service should then return an
// empty page (filters are not existence probes, so no 403).
func namespaceGrantsForList(ctx context.Context, explicitNS string) (allowed []string, restricted bool, filterAllowed bool) {
	allowed, restricted = authz.AllowedList(ctx)
	if !restricted || explicitNS == "" {
		return allowed, restricted, true
	}
	return allowed, restricted, slices.Contains(allowed, explicitNS)
}
