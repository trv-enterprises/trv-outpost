// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package repository

import "go.mongodb.org/mongo-driver/bson"

// applyNamespaceGrant narrows a list filter to the caller's granted
// namespaces (issue #4). No-op for unrestricted callers. For
// restricted callers the clause is a strict `namespace ∈ allowed` —
// fail-CLOSED: records with a missing/empty namespace (pre-migration
// strays) are NOT visible to restricted users. (The list pages'
// old "records missing a namespace stay visible" rule was a display
// nicety, not an authorization rule.) Restricted with an empty
// allowed list matches nothing.
//
// Interaction with an explicit user namespace filter: the SERVICE
// intersects first (an explicit filter outside the grant set must
// yield an empty page, not a probe result) — by the time the filter
// reaches here, filter["namespace"] set by the user's own params is
// only ever a granted namespace, and this helper leaves it alone.
func applyNamespaceGrant(filter bson.M, restricted bool, allowed []string) {
	if !restricted {
		return
	}
	if _, hasExplicit := filter["namespace"]; hasExplicit {
		return
	}
	if allowed == nil {
		allowed = []string{}
	}
	// Composed via $and: the component list filter already uses a
	// top-level $or for its multi-value type matching — assigning
	// a bare namespace key is fine, but $and keeps this robust if a
	// namespace clause ever appears in a sibling filter shape.
	clause := bson.M{"namespace": bson.M{"$in": allowed}}
	if existing, ok := filter["$and"].([]bson.M); ok {
		filter["$and"] = append(existing, clause)
	} else {
		filter["$and"] = []bson.M{clause}
	}
}
