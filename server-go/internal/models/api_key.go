// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// APIKey is a per-user authentication token used by non-browser
// callers (the dashboard-agent CLI, MCP clients, scripts). The
// plaintext token is shown to the user exactly once at creation
// and never persisted; only the bcrypt hash lives in the database,
// alongside a short plaintext prefix for the auth middleware to
// short-circuit candidate lookup.
//
// Token format: `trve_<43-char-base32>`. The plaintext prefix
// stored on the record is the first 8 characters AFTER the `trve_`
// scheme prefix — enough for prefix-indexed lookup, far too short
// to brute-force the rest.
type APIKey struct {
	ID        string     `bson:"_id" json:"id"`              // UUID
	UserGUID  string     `bson:"user_guid" json:"user_guid"` // Owner
	Name      string     `bson:"name" json:"name"`           // Human label
	Prefix    string     `bson:"prefix" json:"prefix"`       // First 8 chars of the random token, plaintext
	Hash      string     `bson:"hash" json:"-"`              // bcrypt(plaintext); never returned over the API
	LastUsed  *time.Time `bson:"last_used,omitempty" json:"last_used,omitempty"`
	Created   time.Time  `bson:"created" json:"created"`
	Revoked   bool       `bson:"revoked" json:"revoked"`
	RevokedAt *time.Time `bson:"revoked_at,omitempty" json:"revoked_at,omitempty"`
	ExpiresAt *time.Time `bson:"expires_at,omitempty" json:"expires_at,omitempty"`
}

// CreateAPIKeyRequest is the body of POST /api/api-keys. The
// service generates the token; the caller only names it.
type CreateAPIKeyRequest struct {
	Name      string     `json:"name" binding:"required"`
	ExpiresAt *time.Time `json:"expires_at,omitempty"` // Optional — null = never expires
}

// CreateAPIKeyResponse is returned exactly once when a key is
// created. The Token field carries the plaintext that the caller
// must save immediately — it cannot be retrieved later.
type CreateAPIKeyResponse struct {
	APIKey APIKey `json:"api_key"`
	Token  string `json:"token"` // PLAINTEXT — shown once, never persisted
}
