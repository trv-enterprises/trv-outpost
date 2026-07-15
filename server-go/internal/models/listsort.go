// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "go.mongodb.org/mongo-driver/bson"

// Shared list-query helpers for the four paginated entity lists
// (components, dashboards, connections, users). One place for the sort
// allowlists, sort resolution, and page-size clamping so the HTTP
// handlers and the AI/toolops path get identical behavior (#21).

// EntityRef is a minimal {id, name} pair so the frontend can show
// human-readable cross-entity references (and navigate to them) without a
// second round-trip. Used by the list usage-denormalization (#21) and the
// delete-orphan/usage flows. service.EntityRef aliases this.
//
// Namespace is decoded from the usage aggregations (#4) purely so the
// service redaction pass can decide whether the caller may see this
// ref. It is json:"-" — the raw namespace never reaches the client;
// RedactUsageRefs replaces an ungranted ref with {unauthorized:true,
// kind:...} instead. Unauthorized/Kind are the redacted OUTPUT shape.
type EntityRef struct {
	ID           string `json:"id,omitempty" bson:"id"`
	Name         string `json:"name,omitempty" bson:"name"`
	Namespace    string `json:"-" bson:"namespace,omitempty"`
	Unauthorized bool   `json:"unauthorized,omitempty" bson:"-"`
	Kind         string `json:"kind,omitempty" bson:"-"` // "component" | "connection" (set only when Unauthorized)
}

// PageSizeAllCap is the hard upper bound returned when a caller asks for
// "all" (page_size=0 or page_size="all"). It bounds the AI/MCP path —
// the agent can fetch everything-up-to-the-cap in one response, but a
// huge dataset can't blow its context or the HTTP body. The UI never
// asks for "all"; it always sends a concrete page size.
const PageSizeAllCap = 1000

// Per-entity sort allowlists: API sort-field name → Mongo field name.
// Anything not in the map falls back to the entity's documented default
// (see the Default* consts below), so an unknown/empty sort never errors
// and never changes the historical default ordering.
var (
	ComponentSortFields = map[string]string{
		"name":           "name",
		"updated":        "updated",
		"created":        "created",
		"component_type": "component_type",
		"chart_type":     "chart_type",
		"status":         "status",
		"namespace":      "namespace",
	}
	DashboardSortFields = map[string]string{
		"name":      "name",
		"updated":   "updated",
		"created":   "created",
		"namespace": "namespace",
	}
	ConnectionSortFields = map[string]string{
		"name":       "name",
		"created_at": "created_at",
		"updated_at": "updated_at",
		"type":       "type",
		"namespace":  "namespace",
	}
	UserSortFields = map[string]string{
		"name":    "name",
		"updated": "updated",
		"email":   "email",
	}
)

// Default sort field + direction per entity — these reproduce the
// behavior that was hardcoded in each repo before #21, so a list request
// with no sort param sorts exactly as it always has.
const (
	ComponentDefaultSortField  = "updated"
	ComponentDefaultSortDir    = -1
	DashboardDefaultSortField  = "name"
	DashboardDefaultSortDir    = 1
	ConnectionDefaultSortField = "created_at"
	ConnectionDefaultSortDir   = -1
	UserDefaultSortField       = "name"
	UserDefaultSortDir         = 1
)

// ResolveSort turns a requested (field, direction) into a Mongo sort
// document, validating against an allowlist. Unknown field → defaultField;
// direction is "asc"/"desc" (case-insensitive), anything else →
// defaultDir. Returns a bson.D the caller drops straight into a Find
// option or an aggregation $sort stage.
func ResolveSort(allow map[string]string, field, direction, defaultField string, defaultDir int) bson.D {
	mongoField, ok := allow[field]
	if !ok {
		mongoField = defaultField
	}
	dir := defaultDir
	switch direction {
	case "asc", "ASC", "Asc":
		dir = 1
	case "desc", "DESC", "Desc":
		dir = -1
	}
	return bson.D{{Key: mongoField, Value: dir}}
}

// ClampPageSize normalizes a requested page size to the canonical range.
// Rules: 0 → "all" (PageSizeAllCap, isAll=true); negative → defaultSize;
// above the cap → the cap. This is the single authority for page-size
// limits — services call it once and hand the clamped value to the repo,
// so the cap can't be bypassed via the HTTP body or the AI tools.
func ClampPageSize(pageSize, defaultSize int) (size int, isAll bool) {
	switch {
	case pageSize == 0:
		return PageSizeAllCap, true
	case pageSize < 0:
		return defaultSize, false
	case pageSize > PageSizeAllCap:
		return PageSizeAllCap, false
	default:
		return pageSize, false
	}
}

// ComputeHasMore reports whether more records exist beyond the current
// page: (page-1)*pageSize + returned < total. Callers pass the CLAMPED
// page size and the actual number of rows returned.
func ComputeHasMore(page, pageSize, returned int, total int64) bool {
	if page < 1 {
		page = 1
	}
	return int64((page-1)*pageSize+returned) < total
}
