// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

func TestSanitizeAdornmentsBackfillsIDs(t *testing.T) {
	// Same collision hazard as panels: empty ids are all equal, so the editor
	// would resolve every op to the first adornment.
	adornments := []models.DashboardAdornment{
		{Kind: "border"}, {Kind: "border"}, {ID: "dup"}, {ID: "dup"},
	}
	sanitizeAdornments(adornments)

	seen := map[string]bool{}
	for i, a := range adornments {
		if a.ID == "" {
			t.Errorf("adornment %d still has empty id", i)
		}
		if seen[a.ID] {
			t.Errorf("adornment %d has duplicate id %q", i, a.ID)
		}
		seen[a.ID] = true
	}
}

func TestSanitizeAdornmentsPreservesExistingIDs(t *testing.T) {
	adornments := []models.DashboardAdornment{{ID: "keep-me", Kind: "border"}}
	sanitizeAdornments(adornments)
	if adornments[0].ID != "keep-me" {
		t.Errorf("id was regenerated: got %q, want %q", adornments[0].ID, "keep-me")
	}
}

func TestSanitizeAdornmentsCoercesWidth(t *testing.T) {
	// A gutter border hugs the panel edge and grows outward, so odd widths
	// are legal. Anything outside the set is coerced rather than rejected —
	// a bad width must not cost the user their panel edits.
	cases := []struct {
		name string
		in   int
		want int
	}{
		{"zero coerced", 0, 1},
		{"negative coerced", -4, 1},
		{"oversized coerced", 99, 1},
		{"valid 1 kept", 1, 1},
		{"valid 2 kept", 2, 2},
		{"valid 3 kept", 3, 3},
		{"valid 4 kept", 4, 4},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := []models.DashboardAdornment{{ID: "x", Width: tc.in}}
			sanitizeAdornments(a)
			if a[0].Width != tc.want {
				t.Errorf("width %d: got %d, want %d", tc.in, a[0].Width, tc.want)
			}
		})
	}
}

func TestSanitizeAdornmentsCoercesLineStyle(t *testing.T) {
	cases := map[string]string{
		"solid":  "solid",
		"dashed": "dashed",
		"dotted": "dotted",
		"":       "solid",
		"groovy": "solid",
		"DASHED": "solid", // case-sensitive by design; the client sends lowercase
	}
	for in, want := range cases {
		a := []models.DashboardAdornment{{ID: "x", LineStyle: in}}
		sanitizeAdornments(a)
		if a[0].LineStyle != want {
			t.Errorf("line_style %q: got %q, want %q", in, a[0].LineStyle, want)
		}
	}
}

func TestSanitizeAdornmentsClampsGeometry(t *testing.T) {
	// Negative origins and zero/negative extents would render inverted or
	// invisible boxes; clamp to a legal 1x1 at worst.
	a := []models.DashboardAdornment{{ID: "x", X: -5, Y: -2, W: 0, H: -3}}
	sanitizeAdornments(a)
	if a[0].X != 0 || a[0].Y != 0 {
		t.Errorf("origin not clamped: got (%d,%d), want (0,0)", a[0].X, a[0].Y)
	}
	if a[0].W != 1 || a[0].H != 1 {
		t.Errorf("extent not clamped: got %dx%d, want 1x1", a[0].W, a[0].H)
	}
}

func TestSanitizeAdornmentsDefaultsKind(t *testing.T) {
	// Kind is the discriminator for future adornment types; an empty one
	// must resolve to the only kind that exists rather than render nothing.
	a := []models.DashboardAdornment{{ID: "x"}}
	sanitizeAdornments(a)
	if a[0].Kind != models.AdornmentKindBorder {
		t.Errorf("kind: got %q, want %q", a[0].Kind, models.AdornmentKindBorder)
	}
}

