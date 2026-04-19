// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// ExportFormatVersion is the schema version for export bundles.
// Bump on any breaking change to the bundle shape; keep additive
// changes at the same version.
const ExportFormatVersion = 1

// ExportBundle is the on-disk format for dashboard exports. Single
// JSON file with everything a dashboard needs to come back online on
// another system: connections it talks to, components it renders,
// and the dashboards themselves.
//
// IDs are preserved end-to-end so re-importing the same bundle is
// idempotent (target system either already has them, or they land
// fresh under the same UUIDs).
//
// @Description Portable bundle representing one or more dashboards plus their dependencies
type ExportBundle struct {
	FormatVersion   int           `json:"format_version"`
	ExportedAt      time.Time     `json:"exported_at"`
	ExportedBy      string        `json:"exported_by,omitempty"`
	SourceNamespace string        `json:"source_namespace"` // Empty string when the export spans multiple namespaces
	Objects         ExportObjects `json:"objects"`
}

// ExportObjects holds the three entity arrays in dependency order:
// connections come first because components reference them, components
// before dashboards because dashboards reference them. The importer
// processes the arrays in this order so foreign-key targets always
// exist by the time they're needed.
//
// @Description Entity arrays inside an export bundle, in dependency order
type ExportObjects struct {
	Connections []Datasource `json:"connections"`
	Components  []Chart      `json:"components"`
	Dashboards  []Dashboard  `json:"dashboards"`
}

// ExportRequest is the body for POST /api/dashboards/export[/preview].
// @Description Request to export one or more dashboards
type ExportRequest struct {
	DashboardIDs []string `json:"dashboard_ids" binding:"required"`
}

// ExportPreview is returned by the preview endpoint so the UI can show
// what's about to be downloaded ("X connections, Y components, Z
// dashboards") before the user commits.
//
// @Description Counts of the entities that would be included in an export
type ExportPreview struct {
	ConnectionCount int    `json:"connection_count"`
	ComponentCount  int    `json:"component_count"`
	DashboardCount  int    `json:"dashboard_count"`
	SourceNamespace string `json:"source_namespace"` // Empty when the selection spans multiple namespaces
	Warnings        []string `json:"warnings,omitempty"` // e.g., "dashboard X references chart Y which has no final version"
}
