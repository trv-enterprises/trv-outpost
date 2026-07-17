// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"net/url"
	"testing"
	"time"
)

// TestClampTSStoreStep covers the budget guard. ts-store enforces NO server-side
// point cap (unlike Prometheus), so this clamp is the only thing between a fine
// step over a wide window and a 100k-row pull.
func TestClampTSStoreStep(t *testing.T) {
	tests := []struct {
		name   string
		step   string
		window time.Duration
		want   string
	}{
		// Under budget → returned untouched.
		{"1h window, 15s step", "15s", time.Hour, "15s"},              // 240 pts
		{"24h window, 30s step", "30s", 24 * time.Hour, "30s"},        // 2,880 pts
		{"24h window, 1m step", "1m", 24 * time.Hour, "1m"},           // 1,440 pts
		{"7d window, 5m step", "5m", 7 * 24 * time.Hour, "5m"},        // 2,016 pts
		{"30d window, 15m step", "15m", 30 * 24 * time.Hour, "15m"},   // 2,880 pts
		{"exactly at budget", "1s", 5000 * time.Second, "1s"},         // 5,000 pts

		// Over budget → raised to the smallest whole-second step that fits.
		{"24h window, 15s step", "15s", 24 * time.Hour, "18s"},        // 5,760 → 17.28s, rounds up
		{"7d window, 15s step", "15s", 7 * 24 * time.Hour, "121s"},    // 40,320 pts
		{"30d window, 15s step", "15s", 30 * 24 * time.Hour, "519s"},  // 172,800 pts
		{"30d window, 1m step", "1m", 30 * 24 * time.Hour, "519s"},    // 43,200 pts
		{"one over budget", "1s", 5001 * time.Second, "2s"},

		// Degenerate input → returned unchanged rather than guessed at.
		{"empty step", "", 24 * time.Hour, ""},
		{"whitespace step", "   ", 24 * time.Hour, "   "},
		{"unparseable step", "banana", 24 * time.Hour, "banana"},
		{"zero window", "15s", 0, "15s"},
		{"negative window", "15s", -time.Hour, "15s"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := clampTSStoreStep(tc.step, tc.window); got != tc.want {
				t.Errorf("clampTSStoreStep(%q, %v) = %q, want %q", tc.step, tc.window, got, tc.want)
			}
		})
	}
}

// TestClampTSStoreStepNeverLowers asserts the clamp is a FLOOR: a coarse step is
// never silently made finer (which would multiply points rather than reduce them).
func TestClampTSStoreStepNeverLowers(t *testing.T) {
	for _, step := range []string{"1m", "5m", "15m", "1h"} {
		got := clampTSStoreStep(step, time.Hour)
		if got != step {
			t.Errorf("clampTSStoreStep(%q, 1h) = %q — a fitting step must be returned unchanged", step, got)
		}
	}
}

// TestTSStoreRangeFromSpecStep covers step resolution + clamping through the
// spec mapper, for both relative and absolute intents.
func TestTSStoreRangeFromSpecStep(t *testing.T) {
	t.Run("relative carries step through", func(t *testing.T) {
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "relative", Token: "1h", Step: "1m"})
		if !ok {
			t.Fatal("expected ok")
		}
		if !tr.Relative || tr.Since != "1h" {
			t.Fatalf("got %+v, want Relative=true Since=1h", tr)
		}
		if tr.Step != "1m" {
			t.Errorf("Step = %q, want 1m", tr.Step)
		}
	})

	t.Run("relative clamps an over-fine step", func(t *testing.T) {
		// 30d @ 15s = 172,800 points, far over the 5,000 budget.
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "relative", Token: "30d", Step: "15s"})
		if !ok {
			t.Fatal("expected ok")
		}
		if tr.Step == "15s" {
			t.Error("Step was not clamped — a 30d/15s window would request 172,800 points")
		}
		if tr.Step != "519s" {
			t.Errorf("Step = %q, want 519s", tr.Step)
		}
	})

	t.Run("absolute clamps against the real window", func(t *testing.T) {
		from := "2026-01-01T00:00:00Z"
		to := "2026-01-31T00:00:00Z" // 30 days
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "absolute", From: from, To: to, Step: "15s"})
		if !ok {
			t.Fatal("expected ok")
		}
		if tr.Relative {
			t.Error("absolute intent must not be Relative")
		}
		if tr.Step == "15s" {
			t.Error("Step was not clamped on the absolute path")
		}
	})

	t.Run("no step stays empty", func(t *testing.T) {
		tr, ok := tsstoreRangeFromSpec(RangeSpec{Type: "relative", Token: "1h"})
		if !ok {
			t.Fatal("expected ok")
		}
		if tr.Step != "" {
			t.Errorf("Step = %q, want empty (no step requested → raw records)", tr.Step)
		}
	})

	t.Run("unparseable relative token still yields no step", func(t *testing.T) {
		if _, ok := tsstoreRangeFromSpec(RangeSpec{Type: "relative", Token: "banana", Step: "1m"}); ok {
			t.Error("expected ok=false for an unparseable token")
		}
	})
}

// TestSetStepParam covers the wire-level guard. ts-store 400s on a request
// carrying both step and agg_window ("set either step or agg_window, not both").
func TestSetStepParam(t *testing.T) {
	t.Run("sets step", func(t *testing.T) {
		p := url.Values{}
		setStepParam(p, "1m")
		if p.Get("step") != "1m" {
			t.Errorf("step = %q, want 1m", p.Get("step"))
		}
	})

	t.Run("empty step is a no-op", func(t *testing.T) {
		p := url.Values{}
		setStepParam(p, "")
		if _, present := p["step"]; present {
			t.Error("empty step must not emit a step param")
		}
	})

	t.Run("never combines with agg_window", func(t *testing.T) {
		p := url.Values{}
		p.Set("agg_window", "5m")
		setStepParam(p, "1m")
		if p.Get("step") != "" {
			t.Error("step must not be set alongside agg_window — ts-store would 400")
		}
		if p.Get("agg_window") != "5m" {
			t.Error("existing agg_window must be preserved")
		}
	})
}
