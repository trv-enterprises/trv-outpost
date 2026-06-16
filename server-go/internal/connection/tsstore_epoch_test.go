// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import "testing"

func TestToEpochNanos(t *testing.T) {
	const ns = int64(1_000_000_000)
	cases := []struct {
		name string
		in   int64
		want int64
	}{
		{"seconds (10-digit)", 1780000000, 1780000000 * ns},
		{"milliseconds (13-digit)", 1780000000_000, 1780000000 * ns},
		{"microseconds (16-digit)", 1780000000_000_000, 1780000000 * ns},
		{"nanoseconds (19-digit) unchanged", 1780000000_000_000_000, 1780000000_000_000_000},
		{"zero passthrough", 0, 0},
		{"negative passthrough", -5, -5},
	}
	for _, c := range cases {
		if got := toEpochNanos(c.in); got != c.want {
			t.Errorf("%s: toEpochNanos(%d) = %d, want %d", c.name, c.in, got, c.want)
		}
	}
}
