// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"context"
	"testing"
)

// computeCells must match the viewer's fit math in
// client/src/pages/DashboardViewerPage.jsx — if these diverge the
// chat agent will plan dashboards that look right on paper but don't
// fit at render time. The canonical sizes here are pulled from
// CLAUDE.md's Grid System section.
func TestComputeCells_CanonicalSizes(t *testing.T) {
	cases := []struct {
		name             string
		maxW, maxH       int
		wantCols, wantRs int
	}{
		// Rows reflect the 57px vertical chrome (toolbar only — no app
		// header in the displayed dashboard). Each is +1 vs the old 109px
		// (header+toolbar) budget.
		{"2K", 2560, 1440, 71, 38},
		{"4K", 3840, 2160, 106, 58},
		{"1080p", 1920, 1080, 53, 28},
		{"KIOSK", 1366, 768, 37, 19},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cols, rows := computeCells(tc.maxW, tc.maxH)
			if cols != tc.wantCols || rows != tc.wantRs {
				t.Errorf("%s: got (%d×%d) want (%d×%d)", tc.name, cols, rows, tc.wantCols, tc.wantRs)
			}
		})
	}
}

// stubLister is a deterministic LayoutDimensionLister for testing the
// catalog build path without touching ConfigService.
type stubLister struct {
	entries []LayoutDimensionEntry
	def     string
}

func (s *stubLister) ListLayoutDimensionsForCatalog(ctx context.Context) ([]LayoutDimensionEntry, string, error) {
	return s.entries, s.def, nil
}

func TestBuildCatalogWithLayout_SortsByWidth(t *testing.T) {
	lister := &stubLister{
		entries: []LayoutDimensionEntry{
			{Name: "4K", MaxWidth: 3840, MaxHeight: 2160},
			{Name: "HD", MaxWidth: 1920, MaxHeight: 1080},
			{Name: "2K", MaxWidth: 2560, MaxHeight: 1440},
		},
		def: "2K",
	}
	cat, err := BuildCatalogWithLayout(context.Background(), nil, lister, nil)
	if err != nil {
		t.Fatalf("BuildCatalogWithLayout: %v", err)
	}
	if len(cat.LayoutDimensions) != 3 {
		t.Fatalf("want 3 dims, got %d", len(cat.LayoutDimensions))
	}
	// Sorted by width: HD, 2K, 4K
	if got := []string{cat.LayoutDimensions[0].Name, cat.LayoutDimensions[1].Name, cat.LayoutDimensions[2].Name}; got[0] != "HD" || got[1] != "2K" || got[2] != "4K" {
		t.Errorf("want HD,2K,4K got %v", got)
	}
	// Default flag lands on the named default
	if !cat.LayoutDimensions[1].IsDefault {
		t.Errorf("2K should be flagged IsDefault")
	}
	if cat.LayoutDimensions[0].IsDefault || cat.LayoutDimensions[2].IsDefault {
		t.Errorf("only the named default should have IsDefault=true")
	}
	// Cell counts attached (2K = 71×38 with the 57px toolbar chrome)
	if cat.LayoutDimensions[1].Cols != 71 || cat.LayoutDimensions[1].Rows != 38 {
		t.Errorf("2K cells: got %d×%d want 71×38", cat.LayoutDimensions[1].Cols, cat.LayoutDimensions[1].Rows)
	}
}

func TestBuildCatalog_NoLister_OmitsDimensions(t *testing.T) {
	cat, err := BuildCatalog(context.Background(), nil, nil)
	if err != nil {
		t.Fatalf("BuildCatalog: %v", err)
	}
	if cat.LayoutDimensions != nil {
		t.Errorf("expected nil LayoutDimensions without lister, got %v", cat.LayoutDimensions)
	}
}
