// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package stats holds the pure numeric routines behind the
// analyze_dataset tool (#183). Everything here operates on plain
// float64 slices with no service or transport dependencies, so each
// routine is unit-testable against golden values. The consumer
// (internal/ai/toolops) owns row extraction, timestamp alignment,
// and output shaping.
package stats

import (
	"math"
	"sort"
)

// Mean returns the arithmetic mean of xs, or 0 when xs is empty.
func Mean(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	sum := 0.0
	for _, x := range xs {
		sum += x
	}
	return sum / float64(len(xs))
}

// StdDev returns the sample standard deviation (n−1 denominator),
// or 0 when fewer than two values.
func StdDev(xs []float64) float64 {
	n := len(xs)
	if n < 2 {
		return 0
	}
	m := Mean(xs)
	ss := 0.0
	for _, x := range xs {
		d := x - m
		ss += d * d
	}
	return math.Sqrt(ss / float64(n-1))
}

// MinMax returns the smallest and largest values; zeros for empty input.
func MinMax(xs []float64) (float64, float64) {
	if len(xs) == 0 {
		return 0, 0
	}
	mn, mx := xs[0], xs[0]
	for _, x := range xs[1:] {
		if x < mn {
			mn = x
		}
		if x > mx {
			mx = x
		}
	}
	return mn, mx
}

// SortedCopy returns xs sorted ascending without mutating the input.
func SortedCopy(xs []float64) []float64 {
	out := make([]float64, len(xs))
	copy(out, xs)
	sort.Float64s(out)
	return out
}

// Percentile returns the p-th percentile (0–100) of already-sorted
// input, using linear interpolation between closest ranks.
func Percentile(sorted []float64, p float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	rank := p / 100 * float64(n-1)
	lo := int(math.Floor(rank))
	hi := int(math.Ceil(rank))
	if lo == hi {
		return sorted[lo]
	}
	frac := rank - float64(lo)
	return sorted[lo]*(1-frac) + sorted[hi]*frac
}

// Bin is one histogram bucket covering [Lo, Hi); the last bin also
// includes its upper bound.
type Bin struct {
	Lo    float64 `json:"lo"`
	Hi    float64 `json:"hi"`
	Count int     `json:"count"`
}

// Histogram buckets xs into maxBins equal-width bins. A zero-width
// value range collapses to a single bin.
func Histogram(xs []float64, maxBins int) []Bin {
	if len(xs) == 0 || maxBins < 1 {
		return nil
	}
	mn, mx := MinMax(xs)
	if mn == mx {
		return []Bin{{Lo: mn, Hi: mx, Count: len(xs)}}
	}
	width := (mx - mn) / float64(maxBins)
	bins := make([]Bin, maxBins)
	for i := range bins {
		bins[i].Lo = mn + float64(i)*width
		bins[i].Hi = mn + float64(i+1)*width
	}
	for _, x := range xs {
		idx := int((x - mn) / width)
		if idx >= maxBins {
			idx = maxBins - 1
		}
		bins[idx].Count++
	}
	return bins
}

// Pearson returns the correlation coefficient of the paired samples.
// ok is false when the lengths differ, fewer than two pairs exist,
// or either side has zero variance (correlation undefined).
func Pearson(a, b []float64) (float64, bool) {
	n := len(a)
	if n != len(b) || n < 2 {
		return 0, false
	}
	ma, mb := Mean(a), Mean(b)
	var sab, saa, sbb float64
	for i := 0; i < n; i++ {
		da, db := a[i]-ma, b[i]-mb
		sab += da * db
		saa += da * da
		sbb += db * db
	}
	if saa == 0 || sbb == 0 {
		return 0, false
	}
	return sab / math.Sqrt(saa*sbb), true
}

// LinReg fits y = slope·x + intercept by least squares and reports R².
// ok is false when the lengths differ, fewer than two points exist,
// or x has zero variance. A zero-variance y (flat series) fits its
// flat line exactly, so R² is reported as 1.
func LinReg(x, y []float64) (slope, intercept, r2 float64, ok bool) {
	n := len(x)
	if n != len(y) || n < 2 {
		return 0, 0, 0, false
	}
	mx, my := Mean(x), Mean(y)
	var sxy, sxx, syy float64
	for i := 0; i < n; i++ {
		dx, dy := x[i]-mx, y[i]-my
		sxy += dx * dy
		sxx += dx * dx
		syy += dy * dy
	}
	if sxx == 0 {
		return 0, 0, 0, false
	}
	slope = sxy / sxx
	intercept = my - slope*mx
	if syy == 0 {
		return slope, intercept, 1, true
	}
	r := sxy / math.Sqrt(sxx*syy)
	return slope, intercept, r * r, true
}

// zeroVarianceScore is the sentinel z-score assigned when a point
// deviates from a zero-variance trailing window (flat signal with a
// spike). It must exceed any plausible sensitivity threshold while
// staying JSON-serializable (no ±Inf).
const zeroVarianceScore = 99

// RollingZScores scores each point against the mean/stddev of the
// window points immediately preceding it. The first window points
// score 0. When the trailing window has zero variance, a deviating
// point gets ±zeroVarianceScore so flat-signal spikes still flag.
func RollingZScores(xs []float64, window int) []float64 {
	scores := make([]float64, len(xs))
	if window < 2 || len(xs) <= window {
		return scores
	}
	for i := window; i < len(xs); i++ {
		w := xs[i-window : i]
		m := Mean(w)
		sd := StdDev(w)
		switch {
		case sd > 0:
			scores[i] = (xs[i] - m) / sd
		case xs[i] > m:
			scores[i] = zeroVarianceScore
		case xs[i] < m:
			scores[i] = -zeroVarianceScore
		}
	}
	return scores
}

// IQRBounds returns the Tukey outlier fences Q1−1.5·IQR and
// Q3+1.5·IQR.
func IQRBounds(xs []float64) (lo, hi float64) {
	sorted := SortedCopy(xs)
	q1 := Percentile(sorted, 25)
	q3 := Percentile(sorted, 75)
	iqr := q3 - q1
	return q1 - 1.5*iqr, q3 + 1.5*iqr
}
