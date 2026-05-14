// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// Alert is a persisted notification record. Today the only producer
// is the ts-store webhook receiver; future inbound integrations
// (other webhook types, internal events) will write to the same
// collection so the bell panel has one unified backing store.
//
// Persistence model is "first reader clears it for everyone" with a
// per-record Pinned override. Defaults: Seen=false, Pinned=false.
// On bell load, a client asks for records where Seen=false OR
// Pinned=true. Any logged-in user dismissing an alert flips Seen
// to true and the alert drops off everyone's bell — but a user who
// wants another user to see the alert can Pin it first, and pinned
// alerts stay visible until someone explicitly unpins. This trades
// "every user sees every alert exactly once" for "no leak" — a
// stale account never holds an alert open, but explicit hand-off
// is still possible.
type Alert struct {
	ID           string                 `json:"id" bson:"_id"`
	FiredAt      time.Time              `json:"fired_at" bson:"fired_at"`        // when the upstream rule evaluated
	ReceivedAt   time.Time              `json:"received_at" bson:"received_at"`  // when the dashboard ingested it
	Severity     string                 `json:"severity" bson:"severity"`        // "info" | "warning" | "error"
	Title        string                 `json:"title" bson:"title"`              // bell-panel headline
	Subtitle     string                 `json:"subtitle,omitempty" bson:"subtitle,omitempty"`
	Source       string                 `json:"source,omitempty" bson:"source,omitempty"`   // free-form integration name (ts-store store name, etc.)
	RuleName     string                 `json:"rule_name,omitempty" bson:"rule_name,omitempty"`
	Namespace    string                 `json:"namespace,omitempty" bson:"namespace,omitempty"` // namespace of the originating connection; reserved for future per-user namespace gating
	ConnectionID string                 `json:"connection_id,omitempty" bson:"connection_id,omitempty"`
	Payload      map[string]interface{} `json:"payload,omitempty" bson:"payload,omitempty"` // raw upstream payload — opaque to today's UI, surfaced when an expand affordance lands
	// ExternalRef is the verbatim pass-through string the producer
	// (ts-store) attaches to its rule. We do not parse it on the
	// server beyond an opportunistic JSON-decode into DashboardID
	// for the deep-link case — anything we don't understand is left
	// alone so future producers can stash arbitrary structured data
	// there without requiring a server change.
	ExternalRef string `json:"external_ref,omitempty" bson:"external_ref,omitempty"`
	// DashboardID is the decoded `{"dashboard_id":"…"}` from
	// ExternalRef, populated at ingest time when the producer
	// followed that convention. Surfaces as the bell-row "Open
	// dashboard" link target. Empty when the producer didn't set
	// external_ref, or set it to something that wasn't a
	// dashboard_id-shaped JSON object — the bell row just hides the
	// link button in that case.
	DashboardID string `json:"dashboard_id,omitempty" bson:"dashboard_id,omitempty"`
	// Seen is the global "first reader clears it" flag. Flipped to
	// true by POST /api/alerts/:id/seen; flipped back to false when
	// the alert is pinned (so a pin acts like an "unread" reset).
	Seen bool `json:"seen" bson:"seen"`
	// Pinned keeps an alert visible regardless of Seen. Toggled via
	// POST /api/alerts/:id/pin / DELETE /api/alerts/:id/pin. A user
	// pins an alert when they want another user to see it; an
	// unpin from anyone returns the alert to normal seen-tracking.
	Pinned bool `json:"pinned" bson:"pinned"`
	// SeenBy / PinnedBy track who last performed each action — for
	// audit only. The list semantics are intentionally simple
	// (single user GUID, last writer wins) so we don't drift back
	// toward a per-user-seen model.
	SeenBy   string `json:"seen_by,omitempty" bson:"seen_by,omitempty"`
	PinnedBy string `json:"pinned_by,omitempty" bson:"pinned_by,omitempty"`
	SeenAt   *time.Time `json:"seen_at,omitempty" bson:"seen_at,omitempty"`
	PinnedAt *time.Time `json:"pinned_at,omitempty" bson:"pinned_at,omitempty"`
	// ExpiresAt drives the MongoDB TTL index. Defaults to 30 days
	// past ReceivedAt; once a per-deployment retention setting lands
	// this becomes computed from that. Pinned alerts are still
	// subject to TTL — pinning is "stay visible until cleared," not
	// "keep forever."
	ExpiresAt time.Time `json:"expires_at" bson:"expires_at"`
}

// AlertListResponse is the wire shape for GET /api/alerts. The Visible
// count is what the bell badge renders — Seen=false OR Pinned=true.
type AlertListResponse struct {
	Alerts  []Alert `json:"alerts"`
	Total   int64   `json:"total"`
	Visible int64   `json:"visible"`
}
