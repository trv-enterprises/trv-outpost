// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"reflect"
	"testing"
)

// Pins the column-name → positional translation for per-series unit
// conversions (#265). The component-editor agent addresses series by column
// NAME (it doesn't reliably know positions); the renderer reads a parallel
// array index-aligned to y_axis. A mistranslation here is invisible in review
// and shows up as a chart converting the WRONG series.
func TestConversionsByColumn(t *testing.T) {
	c2f := map[string]interface{}{"dimension": "temperature", "from": "c", "to": "f"}
	psi := map[string]interface{}{"dimension": "pressure", "from": "pa", "to": "psi"}

	tests := []struct {
		name  string
		want  map[string]map[string]interface{}
		yAxis []string
		out   []map[string]interface{}
	}{
		{
			name:  "converts only the named column, at its own index",
			want:  map[string]map[string]interface{}{"temp_c": c2f},
			yAxis: []string{"humidity", "temp_c", "pressure"},
			out:   []map[string]interface{}{nil, c2f, nil},
		},
		{
			name:  "multiple columns each land on their own index",
			want:  map[string]map[string]interface{}{"temp_c": c2f, "pressure": psi},
			yAxis: []string{"temp_c", "humidity", "pressure"},
			out:   []map[string]interface{}{c2f, nil, psi},
		},
		{
			name:  "empty map clears every conversion",
			want:  map[string]map[string]interface{}{},
			yAxis: []string{"temp_c", "humidity"},
			out:   nil,
		},
		{
			name:  "a column not on the chart is ignored, not appended",
			want:  map[string]map[string]interface{}{"not_a_column": c2f},
			yAxis: []string{"temp_c"},
			out:   nil,
		},
		{
			name:  "an empty descriptor is treated as no conversion",
			want:  map[string]map[string]interface{}{"temp_c": {}},
			yAxis: []string{"temp_c"},
			out:   nil,
		},
		{
			name:  "no y columns yields nil, not an empty slice",
			want:  map[string]map[string]interface{}{"temp_c": c2f},
			yAxis: nil,
			out:   nil,
		},
		{
			name:  "descriptor passes through uninterpreted (custom affine)",
			want:  map[string]map[string]interface{}{"ratio": {"dimension": "custom", "scale": 100.0, "symbol": "%"}},
			yAxis: []string{"ratio"},
			out:   []map[string]interface{}{{"dimension": "custom", "scale": 100.0, "symbol": "%"}},
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := conversionsByColumn(tc.want, tc.yAxis)
			if !reflect.DeepEqual(got, tc.out) {
				t.Fatalf("got %#v, want %#v", got, tc.out)
			}
		})
	}
}
