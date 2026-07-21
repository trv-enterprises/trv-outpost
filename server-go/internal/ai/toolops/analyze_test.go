// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package toolops

import (
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// The tests exercise analyzeResultSet (the fetch-free core) against
// fixture ResultSets — AnalyzeDataset itself is fetch + this.

func fixtureRS(columns []string, rows [][]interface{}) *models.ResultSet {
	return &models.ResultSet{Columns: columns, Rows: rows}
}

func TestNormalizeAnalysis(t *testing.T) {
	for _, good := range []string{"summary", " Anomaly ", "CORRELATION", "trend"} {
		if _, err := normalizeAnalysis(good); err != nil {
			t.Errorf("normalizeAnalysis(%q) errored: %v", good, err)
		}
	}
	if _, err := normalizeAnalysis("forecast"); err == nil {
		t.Error("forecast should be rejected (deferred to #181)")
	}
}

func TestAnalyzeSummary(t *testing.T) {
	rs := fixtureRS([]string{"temp", "label"}, [][]interface{}{
		{10.0, "a"}, {20.0, "b"}, {30.0, "c"}, {nil, "d"}, {"oops", "e"},
	})
	out, err := analyzeResultSet(AnalyzeDatasetInput{}, "summary", rs)
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Columns) != 2 {
		t.Fatalf("expected 2 column summaries, got %d", len(out.Columns))
	}
	temp := out.Columns[0]
	if temp.Count != 3 || temp.NullCount != 1 || temp.NonNumeric != 1 {
		t.Errorf("temp counts = %d/%d/%d, want 3/1/1", temp.Count, temp.NullCount, temp.NonNumeric)
	}
	if temp.Mean != 20 || temp.Min != 10 || temp.Max != 30 {
		t.Errorf("temp stats mean=%v min=%v max=%v", temp.Mean, temp.Min, temp.Max)
	}
	if temp.Percentiles["p50"] != 20 {
		t.Errorf("p50 = %v, want 20", temp.Percentiles["p50"])
	}
	// The all-string column reports counts only.
	label := out.Columns[1]
	if label.Count != 0 || label.NonNumeric != 5 {
		t.Errorf("label counts = %d numeric / %d non-numeric, want 0/5", label.Count, label.NonNumeric)
	}
}

func TestAnalyzeSummaryUnknownColumn(t *testing.T) {
	rs := fixtureRS([]string{"a"}, [][]interface{}{{1.0}})
	_, err := analyzeResultSet(AnalyzeDatasetInput{Columns: []string{"nope"}}, "summary", rs)
	if err == nil || !strings.Contains(err.Error(), "available columns") {
		t.Errorf("expected available-columns error, got %v", err)
	}
}

func TestAnalyzeAnomalyRollingZScore(t *testing.T) {
	// 100 flat-ish points with a spike cluster at 60-61. Epoch seconds
	// timestamps exercise the seconds-vs-1970 parse path.
	var rows [][]interface{}
	base := 1780000000
	for i := 0; i < 100; i++ {
		v := 10.0
		if i%2 == 0 {
			v = 11.0
		}
		if i == 60 || i == 61 {
			v = 100.0
		}
		rows = append(rows, []interface{}{float64(base + i*60), v})
	}
	rs := fixtureRS([]string{"ts", "watts"}, rows)
	out, err := analyzeResultSet(AnalyzeDatasetInput{Column: "watts", TimestampColumn: "ts"}, "anomaly", rs)
	if err != nil {
		t.Fatal(err)
	}
	a := out.Anomaly
	if a == nil {
		t.Fatal("no anomaly result")
	}
	if a.Method != "rolling_zscore" {
		t.Errorf("method = %s", a.Method)
	}
	// The trailing-window z-score flags the spike ONSET; the second
	// spike point sits in a window contaminated by the first, so >= 1.
	if a.TotalFlagged < 1 {
		t.Errorf("flagged = %d, want >= 1 (the spike onset)", a.TotalFlagged)
	}
	if len(a.Windows) == 0 {
		t.Fatal("no anomaly windows")
	}
	w := a.Windows[0]
	if w.StartIndex != 60 {
		t.Errorf("window start index = %d, want 60 (the spike onset)", w.StartIndex)
	}
	if w.PeakValue != 100 {
		t.Errorf("peak value = %v, want 100", w.PeakValue)
	}
	if !strings.HasPrefix(w.Start, "202") {
		t.Errorf("window start %q did not parse as a modern date (1970 trap?)", w.Start)
	}
}

func TestAnalyzeAnomalyIQRSmallN(t *testing.T) {
	rows := [][]interface{}{}
	for _, v := range []float64{5, 5, 6, 5, 4, 5, 6, 5, 5, 6, 5, 4, 50} {
		rows = append(rows, []interface{}{v})
	}
	rs := fixtureRS([]string{"v"}, rows)
	out, err := analyzeResultSet(AnalyzeDatasetInput{Column: "v"}, "anomaly", rs)
	if err != nil {
		t.Fatal(err)
	}
	if out.Anomaly.Method != "iqr" {
		t.Errorf("method = %s, want iqr for n<30", out.Anomaly.Method)
	}
	if out.Anomaly.TotalFlagged != 1 {
		t.Errorf("flagged = %d, want 1", out.Anomaly.TotalFlagged)
	}
	if len(out.Anomaly.Windows) != 1 || out.Anomaly.Windows[0].PeakValue != 50 {
		t.Errorf("windows = %+v, want single window peaking at 50", out.Anomaly.Windows)
	}
}

