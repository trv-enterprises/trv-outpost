// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// An old bundle must land as a current-shaped record: the retired
// `number` chart type becomes `value` and the five `options.number*`
// keys become `options.value*`. This has to agree with the boot
// migration (database/migrations.go migrateNumberChartToValue) — if the
// two drift, a re-export of an imported bundle diffs against its source.
func TestNormalizeRetiredChartTypes(t *testing.T) {
	var b models.ExportBundle
	b.Objects.Components = []models.Component{
		{ID: "all-keys", ChartType: "number", Options: map[string]interface{}{
			"numberFormat": "compact", "numberDateFormat": "date", "numberDecimals": "2",
			"numberUnit": "%", "numberSize": 80, "showTitle": true,
		}},
		{ID: "nil-options", ChartType: "number", Options: nil},
		{ID: "already-current", ChartType: "value", Options: map[string]interface{}{"valueSize": 64}},
		{ID: "other-type", ChartType: "line", Options: map[string]interface{}{"chartSmooth": true}},
		{ID: "both-spellings", ChartType: "number", Options: map[string]interface{}{
			"numberUnit": "OLD", "valueUnit": "NEW",
		}},
	}

	normalizeRetiredChartTypes(&b)

	for _, c := range b.Objects.Components {
		if c.ID == "other-type" {
			if c.ChartType != "line" {
				t.Errorf("%s: chart_type changed to %q", c.ID, c.ChartType)
			}
			continue
		}
		if c.ChartType != "value" {
			t.Errorf("%s: chart_type = %q, want value", c.ID, c.ChartType)
		}
		for old := range registry.RetiredChartOptionKeys {
			if _, ok := c.Options[old]; ok {
				t.Errorf("%s: retired key %q survived normalization", c.ID, old)
			}
		}
	}

	all := b.Objects.Components[0].Options
	for _, want := range []struct{ key, val string }{
		{"valueFormat", "compact"}, {"valueDateFormat", "date"}, {"valueDecimals", "2"}, {"valueUnit", "%"},
	} {
		if got := all[want.key]; got != want.val {
			t.Errorf("all-keys: %s = %v, want %q", want.key, got, want.val)
		}
	}
	if got := all["valueSize"]; got != 80 {
		t.Errorf("all-keys: valueSize = %v, want 80", got)
	}
	// Unrelated option keys must survive untouched.
	if got := all["showTitle"]; got != true {
		t.Errorf("all-keys: showTitle = %v, want true", got)
	}

	// A bundle carrying BOTH spellings is already current-shaped: the new
	// key wins and the retired one is dropped rather than clobbering it.
	if got := b.Objects.Components[4].Options["valueUnit"]; got != "NEW" {
		t.Errorf("both-spellings: valueUnit = %v, want NEW", got)
	}
}
