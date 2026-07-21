// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package stats

import (
	"math"
	"testing"
	"time"
)

func almost(t *testing.T, name string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", name, got, want)
	}
}

func TestMeanStdDev(t *testing.T) {
	xs := []float64{2, 4, 4, 4, 5, 5, 7, 9}
	almost(t, "Mean", Mean(xs), 5)
	// Sample stddev: sqrt(32/7)
	almost(t, "StdDev", StdDev(xs), math.Sqrt(32.0/7.0))

	almost(t, "Mean(empty)", Mean(nil), 0)
	almost(t, "StdDev(single)", StdDev([]float64{3}), 0)
}

func TestMinMax(t *testing.T) {
	mn, mx := MinMax([]float64{3, -1, 7, 0})
	almost(t, "min", mn, -1)
	almost(t, "max", mx, 7)
}

func TestPercentile(t *testing.T) {
	sorted := []float64{1, 2, 3, 4}
	almost(t, "p50", Percentile(sorted, 50), 2.5)
	almost(t, "p25", Percentile(sorted, 25), 1.75)
	almost(t, "p0", Percentile(sorted, 0), 1)
	almost(t, "p100", Percentile(sorted, 100), 4)
	almost(t, "single", Percentile([]float64{9}, 75), 9)
}

func TestHistogram(t *testing.T) {
	xs := []float64{0, 1, 2, 3, 4, 5, 6, 7, 8, 9}
	bins := Histogram(xs, 5)
	if len(bins) != 5 {
		t.Fatalf("expected 5 bins, got %d", len(bins))
	}
	for i, b := range bins {
		if b.Count != 2 {
			t.Errorf("bin %d count = %d, want 2", i, b.Count)
		}
	}
	// Max value lands in the last bin, not out of range.
	almost(t, "last hi", bins[4].Hi, 9)

	flat := Histogram([]float64{5, 5, 5}, 4)
	if len(flat) != 1 || flat[0].Count != 3 {
		t.Errorf("flat histogram = %+v, want single bin of 3", flat)
	}
}

func TestPearson(t *testing.T) {
	r, ok := Pearson([]float64{1, 2, 3}, []float64{2, 4, 6})
	if !ok {
		t.Fatal("expected ok")
	}
	almost(t, "perfect positive", r, 1)

	r, ok = Pearson([]float64{1, 2, 3}, []float64{6, 4, 2})
	if !ok {
		t.Fatal("expected ok")
	}
	almost(t, "perfect negative", r, -1)

	if _, ok := Pearson([]float64{1, 2, 3}, []float64{5, 5, 5}); ok {
		t.Error("zero-variance side should not be ok")
	}
	if _, ok := Pearson([]float64{1, 2}, []float64{1}); ok {
		t.Error("length mismatch should not be ok")
	}
}

func TestLinReg(t *testing.T) {
	slope, intercept, r2, ok := LinReg([]float64{0, 1, 2, 3}, []float64{1, 3, 5, 7})
	if !ok {
		t.Fatal("expected ok")
	}
	almost(t, "slope", slope, 2)
	almost(t, "intercept", intercept, 1)
	almost(t, "r2", r2, 1)

	// Flat y fits its flat line exactly.
	slope, _, r2, ok = LinReg([]float64{0, 1, 2}, []float64{4, 4, 4})
	if !ok {
		t.Fatal("expected ok for flat y")
	}
	almost(t, "flat slope", slope, 0)
	almost(t, "flat r2", r2, 1)

	if _, _, _, ok := LinReg([]float64{2, 2, 2}, []float64{1, 2, 3}); ok {
		t.Error("zero-variance x should not be ok")
	}
}

func TestRollingZScores(t *testing.T) {
	// Noisy-ish baseline with a spike at the end.
	xs := []float64{10, 11, 10, 9, 10, 11, 10, 9, 10, 11, 30}
	scores := RollingZScores(xs, 5)
	if len(scores) != len(xs) {
		t.Fatalf("len = %d, want %d", len(scores), len(xs))
	}
	for i := 0; i < 5; i++ {
		almost(t, "warmup score", scores[i], 0)
	}
	if scores[10] < 3 {
		t.Errorf("spike score = %v, want >= 3", scores[10])
	}

	// Flat signal with a spike: zero-variance window must still flag.
	flat := []float64{5, 5, 5, 5, 5, 50}
	fs := RollingZScores(flat, 3)
	almost(t, "flat spike sentinel", fs[5], zeroVarianceScore)
}

func TestIQRBounds(t *testing.T) {
	lo, hi := IQRBounds([]float64{1, 2, 3, 4, 100})
	// sorted n=5: q1=2, q3=4, iqr=2
	almost(t, "lo", lo, -1)
	almost(t, "hi", hi, 7)
}

func TestToFloat64(t *testing.T) {
	cases := []struct {
		in   interface{}
		want float64
		ok   bool
	}{
		{float64(1.5), 1.5, true},
		{float32(2), 2, true},
		{int(3), 3, true},
		{int64(4), 4, true},
		{int32(5), 5, true},
		{"3.5", 3.5, true},
		{" 7 ", 7, true},
		{"abc", 0, false},
		{true, 0, false},
		{nil, 0, false},
	}
	for _, c := range cases {
		got, ok := ToFloat64(c.in)
		if got != c.want || ok != c.ok {
			t.Errorf("ToFloat64(%v) = (%v, %v), want (%v, %v)", c.in, got, ok, c.want, c.ok)
		}
	}
}

func TestParseTimestamp(t *testing.T) {
	// Epoch seconds must NOT parse as 1970 (the epoch-seconds trap).
	sec := ParseTimestamp(float64(1780000000))
	if sec.Year() < 2020 {
		t.Errorf("epoch seconds parsed to %v — the 1970 trap", sec)
	}
	ms := ParseTimestamp(int64(1780000000000))
	if ms.Year() < 2020 {
		t.Errorf("epoch millis parsed to %v", ms)
	}
	rfc := ParseTimestamp("2026-07-21T10:00:00Z")
	if rfc != time.Date(2026, 7, 21, 10, 0, 0, 0, time.UTC) {
		t.Errorf("RFC3339 parsed to %v", rfc)
	}
	sqlish := ParseTimestamp("2026-07-21 10:00:00")
	if sqlish.IsZero() {
		t.Error("SQL-style timestamp did not parse")
	}
	if !ParseTimestamp("not a time").IsZero() {
		t.Error("garbage should parse to zero time")
	}
}
