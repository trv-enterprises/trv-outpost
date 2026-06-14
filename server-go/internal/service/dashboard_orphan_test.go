// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"sort"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// panelComponentIDs must collect BOTH the panel's default component_id AND
// every ComponentOverride's component_id (orphan detection counts override refs
// as real references — issue #65), de-duplicated, skipping empties.
func TestPanelComponentIDs(t *testing.T) {
	d := &models.Dashboard{
		Panels: []models.DashboardPanel{
			{ComponentID: "a"},
			{ComponentID: "b", ComponentOverrides: []models.ComponentOverride{
				{ComponentID: "c"},
				{ComponentID: "a"}, // dup of a default — must de-dup
			}},
			{ComponentID: ""},                 // text/empty panel — skipped
			{TextConfig: &models.PanelTextConfig{Content: "x"}}, // no component
			{ComponentID: "b"},                // dup default — must de-dup
		},
	}
	got := panelComponentIDs(d)
	sort.Strings(got)
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestPanelComponentIDs_Empty(t *testing.T) {
	if got := panelComponentIDs(nil); got != nil {
		t.Errorf("nil dashboard → %v, want nil", got)
	}
	if got := panelComponentIDs(&models.Dashboard{}); got != nil {
		t.Errorf("no panels → %v, want nil", got)
	}
}
