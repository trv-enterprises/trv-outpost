// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// ChatToolResult is a server-side copy of a single tool invocation's
// full output, stored when the raw result is too large to feed back
// to the model directly. The chat agent inlines a one-line summary
// + this record's ID into the conversation; the model can fetch the
// full content via the get_full_result meta-tool when needed.
//
// Records are TTL-cleaned (~24h), matching the ephemeral nature of
// chat sessions. They're indexed by SessionID so a Clear-chat action
// can sweep all results for that session at once.
type ChatToolResult struct {
	ID        string    `bson:"_id" json:"id"`
	SessionID string    `bson:"session_id" json:"session_id"`
	ToolName  string    `bson:"tool_name" json:"tool_name"`
	Summary   string    `bson:"summary" json:"summary"`     // the inline-context one-liner shown to the model
	FullJSON  string    `bson:"full_json" json:"full_json"` // the verbatim tool output (JSON string)
	Bytes     int       `bson:"bytes" json:"bytes"`         // size of full_json, for accounting
	Created   time.Time `bson:"created" json:"created"`     // for TTL
}
