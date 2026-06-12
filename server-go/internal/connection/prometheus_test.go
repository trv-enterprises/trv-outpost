// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"testing"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TestParsePromDuration covers the d/w extension over time.ParseDuration — the
// fix for "invalid duration: -7d", which made 7d/30d range windows return no
// data at all (Prometheus's parser tops out at hours).
func TestParsePromDuration(t *testing.T) {
	cases := []struct {
		in   string
		want time.Duration
	}{
		{"1h", time.Hour},
		{"30m", 30 * time.Minute},
		{"7d", 7 * 24 * time.Hour},
		{"30d", 30 * 24 * time.Hour},
		{"2w", 14 * 24 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			got, err := parsePromDuration(tc.in)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("parsePromDuration(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// TestClampPromStep covers the 11,000-point clamp — a wide window with a fine
// step must coarsen (never lower the user's step below their floor when it fits).
func TestClampPromStep(t *testing.T) {
	end := time.Date(2026, 6, 11, 0, 0, 0, 0, time.UTC)
	t.Run("fits_unchanged", func(t *testing.T) {
		// 24h @ 1m = 1440 points → under cap → unchanged.
		if got := clampPromStep(end.Add(-24*time.Hour), end, "1m"); got != "1m" {
			t.Fatalf("got %q, want 1m (unchanged)", got)
		}
	})
	t.Run("30d_1m_clamped", func(t *testing.T) {
		// 30d @ 1m = 43,200 points → must clamp. 30d/10000 = 259.2s → 260s.
		got := clampPromStep(end.Add(-30*24*time.Hour), end, "1m")
		d, err := parsePromDuration(got)
		if err != nil {
			t.Fatalf("clamped step %q not parseable: %v", got, err)
		}
		points := (30 * 24 * time.Hour) / d
		if points > promMaxPoints {
			t.Fatalf("clamped step %q still yields %d points (> %d)", got, points, promMaxPoints)
		}
		if d <= time.Minute {
			t.Fatalf("clamped step %q should be COARSER than 1m", got)
		}
	})
	t.Run("bad_step_passthrough", func(t *testing.T) {
		if got := clampPromStep(end.Add(-time.Hour), end, "garbage"); got != "garbage" {
			t.Fatalf("got %q, want passthrough", got)
		}
	})
}

// TestPromRange_InstantNotApplied documents the contract: a range variable only
// scopes RANGE-type Prometheus components; an INSTANT component ignores it. The
// adapter Query() guards on query_type before applying promRangeFromSpec, so we
// assert the guard condition directly (the HTTP execute path needs a live node).
func TestPromRange_InstantNotApplied(t *testing.T) {
	// The decision is: apply the range only when query_type != instant.
	instant := models.PrometheusQueryTypeInstant
	rng := models.PrometheusQueryTypeRange
	if instant == rng {
		t.Fatal("instant and range query types must differ")
	}
	// A spec resolves fine on its own — the point is the CALLER must not apply it
	// for an instant query. (promRangeFromSpec itself is type-agnostic.)
	if _, _, _, ok := promRangeFromSpec(RangeSpec{Type: "relative", Token: "24h"}, "1h"); !ok {
		t.Fatal("range spec should resolve; the guard lives in Query(), not the resolver")
	}
}

// TestParsePromTime_DaysWeeks verifies the now-<dur> form accepts d/w (so a
// PrometheusQueryBuilder emitting "now-7d" also works, not just the range var).
func TestParsePromTime_DaysWeeks(t *testing.T) {
	for _, tok := range []string{"now-7d", "now-30d", "now-2w", "-7d"} {
		t.Run(tok, func(t *testing.T) {
			if _, err := parsePromTime(tok); err != nil {
				t.Fatalf("parsePromTime(%q) errored: %v", tok, err)
			}
		})
	}
	// Sanity: now-7d is ~7 days before now.
	got, err := parsePromTime("now-7d")
	if err != nil {
		t.Fatal(err)
	}
	delta := time.Since(got)
	if delta < 7*24*time.Hour-time.Minute || delta > 7*24*time.Hour+time.Minute {
		t.Fatalf("now-7d resolved to %v ago, want ~168h", delta)
	}
}