func TestAnalyzeCorrelation(t *testing.T) {
	var rows [][]interface{}
	for i := 0; i < 50; i++ {
		x := float64(i%10) + float64(i)*0.1
		rows = append(rows, []interface{}{x, 2*x + 1})
	}
	rs := fixtureRS([]string{"a", "b"}, rows)
	out, err := analyzeResultSet(AnalyzeDatasetInput{ColumnA: "a", ColumnB: "b"}, "correlation", rs)
	if err != nil {
		t.Fatal(err)
	}
	if out.Correlation.Pearson != 1 {
		t.Errorf("pearson = %v, want 1", out.Correlation.Pearson)
	}
	if out.Correlation.N != 50 {
		t.Errorf("n = %d, want 50", out.Correlation.N)
	}
}

func TestAnalyzeCorrelationLag(t *testing.T) {
	// b is a copied 3 rows later: best positive lag should be 3.
	var rows [][]interface{}
	series := make([]float64, 60)
	for i := range series {
		series[i] = float64((i * 37) % 11) // pseudo-random-ish, deterministic
	}
	for i := 3; i < 60; i++ {
		rows = append(rows, []interface{}{series[i], series[i-3]})
	}
	rs := fixtureRS([]string{"a", "b"}, rows)
	out, err := analyzeResultSet(AnalyzeDatasetInput{ColumnA: "a", ColumnB: "b", MaxLag: 5}, "correlation", rs)
	if err != nil {
		t.Fatal(err)
	}
	if out.Correlation.BestLag == nil {
		t.Fatal("no best_lag")
	}
	if out.Correlation.BestLag.Lag != 3 {
		t.Errorf("best lag = %d, want 3", out.Correlation.BestLag.Lag)
	}
	if out.Correlation.BestLag.Pearson != 1 {
		t.Errorf("best-lag pearson = %v, want 1", out.Correlation.BestLag.Pearson)
	}
}

func TestAnalyzeTrend(t *testing.T) {
	// Value climbs 1 unit per minute; timestamps as RFC3339 strings.
	var rows [][]interface{}
	for i := 0; i < 48; i++ {
		ts := fmt.Sprintf("2026-07-%02dT%02d:00:00Z", 1+i/24, i%24)
		rows = append(rows, []interface{}{ts, float64(i)})
	}
	rs := fixtureRS([]string{"ts", "v"}, rows)
	out, err := analyzeResultSet(AnalyzeDatasetInput{Column: "v", TimestampColumn: "ts"}, "trend", rs)
	if err != nil {
		t.Fatal(err)
	}
	tr := out.Trend
	if tr == nil {
		t.Fatal("no trend result")
	}
	if tr.SlopeUnit != "per_second" {
		t.Errorf("slope unit = %s", tr.SlopeUnit)
	}
	// 1 unit per hour = 1/3600 per second.
	if math.Abs(tr.Slope-1.0/3600) > 1e-9 {
		t.Errorf("slope = %v, want %v", tr.Slope, 1.0/3600)
	}
	if tr.R2 != 1 {
		t.Errorf("r2 = %v, want 1", tr.R2)
	}
	if len(tr.HourOfDay) != 24 {
		t.Errorf("hour-of-day buckets = %d, want 24", len(tr.HourOfDay))
	}
	if len(tr.DayOfWeek) != 2 {
		t.Errorf("day-of-week buckets = %d, want 2 (two days of data)", len(tr.DayOfWeek))
	}
}

func TestAnalyzeTrendNoTimestamps(t *testing.T) {
	rows := [][]interface{}{{1.0}, {2.0}, {3.0}, {4.0}}
	out, err := analyzeResultSet(AnalyzeDatasetInput{Column: "v"}, "trend", fixtureRS([]string{"v"}, rows))
	if err != nil {
		t.Fatal(err)
	}
	if out.Trend.SlopeUnit != "per_row" || out.Trend.Slope != 1 {
		t.Errorf("trend = %+v, want per_row slope 1", out.Trend)
	}
	if out.Trend.HourOfDay != nil {
		t.Error("hour-of-day buckets should be absent without timestamps")
	}
}

func TestAnalyzeEmptyResult(t *testing.T) {
	out, err := analyzeResultSet(AnalyzeDatasetInput{}, "summary", fixtureRS([]string{"a"}, nil))
	if err != nil {
		t.Fatal(err)
	}
	if out.RowCount != 0 || len(out.Notes) == 0 {
		t.Errorf("empty result should note no rows: %+v", out)
	}
}

func TestSig6(t *testing.T) {
	if got := sig6(0.30000000000000004); got != 0.3 {
		t.Errorf("sig6 float artifact = %v", got)
	}
	if got := sig6(1780000123.0); got != 1.78e9 {
		t.Errorf("sig6 large = %v, want 1.78e9", got)
	}
	if got := sig6(math.NaN()); got != 0 {
		t.Errorf("sig6(NaN) = %v, want 0", got)
	}
}
