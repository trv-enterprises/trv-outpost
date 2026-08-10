// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// orMatchStub mirrors the real repo's $in behavior: return every connection
// carrying ANY of the requested tags. AND narrowing happens in
// discoverSwapConnections, which resolveSwapFamilies calls per family.
func orMatchStub(pool []*models.Connection) func(context.Context, string, []string) ([]*models.Connection, error) {
	return func(_ context.Context, _ string, tags []string) ([]*models.Connection, error) {
		want := map[string]struct{}{}
		for _, t := range models.NormalizeTags(tags) {
			want[t] = struct{}{}
		}
		var out []*models.Connection
		for _, c := range pool {
			for _, ct := range models.NormalizeTags(c.Tags) {
				if _, ok := want[ct]; ok {
					out = append(out, c)
					break
				}
			}
		}
		return out, nil
	}
}

// resolveSwapFamilies drives BOTH the tag-value picker (distinct key values,
// annotated with family coverage) and the panel-tags modal's resolution
// preview (per-family value → connection). This test exercises the whole
// surface: family enumeration + dedupe, per-value resolution, the sparse
// family, ambiguity, and connections lacking the key tag.
func TestResolveSwapFamilies(t *testing.T) {
	// Tag convention mirrors the real deployment: every connection carries
	// the variable's GATE tag (docker-stats) plus its specific family tag
	// (docker-daemon / docker-containers) — panel tags EXTEND the gate,
	// they don't replace it.
	pool := []*models.Connection{
		{ID: "s1", Name: "daemon-001", Tags: []string{"docker-stats", "docker-daemon", "host:trv-srv-001"}},
		{ID: "s2", Name: "daemon-002", Tags: []string{"docker-stats", "docker-daemon", "host:trv-srv-002"}},
		{ID: "s3", Name: "daemon-003", Tags: []string{"docker-stats", "docker-daemon", "host:trv-srv-003"}},
		{ID: "d1", Name: "cont-001", Tags: []string{"docker-stats", "docker-containers", "host:trv-srv-001"}},
		// Two container connections for host 002 — the ambiguity case. Names
		// chosen so first-by-name is deterministic and testable.
		{ID: "d2a", Name: "cont-002-a", Tags: []string{"docker-stats", "docker-containers", "host:trv-srv-002"}},
		{ID: "d2z", Name: "cont-002-z", Tags: []string{"docker-stats", "docker-containers", "host:trv-srv-002"}},
		// No container connection for host 003 — the sparse family case.
		// A connection with no key tag is not selectable in this mode.
		{ID: "nokey", Name: "daemon-nokey", Tags: []string{"docker-stats", "docker-daemon"}},
		// THE GATE: carries the family extension tag + a key tag but NOT the
		// variable's gate tag (a NAS connection with docker-stats removed).
		// Union semantics must exclude it from the containers family even
		// though it matches the panel's own tags — the variable tag admits
		// a connection at all; the panel tags only narrow within that.
		{ID: "nas", Name: "nas-cont", Tags: []string{"docker-containers", "host:nas-syn-002"}},
	}
	s := &DashboardService{connByTags: orMatchStub(pool)}

	dashboard := &models.Dashboard{
		Namespace: "default",
		Panels: []models.DashboardPanel{
			{ID: "p1"}, // primary family (no tags)
			{ID: "p2", ConnectionTags: []string{"docker-containers"}},
			// Same family as p2 after normalization — must dedupe into one
			// family entry carrying both panel ids.
			{ID: "p3", ConnectionTags: []string{"Docker-Containers"}},
		},
	}
	cfg := &models.ConnectionSwapConfig{
		Tags:           []string{"docker-stats"},
		Selection:      models.SwapSelectionTagValue,
		LabelTagPrefix: "host",
	}

	values, families, err := s.resolveSwapFamilies(context.Background(), dashboard, cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// ── Families ────────────────────────────────────────────────────
	if len(families) != 2 {
		t.Fatalf("expected 2 families (primary + containers), got %d", len(families))
	}
	prim, dock := families[0], families[1]
	if !prim.Primary {
		t.Error("first family should be the primary")
	}
	if dock.Primary {
		t.Error("override family must not be marked primary")
	}
	if len(dock.PanelIDs) != 2 {
		t.Errorf("containers family should carry both p2 and p3, got %v", dock.PanelIDs)
	}
	// Union semantics: the family's effective tags include the GATE tag.
	{
		found := false
		for _, tg := range dock.Tags {
			if tg == "docker-stats" {
				found = true
			}
		}
		if !found {
			t.Errorf("containers family tags must include the variable's gate tag, got %v", dock.Tags)
		}
	}

	resolved := func(f models.SwapFamily, value string) *models.SwapResolution {
		for i := range f.Resolutions {
			if f.Resolutions[i].Value == value {
				return &f.Resolutions[i]
			}
		}
		return nil
	}

	// Primary family = the GATE tag alone, which under the umbrella-tag
	// convention matches BOTH sub-families' connections — so wherever both
	// exist for a host, the primary resolution is AMBIGUOUS (flagged, first
	// by name). This is the honest consequence of gate+extension semantics:
	// a panel with no panel-tags is asking for "any docker-stats connection
	// on this host". Authors should tag every data panel (or make the
	// variable's own tags pin one sub-family).
	if r := resolved(prim, "trv-srv-001"); r == nil || r.ConnectionID != "d1" || !r.Ambiguous {
		t.Errorf("primary 001: got %+v, want d1 (cont-001, first by name) flagged ambiguous", r)
	}
	if r := resolved(prim, "trv-srv-002"); r == nil || r.ConnectionID != "d2a" || !r.Ambiguous {
		t.Errorf("primary 002: got %+v, want d2a flagged ambiguous", r)
	}
	// Host 003 has only the daemon connection → unambiguous.
	if r := resolved(prim, "trv-srv-003"); r == nil || r.ConnectionID != "s3" || r.Ambiguous {
		t.Errorf("primary 003: got %+v, want s3 unambiguous", r)
	}

	// Containers family: 001 resolves plainly; 002 is ambiguous with the
	// first-by-name pick; 003 is absent (sparse), NOT an entry with empty id.
	if r := resolved(dock, "trv-srv-001"); r == nil || r.ConnectionID != "d1" || r.Ambiguous {
		t.Errorf("containers 001: got %+v, want d1 unambiguous", r)
	}
	if r := resolved(dock, "trv-srv-002"); r == nil || r.ConnectionID != "d2a" || !r.Ambiguous {
		t.Errorf("containers 002: got %+v, want d2a with Ambiguous=true (first by name)", r)
	}
	if r := resolved(dock, "trv-srv-003"); r != nil {
		t.Errorf("containers 003: expected no entry (sparse family), got %+v", r)
	}
	// The GATE: nas-cont matches the panel tags + carries a key tag, but
	// lacks the variable's gate tag — it must resolve NOWHERE.
	if r := resolved(dock, "nas-syn-002"); r != nil {
		t.Errorf("gate: nas-cont (no docker-stats tag) must not resolve, got %+v", r)
	}
	for _, v := range values {
		if v.Value == "nas-syn-002" {
			t.Errorf("gate: nas-syn-002 must not be a selectable value, got %+v", v)
		}
	}

	// ── Values ──────────────────────────────────────────────────────
	// Sorted union, annotated with coverage: 001 and 002 resolve in both
	// families, 003 only in the primary.
	wantValues := []models.SwapTagValue{
		{Value: "trv-srv-001", FamiliesTotal: 2, FamiliesMatched: 2},
		{Value: "trv-srv-002", FamiliesTotal: 2, FamiliesMatched: 2},
		{Value: "trv-srv-003", FamiliesTotal: 2, FamiliesMatched: 1},
	}
	if len(values) != len(wantValues) {
		t.Fatalf("expected %d values, got %d: %+v", len(wantValues), len(values), values)
	}
	for i, want := range wantValues {
		if values[i] != want {
			t.Errorf("values[%d]: got %+v, want %+v", i, values[i], want)
		}
	}
}

func TestTagPrefixValue(t *testing.T) {
	tests := []struct {
		name   string
		tags   []string
		prefix string
		want   string
	}{
		{"plain match", []string{"synology", "host:trv-srv-001"}, "host", "trv-srv-001"},
		{"case-insensitive prefix", []string{"Host:TRV-SRV-001"}, "host", "TRV-SRV-001"},
		{"no key tag", []string{"synology"}, "host", ""},
		{"empty prefix never matches", []string{"host:x"}, "", ""},
		{"prefix-only tag has no value", []string{"host:"}, "host", ""},
		{"first matching tag wins", []string{"host:a", "host:b"}, "host", "a"},
		{"whitespace tolerated", []string{"  host:trv-srv-002  "}, "host", "trv-srv-002"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := tagPrefixValue(tt.tags, tt.prefix); got != tt.want {
				t.Errorf("tagPrefixValue(%v, %q) = %q, want %q", tt.tags, tt.prefix, got, tt.want)
			}
		})
	}
}
