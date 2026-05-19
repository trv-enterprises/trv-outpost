// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// WebhookSecret authorises one URL-embedded secret for one tsstore
// connection's webhook receiver. The receiver is a deliberately
// public route — anyone with the secret can deliver a webhook to
// that connection — so the secret value is the only thing keeping
// random callers out. Treat the field like a password: store the
// raw value (we have no choice; ts-store sends it back unchanged on
// every fire), don't surface it in any list response, and gate
// management on `Manage` capability.
//
// Secrets are scoped to one connection rather than one rule because
// ts-store rules are configured by URL, not by ID, and the dashboard
// has no way to map an inbound payload back to the rule that fired
// it — only to the connection. One connection can have multiple
// secrets (different rules can use different secrets so a single
// compromised rule can be revoked without breaking the others).
type WebhookSecret struct {
	ID           string     `json:"id" bson:"_id"`
	Secret       string     `json:"-" bson:"secret"` // never serialise to the wire
	ConnectionID string     `json:"connection_id" bson:"connection_id"`
	Label        string     `json:"label,omitempty" bson:"label,omitempty"`
	CreatedAt    time.Time  `json:"created_at" bson:"created_at"`
	CreatedBy    string     `json:"created_by,omitempty" bson:"created_by,omitempty"` // user GUID
	LastUsedAt   *time.Time `json:"last_used_at,omitempty" bson:"last_used_at,omitempty"`
}
