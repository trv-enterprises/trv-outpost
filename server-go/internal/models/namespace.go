// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"fmt"
	"regexp"
	"time"
)

// DefaultNamespace is the slug every legacy record is migrated into on
// first boot, and the fallback when a client omits the namespace field on
// a create request. Must always exist — seeded at startup.
const DefaultNamespace = "default"

// namespaceSlugPattern matches Kubernetes-ish lowercase slugs: must start
// and end with [a-z0-9], inner chars can include hyphens, total length 3-32.
// Deliberately conservative so slugs are safe in filenames and URLs.
var namespaceSlugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$`)

// ValidateNamespaceSlug returns nil if the slug is acceptable, otherwise
// a descriptive error. Keep error messages concrete so the UI can show
// them directly without translation.
func ValidateNamespaceSlug(slug string) error {
	if slug == "" {
		return fmt.Errorf("namespace is required")
	}
	if !namespaceSlugPattern.MatchString(slug) {
		return fmt.Errorf("namespace must be 3-32 characters, lowercase letters/numbers/hyphens, starting and ending with alphanumeric")
	}
	return nil
}

// Namespace is the conflict-domain grouping applied to connections,
// components (charts/controls/displays), and dashboards. Uniqueness of
// names on those entities is scoped to (namespace, name) — two namespaces
// can each have a dashboard called "Home" without collision. Namespaces
// themselves are globally unique by slug.
//
// @Description Namespace groups connections, components, and dashboards into conflict domains
type Namespace struct {
	ID          string    `json:"id" bson:"_id"`
	Name        string    `json:"name" bson:"name"`
	Description string    `json:"description" bson:"description"`
	Color       string    `json:"color" bson:"color"` // Carbon-safe hex; UI picks from a fixed palette
	Created     time.Time `json:"created" bson:"created"`
	Updated     time.Time `json:"updated" bson:"updated"`
}

// CreateNamespaceRequest is the request body for POST /api/namespaces.
// @Description Request body for creating a new namespace
type CreateNamespaceRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
	Color       string `json:"color"`
}

// UpdateNamespaceRequest is the request body for PUT /api/namespaces/:id.
// Renaming a namespace cascades the new name onto every record that
// references it (see namespace service Update).
// @Description Request body for updating an existing namespace
type UpdateNamespaceRequest struct {
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	Color       *string `json:"color,omitempty"`
}

// NamespaceListResponse is the envelope for GET /api/namespaces.
// @Description Response containing a list of namespaces
type NamespaceListResponse struct {
	Namespaces []Namespace `json:"namespaces"`
	Total      int64       `json:"total"`
}

// NamespaceUsage reports how many of each record type reference a
// namespace, used by the delete-guard 409 response so the UI can tell
// the user why the delete was rejected.
// @Description Usage counts by entity type for a namespace
type NamespaceUsage struct {
	Connections int64 `json:"connections"`
	Components  int64 `json:"components"`
	Dashboards  int64 `json:"dashboards"`
}
