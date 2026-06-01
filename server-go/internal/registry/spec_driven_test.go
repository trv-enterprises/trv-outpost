// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import "testing"

// IsSpecDrivenChart decides whether the server emits the
// <SpecDrivenChart> one-liner for a chart type. Every canonical chart
// type is spec-driven; "custom", unknown types, and the empty string are
// not. This guards the create/update/migration contract.
func TestIsSpecDrivenChart(t *testing.T) {
	specDriven := []string{"line", "bar", "area", "pie", "scatter", "gauge", "number", "dataview", "banded_bar"}
	for _, ct := range specDriven {
		if !IsSpecDrivenChart(ct) {
			t.Errorf("IsSpecDrivenChart(%q) = false, want true (canonical chart type)", ct)
		}
	}

	notSpecDriven := []string{"custom", "", "bogus", "toggle", "frigate"}
	for _, ct := range notSpecDriven {
		if IsSpecDrivenChart(ct) {
			t.Errorf("IsSpecDrivenChart(%q) = true, want false", ct)
		}
	}
}
