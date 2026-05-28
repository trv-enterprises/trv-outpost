// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// ChatUsageDay is one row per (user, UTC date) recording cumulative
// Anthropic token consumption for the Dashboard Assistant. Keyed by
// a composite ID built from user_guid + date so per-user-per-day
// counters are atomic via Mongo's $inc upsert.
//
// Rows are TTL-cleaned after a generous retention window (90 days)
// so admins can audit usage without keeping it forever.
type ChatUsageDay struct {
	ID           string    `bson:"_id" json:"id"`                   // user_guid + ":" + UTC date YYYY-MM-DD
	UserGUID     string    `bson:"user_guid" json:"user_guid"`
	DateUTC      string    `bson:"date_utc" json:"date_utc"`       // YYYY-MM-DD
	InputTokens  int64     `bson:"input_tokens" json:"input_tokens"`
	OutputTokens int64     `bson:"output_tokens" json:"output_tokens"`
	Created      time.Time `bson:"created" json:"created"`
	Updated      time.Time `bson:"updated" json:"updated"`
}
