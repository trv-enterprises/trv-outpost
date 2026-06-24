// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"encoding/json"
	"reflect"
	"testing"
)

// NormalizeYAxisColumns must accept the canonical []string plus the common LLM
// shape mistakes (object entries, a bare string) so a correct-intent component
// create/update isn't rejected over a y_axis shape nit.
func TestNormalizeYAxisColumns(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want []string
		ok   bool
	}{
		{"canonical_strings", `["temp","humidity"]`, []string{"temp", "humidity"}, true},
		{"single_string_array", `["temp"]`, []string{"temp"}, true},
		{"bare_string", `"temp"`, []string{"temp"}, true},
		{"object_column_key", `[{"column":"life_cycles"}]`, []string{"life_cycles"}, true},
		{"object_col_key", `[{"col":"x"}]`, []string{"x"}, true},
		{"object_name_key", `[{"name":"y"}]`, []string{"y"}, true},
		{"mixed_string_and_object", `["a",{"column":"b"}]`, []string{"a", "b"}, true},
		{"empty_array", `[]`, []string{}, true},
		{"number_not_a_shape", `42`, nil, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := NormalizeYAxisColumns(json.RawMessage(c.in))
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
			if c.ok && !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}

// The full ChartDataMapping decode must absorb the object y_axis shape (the
// exact "cannot unmarshal object into ... y_axis of type string" failure from
// the EdgeLake turbofan transcript) and still decode the rest of the struct.
func TestChartDataMappingUnmarshalToleratesObjectYAxis(t *testing.T) {
	raw := `{
		"x_axis": "cycle",
		"y_axis": [{"column":"life_cycles"}],
		"sort_by": "cycle",
		"limit": 100
	}`
	var dm ChartDataMapping
	if err := json.Unmarshal([]byte(raw), &dm); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(dm.YAxis, []string{"life_cycles"}) {
		t.Fatalf("y_axis = %#v, want [life_cycles]", dm.YAxis)
	}
	if dm.XAxis != "cycle" || dm.SortBy != "cycle" || dm.Limit != 100 {
		t.Fatalf("other fields not decoded: %+v", dm)
	}
}

// Canonical string arrays must still round-trip unchanged.
func TestChartDataMappingUnmarshalCanonicalYAxis(t *testing.T) {
	raw := `{"y_axis":["cpu","mem"]}`
	var dm ChartDataMapping
	if err := json.Unmarshal([]byte(raw), &dm); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !reflect.DeepEqual(dm.YAxis, []string{"cpu", "mem"}) {
		t.Fatalf("y_axis = %#v, want [cpu mem]", dm.YAxis)
	}
}
