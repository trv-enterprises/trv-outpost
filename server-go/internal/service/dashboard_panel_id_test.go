// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

func TestEnsurePanelIDs(t *testing.T) {
	// All-empty (the AI-surface bug): every panel must get a UNIQUE id.
	panels := []models.DashboardPanel{
		{ComponentID: "a"}, {ComponentID: "b"}, {ComponentID: "c"},
	}
	ensurePanelIDs(panels)
	seen := map[string]bool{}
	for i, p := range panels {
		if p.ID == "" {
			t.Errorf("panel %d still has empty id", i)
		}
		if seen[p.ID] {
			t.Errorf("panel %d has duplicate id %q", i, p.ID)
		}
		seen[p.ID] = true
	}

	// Existing non-empty ids are preserved; duplicates are regenerated.
	panels2 := []models.DashboardPanel{
		{ID: "keep-1"}, {ID: "dup"}, {ID: "dup"}, {ID: ""},
	}
	ensurePanelIDs(panels2)
	if panels2[0].ID != "keep-1" {
		t.Errorf("non-empty unique id was changed: %q", panels2[0].ID)
	}
	if panels2[1].ID != "dup" {
		t.Errorf("first occurrence of dup id should be kept: %q", panels2[1].ID)
	}
	if panels2[2].ID == "dup" || panels2[2].ID == "" {
		t.Errorf("duplicate id should have been regenerated, got %q", panels2[2].ID)
	}
	if panels2[3].ID == "" {
		t.Error("empty id should have been assigned")
	}
	all := map[string]bool{}
	for i, p := range panels2 {
		if all[p.ID] {
			t.Errorf("panel %d id %q not unique after fix", i, p.ID)
		}
		all[p.ID] = true
	}
}
