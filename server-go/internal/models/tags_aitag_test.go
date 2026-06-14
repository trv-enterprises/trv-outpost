// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"reflect"
	"testing"
)

// WithAITag stamps the AI-provenance tag (issue #59) without clobbering
// descriptive tags and without doubling "ai".
func TestWithAITag(t *testing.T) {
	cases := []struct {
		name string
		in   []string
		want []string
	}{
		{"empty", nil, []string{"ai"}},
		{"descriptive preserved", []string{"cpu", "trv-srv-001"}, []string{"ai", "cpu", "trv-srv-001"}},
		{"already has ai → no double", []string{"ai", "cpu"}, []string{"ai", "cpu"}},
		{"normalizes + dedupes", []string{"CPU", "cpu", "System Stats"}, []string{"ai", "cpu", "system-stats"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := WithAITag(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("WithAITag(%v) = %v, want %v", c.in, got, c.want)
			}
		})
	}
}
