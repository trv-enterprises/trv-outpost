// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// Snippet is a saved command associated with a host surface ("context")
// such as the EdgeLake terminal or a future MQTT publisher. Users may
// create personal snippets that only they can see; admins with Manage
// capability can curate global snippets that every user sees.
//
// Snippets are deliberately generic — the `Context` field is the seam
// that lets a future surface mount the same panel without bleeding its
// snippets across to other surfaces.
type Snippet struct {
	ID          string    `bson:"_id" json:"id"`
	Scope       string    `bson:"scope" json:"scope"`               // "user" | "global"
	OwnerUserID string    `bson:"owner_user_id,omitempty" json:"owner_user_id,omitempty"`
	Context     string    `bson:"context" json:"context"`           // e.g. "edgelake-terminal"
	Title       string    `bson:"title" json:"title"`
	Command     string    `bson:"command" json:"command"`
	Tags        []string  `bson:"tags" json:"tags"`
	Created     time.Time `bson:"created" json:"created"`
	Updated     time.Time `bson:"updated" json:"updated"`
}

// Snippet scope constants.
const (
	SnippetScopeUser   = "user"
	SnippetScopeGlobal = "global"
)

// CreateSnippetRequest is the body for POST /api/snippets.
type CreateSnippetRequest struct {
	Scope   string   `json:"scope" binding:"required"`
	Context string   `json:"context" binding:"required"`
	Title   string   `json:"title" binding:"required"`
	Command string   `json:"command" binding:"required"`
	Tags    []string `json:"tags"`
}

// UpdateSnippetRequest is the body for PUT /api/snippets/:id.
// Scope is intentionally immutable — to promote a user snippet to
// global, delete and re-create.
type UpdateSnippetRequest struct {
	Title   string   `json:"title" binding:"required"`
	Command string   `json:"command" binding:"required"`
	Tags    []string `json:"tags"`
}

// SnippetResponse decorates a Snippet with caller-derived fields the
// client uses to gate the Edit / Delete UI affordances.
type SnippetResponse struct {
	Snippet
	CanEdit bool `json:"can_edit"`
}

// SnippetListResponse is the GET /api/snippets response envelope.
type SnippetListResponse struct {
	Snippets []SnippetResponse `json:"snippets"`
}
