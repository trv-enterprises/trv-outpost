// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"sort"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// discoverSwapConnections is the single source of truth for resolving a
// connection_swap variable's targets — shared by the viewer dropdown
// (GetVariableCandidates) and export (BuildExport). It must narrow the repo's
// OR-tag result to AND semantics: a candidate must carry ALL the variable's
// (normalized) tags.
func TestDiscoverSwapConnections_ANDNarrowing(t *testing.T) {
	// connByTags stub: pretend the repo's $in query returned everything that
	// carries ANY of the requested tags. The AND narrowing happens in the
	// helper under test.
	pool := []*models.Connection{
		{ID: "both", Tags: []string{"system-stats", "ts-store"}},
		{ID: "onlystats", Tags: []string{"system-stats"}},
		{ID: "onlyts", Tags: []string{"ts-store"}},
		{ID: "superset", Tags: []string{"system-stats", "ts-store", "extra"}},
		{ID: "casey", Tags: []string{"System-Stats", "TS-Store"}}, // normalized → matches
	}
	s := &DashboardService{
		connByTags: func(_ context.Context, _ string, tags []string) ([]*models.Connection, error) {
			// OR match, mirroring the real repo.
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
		},
	}

	cfg := &models.ConnectionSwapConfig{Tags: []string{"system-stats", "ts-store"}}
	got, err := s.discoverSwapConnections(context.Background(), "default", cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	ids := make([]string, 0, len(got))
	for _, c := range got {
		ids = append(ids, c.ID)
	}
	sort.Strings(ids)
	want := []string{"both", "casey", "superset"} // all must carry BOTH tags
	if len(ids) != len(want) {
		t.Fatalf("AND narrowing: got %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("AND narrowing: got %v, want %v", ids, want)
		}
	}
}

// An empty tag set means "no discovery filter" — the helper returns whatever
// connByTags returned unfiltered (the repo layer decides that shape).
func TestDiscoverSwapConnections_NoTags(t *testing.T) {
	s := &DashboardService{
		connByTags: func(_ context.Context, _ string, _ []string) ([]*models.Connection, error) {
			return []*models.Connection{{ID: "x"}}, nil
		},
	}
	got, err := s.discoverSwapConnections(context.Background(), "default", &models.ConnectionSwapConfig{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].ID != "x" {
		t.Fatalf("no-tags passthrough: got %v", got)
	}
}

// SameNamespace routes the dashboard namespace into discovery; the default
// (false) passes an empty namespace (cross-namespace discovery).
func TestDiscoverSwapConnections_NamespaceRouting(t *testing.T) {
	var gotNS string
	s := &DashboardService{
		connByTags: func(_ context.Context, ns string, _ []string) ([]*models.Connection, error) {
			gotNS = ns
			return nil, nil
		},
	}
	// Default: cross-namespace → empty namespace passed.
	_, _ = s.discoverSwapConnections(context.Background(), "home", &models.ConnectionSwapConfig{Tags: []string{"a"}})
	if gotNS != "" {
		t.Fatalf("default discovery namespace: got %q, want empty", gotNS)
	}
	// SameNamespace: dashboard namespace passed through.
	_, _ = s.discoverSwapConnections(context.Background(), "home", &models.ConnectionSwapConfig{Tags: []string{"a"}, SameNamespace: true})
	if gotNS != "home" {
		t.Fatalf("same-namespace discovery: got %q, want %q", gotNS, "home")
	}
}

// A nil discovery helper (legacy/test construction without SetVariableHelpers)
// is a clean error, not a panic — export skips swap discovery in that case.
func TestDiscoverSwapConnections_Unwired(t *testing.T) {
	s := &DashboardService{}
	_, err := s.discoverSwapConnections(context.Background(), "default", &models.ConnectionSwapConfig{Tags: []string{"a"}})
	if err == nil {
		t.Fatal("expected an error when connByTags is unwired")
	}
}

// A discovery failure propagates (export must not silently ship a bundle
// missing swap targets because the query errored).
func TestDiscoverSwapConnections_QueryError(t *testing.T) {
	s := &DashboardService{
		connByTags: func(_ context.Context, _ string, _ []string) ([]*models.Connection, error) {
			return nil, errors.New("boom")
		},
	}
	_, err := s.discoverSwapConnections(context.Background(), "default", &models.ConnectionSwapConfig{Tags: []string{"a"}})
	if err == nil {
		t.Fatal("expected the discovery error to propagate")
	}
}
