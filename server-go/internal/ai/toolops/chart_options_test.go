package toolops

import "testing"

func TestApplyChartOptions(t *testing.T) {
	// Known keys copied; unknown dropped; count returned.
	dst := map[string]interface{}{"existing": 1}
	patch := map[string]interface{}{
		"yThresholds":          []interface{}{map[string]interface{}{"value": 70, "color": "#f1c21b"}},
		"yThresholdRenderMode": "color_segments",
		"chartSmooth":          true,
		"bogusKey":             "should-not-land", // unknown → dropped
		"showLegend":           true,              // legacy dead key → dropped (not in ChartOptionKeys)
	}
	n := ApplyChartOptions(dst, patch)
	if n != 3 {
		t.Fatalf("applied=%d want 3", n)
	}
	if _, ok := dst["bogusKey"]; ok {
		t.Error("unknown key leaked into options")
	}
	if _, ok := dst["showLegend"]; ok {
		t.Error("legacy dead key showLegend should not be applied")
	}
	if dst["existing"] != 1 {
		t.Error("merge clobbered pre-existing key")
	}
	if dst["yThresholdRenderMode"] != "color_segments" {
		t.Error("yThresholdRenderMode not applied")
	}
	// nil/empty guards
	if ApplyChartOptions(nil, patch) != 0 {
		t.Error("nil dst should apply 0")
	}
	if ApplyChartOptions(dst, nil) != 0 {
		t.Error("nil patch should apply 0")
	}
}

func TestChartOptionsSchemaKeysMatchApplyAllowlist(t *testing.T) {
	// Guard: every property the schema advertises must be in
	// ChartOptionKeys, else the agent could set a field the apply
	// silently drops (the exact dead-write bug this layer fixes).
	props := ChartOptionsSchema()["properties"].(map[string]interface{})
	for k := range props {
		if _, ok := ChartOptionKeys[k]; !ok {
			t.Errorf("schema advertises %q but ApplyChartOptions allowlist drops it", k)
		}
	}
	for k := range ChartOptionKeys {
		if _, ok := props[k]; !ok {
			t.Errorf("allowlist has %q but schema doesn't advertise it", k)
		}
	}
}
