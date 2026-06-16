// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"sort"
	"strings"
)

// AITag is the provenance tag stamped on every component/dashboard created by
// an AI surface (Dashboard Assistant, Component agent, MCP). It is applied
// server-side, not by the model, so provenance is reliable and shows up in the
// normal tag UI / filters — a lightweight alternative to a dedicated
// "ai_generated" model field + panel badge.
const AITag = "ai"

// WithAITag returns the tag slice with AITag appended and normalized (deduped),
// so AI create paths can mark provenance without clobbering caller-supplied
// descriptive tags. Idempotent: a slice that already contains "ai" is unchanged
// after normalization.
func WithAITag(in []string) []string {
	return NormalizeTags(append(append([]string{}, in...), AITag))
}

// NormalizeTags lowercases, trims, kebab-cases internal whitespace, dedupes,
// drops empties, and returns a sorted slice. The goal is to prevent tag
// fragmentation ("Home", "home", "HOME", "living room", "Living Room" all
// collapse to the same canonical form).
//
// This is the single source of truth for tag normalization and should be
// called in every entity create/update path before persisting tags.
func NormalizeTags(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		// Lowercase, then collapse all runs of whitespace to a single "-".
		// strings.Fields splits on any Unicode whitespace and trims empties.
		norm := strings.Join(strings.Fields(strings.ToLower(raw)), "-")
		if norm == "" {
			continue
		}
		if _, ok := seen[norm]; ok {
			continue
		}
		seen[norm] = struct{}{}
		out = append(out, norm)
	}
	sort.Strings(out)
	return out
}

// TagUsage is one entry in the GET /api/tags response, representing a tag
// and how many entities of each type reference it.
type TagUsage struct {
	Name        string `json:"name"`
	Count       int    `json:"count"` // total across all entity types
	Connections int    `json:"connections"`
	Components  int    `json:"components"`
	Dashboards  int    `json:"dashboards"`
}

// TagListResponse is the envelope for GET /api/tags.
type TagListResponse struct {
	Tags []TagUsage `json:"tags"`
}
