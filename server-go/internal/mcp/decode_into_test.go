// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// decodeInto replaced the hand-rolled parse* helpers that silently dropped
// model fields (issue #54). These tests assert the previously-dropped fields
// now round-trip from a JSON-RPC-shaped arg map into the model struct.

func TestDecodeIntoDataMappingFieldComplete(t *testing.T) {
	// Mirror what the JSON-RPC decoder produces: JSON-native types
	// (float64 numbers, string, bool, []interface{}, map[string]interface{}).
	dm := map[string]interface{}{
		"x_axis":        "ts",
		"x_axis_format": "chart_time",
		"y_axis":        []interface{}{"cpu", "mem"},
		"y_axis_labels": []interface{}{"CPU %", "Mem %"},
		"y_axis_colors": []interface{}{"7", "purple70"},
		"series":        "host",
		"multiple_y_axis": true,
		"sliding_window": map[string]interface{}{
			"duration": float64(3600), "timestamp_col": "ts",
		},
		"time_bucket": map[string]interface{}{
			"interval": float64(60), "function": "avg",
			"value_cols": []interface{}{"cpu"}, "timestamp_col": "ts",
		},
		"band_columns": map[string]interface{}{
			"scheme": "sd", "mean": "m",
			"plus_1sd": "p1", "minus_1sd": "n1",
		},
		"limit": float64(500),
	}

	var got models.ChartDataMapping
	if err := decodeInto(dm, &got); err != nil {
		t.Fatalf("decodeInto: %v", err)
	}

	if got.XAxisFormat != "chart_time" {
		t.Errorf("x_axis_format dropped: %q", got.XAxisFormat)
	}
	if len(got.YAxisColors) != 2 || got.YAxisColors[0] != "7" {
		t.Errorf("y_axis_colors dropped/wrong: %#v", got.YAxisColors)
	}
	if got.Series != "host" {
		t.Errorf("series dropped: %q", got.Series)
	}
	if got.SlidingWindow == nil || got.SlidingWindow.Duration != 3600 {
		t.Errorf("sliding_window dropped/wrong: %#v", got.SlidingWindow)
	}
	if got.TimeBucket == nil || got.TimeBucket.Interval != 60 || got.TimeBucket.Function != "avg" {
		t.Errorf("time_bucket dropped/wrong: %#v", got.TimeBucket)
	}
	if got.BandColumns == nil || got.BandColumns.Scheme != "sd" || got.BandColumns.Mean != "m" || got.BandColumns.Plus1SD != "p1" {
		t.Errorf("band_columns dropped/wrong: %#v", got.BandColumns)
	}
	if got.Limit != 500 {
		t.Errorf("limit dropped/wrong: %d", got.Limit)
	}
}

func TestDecodeIntoDashboardSettingsFieldComplete(t *testing.T) {
	settings := map[string]interface{}{
		"theme":             "g100",
		"refresh_interval":  float64(5000),
		"layout_dimension":  "2560x1440-2K",
		"title_scale":       float64(120),
		"scale_percent":     float64(150),
		"variables_enabled": true,
		"variables": []interface{}{
			map[string]interface{}{
				"name": "dashboard-range", "label": "Time", "mode": "range",
				"range": map[string]interface{}{
					"presets": []interface{}{"1h", "24h"}, "default_preset": "24h",
				},
			},
		},
	}

	var got models.DashboardSettings
	if err := decodeInto(settings, &got); err != nil {
		t.Fatalf("decodeInto: %v", err)
	}

	if got.LayoutDimension != "2560x1440-2K" {
		t.Errorf("layout_dimension dropped: %q", got.LayoutDimension)
	}
	if got.TitleScale != 120 || got.ScalePercent != 150 {
		t.Errorf("title_scale/scale_percent dropped: %d / %d", got.TitleScale, got.ScalePercent)
	}
	if !got.VariablesEnabled {
		t.Error("variables_enabled dropped")
	}
	if len(got.Variables) != 1 || got.Variables[0].Mode != "range" || got.Variables[0].Range == nil {
		t.Fatalf("variables dropped/wrong: %#v", got.Variables)
	}
	if got.Variables[0].Range.DefaultPreset != "24h" || len(got.Variables[0].Range.Presets) != 2 {
		t.Errorf("range config wrong: %#v", got.Variables[0].Range)
	}
}

func TestDecodeIntoPanelsFieldComplete(t *testing.T) {
	panels := []interface{}{
		map[string]interface{}{
			"id": "p1", "x": float64(0), "y": float64(0), "w": float64(10), "h": float64(6),
			"component_id": "c1",
		},
		map[string]interface{}{
			"id": "p2", "x": float64(10), "y": float64(0), "w": float64(10), "h": float64(2),
			"text_config": map[string]interface{}{
				"content": "Header", "display_content": "title", "align": "center",
			},
		},
	}

	var got []models.DashboardPanel
	if err := decodeInto(panels, &got); err != nil {
		t.Fatalf("decodeInto: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 panels, got %d", len(got))
	}
	if got[0].ComponentID != "c1" || got[0].W != 10 {
		t.Errorf("panel 0 wrong: %#v", got[0])
	}
	if got[1].TextConfig == nil || got[1].TextConfig.Content != "Header" {
		t.Errorf("panel 1 text_config dropped/wrong: %#v", got[1].TextConfig)
	}
}