func TestSanitizeAdornmentsWidthsDifferByKind(t *testing.T) {
	// Both kinds now allow odd widths (neither is centered), but the SETS
	// still differ: a gutter border may be 4px, a panel border may not.
	gutter := []models.DashboardAdornment{{ID: "g", Kind: models.AdornmentKindBorder, Width: 4}}
	sanitizeAdornments(gutter)
	if gutter[0].Width != 4 {
		t.Errorf("gutter border width 4: got %d, want 4 (legal)", gutter[0].Width)
	}

	for _, w := range []int{1, 2, 3} {
		panel := []models.DashboardAdornment{
			{ID: "p", Kind: models.AdornmentKindPanelBorder, PanelID: "panel-1", Width: w},
		}
		sanitizeAdornments(panel)
		if panel[0].Width != w {
			t.Errorf("panel border width %d was coerced to %d; odd widths are legal here", w, panel[0].Width)
		}
	}

	// 4 is legal for a gutter border but not a panel border, which caps at 3
	// so it can never reach the panel's content.
	tooWide := []models.DashboardAdornment{
		{ID: "p", Kind: models.AdornmentKindPanelBorder, PanelID: "panel-1", Width: 4},
	}
	sanitizeAdornments(tooWide)
	if tooWide[0].Width != 1 {
		t.Errorf("panel border width 4: got %d, want 1 (out of range)", tooWide[0].Width)
	}
}

func TestSanitizeAdornmentsClearsCrossKindFields(t *testing.T) {
	// A panel border's geometry comes from its panel, so a rect riding along
	// is stale data a future reader might trust.
	pb := []models.DashboardAdornment{
		{ID: "p", Kind: models.AdornmentKindPanelBorder, PanelID: "panel-1", X: 5, Y: 5, W: 3, H: 3},
	}
	sanitizeAdornments(pb)
	if pb[0].X != 0 || pb[0].Y != 0 || pb[0].W != 0 || pb[0].H != 0 {
		t.Errorf("panel border kept a rect: %+v", pb[0])
	}

	// Conversely a rect border has no panel to bind to.
	gb := []models.DashboardAdornment{
		{ID: "g", Kind: models.AdornmentKindBorder, PanelID: "panel-1", X: 1, Y: 1, W: 2, H: 2},
	}
	sanitizeAdornments(gb)
	if gb[0].PanelID != "" {
		t.Errorf("gutter border kept a panel_id: %q", gb[0].PanelID)
	}
	if gb[0].W != 2 || gb[0].H != 2 {
		t.Errorf("gutter border rect was clobbered: %+v", gb[0])
	}
}

func TestPruneOrphanAdornments(t *testing.T) {
	panels := []models.DashboardPanel{{ID: "panel-1"}, {ID: "panel-2"}}
	adornments := []models.DashboardAdornment{
		{ID: "a", Kind: models.AdornmentKindPanelBorder, PanelID: "panel-1"},
		{ID: "b", Kind: models.AdornmentKindPanelBorder, PanelID: "gone"},
		{ID: "c", Kind: models.AdornmentKindBorder, X: 1, Y: 1, W: 2, H: 2},
	}
	got := pruneOrphanAdornments(adornments, panels)

	if len(got) != 2 {
		t.Fatalf("expected 2 survivors, got %d: %+v", len(got), got)
	}
	for _, a := range got {
		if a.ID == "b" {
			t.Error("orphan panel_border 'b' survived the prune")
		}
	}
	// A rect border must never be pruned — it binds to no panel.
	if got[1].ID != "c" {
		t.Errorf("rect border was pruned or reordered: %+v", got)
	}
}

func TestPruneOrphanAdornmentsEmptyInputs(t *testing.T) {
	if got := pruneOrphanAdornments(nil, nil); got != nil {
		t.Errorf("nil adornments should stay nil, got %+v", got)
	}
	// Every panel_border is an orphan when there are no panels at all.
	all := []models.DashboardAdornment{
		{ID: "a", Kind: models.AdornmentKindPanelBorder, PanelID: "panel-1"},
	}
	if got := pruneOrphanAdornments(all, nil); len(got) != 0 {
		t.Errorf("expected all pruned with no panels, got %+v", got)
	}
}

func TestSanitizeAdornmentsHandlesEmptyAndNil(t *testing.T) {
	// Empty is the meaningful "user deleted the last border" state, and nil
	// is every dashboard that predates this feature. Neither may panic.
	sanitizeAdornments(nil)
	sanitizeAdornments([]models.DashboardAdornment{})
}
