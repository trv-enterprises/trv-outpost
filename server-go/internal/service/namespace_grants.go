// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"slices"

	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
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

// redactUsageRefs replaces each cross-entity usage ref the caller may
// not see with an opaque {unauthorized:true, kind:...} placeholder,
// stripping its id, name, AND namespace (the namespace itself is a
// leak). kind is "component" or "connection". Returns the redacted
// slice and whether ANY entry was redacted (→ warning badge). No-op
// for unrestricted callers.
func redactUsageRefs(ctx context.Context, refs []models.EntityRef, kind string) ([]models.EntityRef, bool) {
	_, g, ok := authz.FromContext(ctx)
	if !ok || !g.Restricted {
		// Unrestricted (or internal): strip the decode-only namespace
		// so it never serializes, but reveal everything.
		for i := range refs {
			refs[i].Namespace = ""
		}
		return refs, false
	}
	redactedAny := false
	out := make([]models.EntityRef, len(refs))
	for i, ref := range refs {
		if g.Can(ref.Namespace) {
			ref.Namespace = ""
			out[i] = ref
			continue
		}
		out[i] = models.EntityRef{Unauthorized: true, Kind: kind}
		redactedAny = true
	}
	return out, redactedAny
}
