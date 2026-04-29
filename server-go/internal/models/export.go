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
	Components  []Component  `json:"components"`
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

// Import object kind constants — used in ImportObjectRef so the UI can
// route each entry to the right list/diff renderer.
const (
	ImportKindConnection = "connection"
	ImportKindComponent  = "component"
	ImportKindDashboard  = "dashboard"
)

// ImportObjectRef is a thin pointer to one entry in the bundle, used
// in the preflight response so the UI knows what's identical / new
// without resending the full payload.
//
// @Description Identifier for a single object inside an import bundle
type ImportObjectRef struct {
	Kind      string `json:"kind"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"` // Source namespace from the bundle
}

// ImportConflict describes one same-id-different-content collision
// detected in preflight. The diff payload is intentionally raw JSON so
// the UI can render whatever diff style it wants without server-side
// formatting decisions.
//
// @Description One conflict between an incoming object and an existing one with the same ID
type ImportConflict struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Name     string `json:"name"`
	Existing string `json:"existing"` // Existing object as a JSON string
	Incoming string `json:"incoming"` // Incoming object as a JSON string
}

// ImportBlocked describes a name collision the importer cannot resolve
// automatically: an object in the bundle would land at (target_namespace,
// name) where a *different* object already lives. Per the plan, the user
// must rename the existing object (or the bundle's object) before retry.
//
// @Description One name-collision that prevents the import from proceeding
type ImportBlocked struct {
	Kind            string `json:"kind"`
	IncomingID      string `json:"incoming_id"`
	IncomingName    string `json:"incoming_name"`
	ExistingID      string `json:"existing_id"`
	TargetNamespace string `json:"target_namespace"`
	Reason          string `json:"reason"`
}

// ImportPreflightRequest mirrors the shape of an ImportRequest minus
// the overwrite decisions — the preflight is read-only and exists so
// the UI can render the diff/blocked surface before the user commits.
//
// @Description Request to dry-run an import bundle against the target system
type ImportPreflightRequest struct {
	Bundle          ExportBundle `json:"bundle" binding:"required"`
	TargetNamespace string       `json:"target_namespace,omitempty"` // Empty falls back per the plan: bundle.SourceNamespace if it exists locally, else "default"
}

// ImportPreflightResponse partitions every object in the bundle into
// one of four buckets the UI surfaces differently:
//   identical: same id, byte-identical content — silently skipped.
//   conflicts: same id, different content — user reviews diffs and
//              decides per-object whether to overwrite.
//   new      : id not present locally — created on apply.
//   blocked  : (target_namespace, name) already exists with a different
//              id — user must resolve out-of-band before re-running.
//
// @Description Per-object classification produced by the import preflight
type ImportPreflightResponse struct {
	TargetNamespace string             `json:"target_namespace"` // The namespace the importer will write into (after fallbacks)
	Identical       []ImportObjectRef  `json:"identical"`
	Conflicts       []ImportConflict   `json:"conflicts"`
	New             []ImportObjectRef  `json:"new"`
	Blocked         []ImportBlocked    `json:"blocked"`
}

// ImportApplyRequest is the body for the apply endpoint. The bundle is
// re-sent (server doesn't keep state between preflight and apply —
// stateless and parallel-safe). OverwriteDecisions is keyed by
// "kind:id" so the user can opt in/out of each conflict.
//
// @Description Request to actually apply an import bundle
type ImportApplyRequest struct {
	Bundle             ExportBundle    `json:"bundle" binding:"required"`
	TargetNamespace    string          `json:"target_namespace,omitempty"`
	OverwriteDecisions map[string]bool `json:"overwrite_decisions,omitempty"` // Key: "kind:id". Default for missing key = true.
}

// ImportApplyResponse summarizes what happened. Errors are recorded
// per-object so a partial failure still tells the user which records
// landed and which didn't.
//
// @Description Result counts and per-object errors from an import apply
type ImportApplyResponse struct {
	Created int      `json:"created"`
	Updated int      `json:"updated"`
	Skipped int      `json:"skipped"`
	Errors  []string `json:"errors,omitempty"`
}
