// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package componenttemplates

import (
	"strings"
	"testing"
)

// The one-liner the server emits on create must match what the React
// editor emits on save: a single component that defers to
// <SpecDrivenChart> with the chart type pinned as specName. If this
// shape drifts, agent-built charts stop matching editor-built ones.
func TestSpecDrivenOneLiner(t *testing.T) {
	got := SpecDrivenOneLiner("line")

	if !strings.Contains(got, "SpecDrivenChart") {
		t.Errorf("one-liner must reference SpecDrivenChart, got: %q", got)
	}
	if !strings.Contains(got, `specName="line"`) {
		t.Errorf("one-liner must pin specName to the chart type, got: %q", got)
	}
	// Must NOT carry hardcoded column names — that was the regression.
	for _, banned := range []string{"toObjects", "ReactECharts", "'day'", "'mean'", "'timestamp'", "'value'"} {
		if strings.Contains(got, banned) {
			t.Errorf("one-liner must not contain legacy template artifact %q, got: %q", banned, got)
		}
	}
}

// specName must be the exact chart_type passed in, so a banded_bar gets
// specName="banded_bar" (not a default).
func TestSpecDrivenOneLinerUsesChartType(t *testing.T) {
	for _, ct := range []string{"bar", "area", "pie", "scatter", "gauge", "number", "dataview", "banded_bar"} {
		got := SpecDrivenOneLiner(ct)
		want := `specName="` + ct + `"`
		if !strings.Contains(got, want) {
			t.Errorf("SpecDrivenOneLiner(%q): expected %q in output, got: %q", ct, want, got)
		}
	}
}
