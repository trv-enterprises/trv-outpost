// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package toolops

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/stats"
)

// analyze_dataset (#183): the server fetches rows from a connection,
// runs a canned statistical analysis in Go, and returns a compact
// JSON summary the model can interpret. The output is deliberately
// small (hard caps everywhere) so it always lands inline in the chat
// result store instead of behind a result_id — the whole point is
// that the model reasons over data too big to read row-by-row.

const (
	analyzeDefaultMaxRows    = 50000
	analyzeHistogramBins     = 12
	analyzeMaxAnomalyWindows = 20
	analyzeMaxSummaryColumns = 20
	analyzeMaxGroups         = 20
	analyzeMaxGroupColumns   = 5
)

// AnalyzeDatasetInput mirrors QueryConnectionInput for the fetch
// fields (connection_id, raw, type, params) and adds the analysis
// selection. JSON tags let both consumers unmarshal the model-facing
// snake_case args directly.
type AnalyzeDatasetInput struct {
	ConnectionID    string                 `json:"connection_id"`
	Raw             string                 `json:"raw"`
	Type            string                 `json:"type,omitempty"`
	Params          map[string]interface{} `json:"params,omitempty"`
	Analysis        string                 `json:"analysis"`
	Columns         []string               `json:"columns,omitempty"`
	Column          string                 `json:"column,omitempty"`
	ColumnA         string                 `json:"column_a,omitempty"`
	ColumnB         string                 `json:"column_b,omitempty"`
	TimestampColumn string                 `json:"timestamp_column,omitempty"`
	GroupBy         string                 `json:"group_by,omitempty"`
	Sensitivity     float64                `json:"sensitivity,omitempty"`
	MaxLag          int                    `json:"max_lag,omitempty"`
	MaxRows         int                    `json:"max_rows,omitempty"`
}

type AnalyzeDatasetOutput struct {
	Analysis    string             `json:"analysis"`
	RowCount    int                `json:"row_count"`
	Truncated   bool               `json:"truncated,omitempty"`
	Notes       []string           `json:"notes,omitempty"`
	TimeRange   *AnalyzeTimeRange  `json:"time_range,omitempty"`
	Columns     []ColumnSummary    `json:"columns,omitempty"`
	Groups      []GroupSummary     `json:"groups,omitempty"`
	GroupCount  int                `json:"group_count,omitempty"`
	Anomaly     *AnomalyResult     `json:"anomaly,omitempty"`
	Correlation *CorrelationResult `json:"correlation,omitempty"`
	Trend       *TrendResult       `json:"trend,omitempty"`
}

// AnalyzeTimeRange reports the first/last parseable timestamp of the
// summary's timestamp_column.
type AnalyzeTimeRange struct {
	Start string `json:"start"`
	End   string `json:"end"`
}

// GroupSummary carries per-group column stats for the summary
// analysis's group_by mode. Grouped summaries skip percentiles and
// histograms to keep the payload small.
type GroupSummary struct {
	Group    string          `json:"group"`
	RowCount int             `json:"row_count"`
	Columns  []ColumnSummary `json:"columns"`
}

type ColumnSummary struct {
	Name          string             `json:"name"`
	Count         int                `json:"count"`
	NullCount     int                `json:"null_count,omitempty"`
	NonNumeric    int                `json:"non_numeric,omitempty"`
	DistinctCount int                `json:"distinct_count,omitempty"` // distinct non-null raw values (numeric or not)
	Mean          float64            `json:"mean"`
	StdDev        float64            `json:"std_dev"`
	Min           float64            `json:"min"`
	Max           float64            `json:"max"`
	Last          float64            `json:"last"` // final numeric value in row order; meaningful when count > 0
	Percentiles   map[string]float64 `json:"percentiles,omitempty"`
	Histogram     []stats.Bin        `json:"histogram,omitempty"`
}

type AnomalyResult struct {
	Column           string          `json:"column"`
	Method           string          `json:"method"` // rolling_zscore | iqr
	Window           int             `json:"window,omitempty"`
	Threshold        float64         `json:"threshold"`
	TotalFlagged     int             `json:"total_flagged"`
	Windows          []AnomalyWindow `json:"windows,omitempty"`
	WindowsTruncated bool            `json:"windows_truncated,omitempty"`
}

type AnomalyWindow struct {
	StartIndex int     `json:"start_index"`
	EndIndex   int     `json:"end_index"`
	Start      string  `json:"start,omitempty"` // RFC3339 when timestamps available
	End        string  `json:"end,omitempty"`
	PeakValue  float64 `json:"peak_value"`
	PeakScore  float64 `json:"peak_score"`
}

type CorrelationResult struct {
	ColumnA string     `json:"column_a"`
	ColumnB string     `json:"column_b"`
	N       int        `json:"n"`
	Pearson float64    `json:"pearson"`
	BestLag *LagResult `json:"best_lag,omitempty"`
}

// LagResult reports the row shift with the strongest correlation. A
// positive lag means changes in column_a precede column_b by that
// many rows.
type LagResult struct {
	Lag     int     `json:"lag"`
	Pearson float64 `json:"pearson"`
}

type TrendResult struct {
	Column    string       `json:"column"`
	N         int          `json:"n"`
	Slope     float64      `json:"slope"`
	SlopeUnit string       `json:"slope_unit"` // per_second | per_row
	Intercept float64      `json:"intercept"`
	R2        float64      `json:"r2"`
	Start     string       `json:"start,omitempty"`
	End       string       `json:"end,omitempty"`
	HourOfDay []BucketMean `json:"hour_of_day,omitempty"`
	DayOfWeek []BucketMean `json:"day_of_week,omitempty"`
}

// BucketMean is the mean of a time bucket (hour 0–23 or weekday 0–6,
// Sunday=0), only emitted for buckets that had data.
type BucketMean struct {
	Bucket int     `json:"bucket"`
	Mean   float64 `json:"mean"`
	Count  int     `json:"count"`
}

// AnalyzeDataset fetches rows from a connection through the same
// trusted-query path as QueryConnection (verb guard and connection
// access rules unchanged) and runs the requested canned analysis
// server-side.
func (ts *Toolset) AnalyzeDataset(ctx context.Context, in AnalyzeDatasetInput) (*AnalyzeDatasetOutput, error) {
	if ts.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	analysis, err := normalizeAnalysis(in.Analysis)
	if err != nil {
		return nil, err
	}
	maxRows := in.MaxRows
	if maxRows <= 0 || maxRows > analyzeDefaultMaxRows {
		maxRows = analyzeDefaultMaxRows
	}
	resp, err := ts.QueryConnection(ctx, QueryConnectionInput{
		ConnectionID: in.ConnectionID,
		Raw:          in.Raw,
		Type:         in.Type,
		Params:       in.Params,
		Limit:        maxRows,
	})
	if err != nil {
		return nil, err
	}
	if resp == nil || !resp.Success {
		msg := "no response"
		if resp != nil && resp.Error != "" {
			msg = resp.Error
		}
		return nil, fmt.Errorf("query failed: %s", msg)
	}
	return analyzeResultSet(in, analysis, resp.ResultSet)
}

func normalizeAnalysis(raw string) (string, error) {
	analysis := strings.ToLower(strings.TrimSpace(raw))
	switch analysis {
	case "summary", "anomaly", "correlation", "trend":
		return analysis, nil
	}
	return "", fmt.Errorf("unknown analysis %q — expected summary, anomaly, correlation, or trend", raw)
}

// analyzeResultSet is the fetch-free core, split out so tests can run
// it against fixture ResultSets without a live connection service.
func analyzeResultSet(in AnalyzeDatasetInput, analysis string, rs *models.ResultSet) (*AnalyzeDatasetOutput, error) {
	out := &AnalyzeDatasetOutput{Analysis: analysis}
	if rs == nil || len(rs.Rows) == 0 {
		out.Notes = append(out.Notes, "query returned no rows to analyze")
		return out, nil
	}
	out.RowCount = len(rs.Rows)
	if rs.Metadata != nil {
		if _, ok := rs.Metadata["truncated_to"]; ok {
			out.Truncated = true
			out.Notes = append(out.Notes, fmt.Sprintf("result truncated to %d rows before analysis — narrow the query for a complete picture", len(rs.Rows)))
		}
	}
	switch analysis {
	case "summary":
		return analyzeSummary(in, rs, out)
	case "anomaly":
		return analyzeAnomaly(in, rs, out)
	case "correlation":
		return analyzeCorrelation(in, rs, out)
	case "trend":
		return analyzeTrend(in, rs, out)
	}
	return nil, fmt.Errorf("unhandled analysis %q", analysis)
}

// ─── summary ──────────────────────────────────────────────────────

func analyzeSummary(in AnalyzeDatasetInput, rs *models.ResultSet, out *AnalyzeDatasetOutput) (*AnalyzeDatasetOutput, error) {
	grouped := in.GroupBy != ""
	gIdx := -1
	if grouped {
		var err error
		if gIdx, err = columnIndex(rs, in.GroupBy); err != nil {
			return nil, err
		}
	}
	maxCols := analyzeMaxSummaryColumns
	if grouped {
		maxCols = analyzeMaxGroupColumns
	}
	names := in.Columns
	if len(names) == 0 {
		for _, c := range rs.Columns {
			if grouped && c == rs.Columns[gIdx] {
				continue // summarizing the group key within its own groups is noise
			}
			names = append(names, c)
		}
	}
	if len(names) > maxCols {
		names = names[:maxCols]
		out.Notes = append(out.Notes, fmt.Sprintf("summarizing the first %d columns — pass columns to pick specific ones", maxCols))
	}
	idxs := make([]int, len(names))
	for i, name := range names {
		idx, err := columnIndex(rs, name)
		if err != nil {
			return nil, err
		}
		idxs[i] = idx
	}
	if in.TimestampColumn != "" {
		if err := summaryTimeRange(in.TimestampColumn, rs, out); err != nil {
			return nil, err
		}
	}
	if !grouped {
		for _, idx := range idxs {
			out.Columns = append(out.Columns, buildColumnSummary(rs, idx, nil, true))
		}
		return out, nil
	}

	// Partition row indices by the group key's rendered value,
	// preserving first-seen order for deterministic tie-breaks.
	groups := map[string][]int{}
	var order []string
	for i, row := range rs.Rows {
		key := "(null)"
		if gIdx < len(row) && row[gIdx] != nil {
			key = fmt.Sprintf("%v", row[gIdx])
		}
		if _, seen := groups[key]; !seen {
			order = append(order, key)
		}
		groups[key] = append(groups[key], i)
	}
	out.GroupCount = len(order)
	sort.SliceStable(order, func(i, j int) bool { return len(groups[order[i]]) > len(groups[order[j]]) })
	if len(order) > analyzeMaxGroups {
		order = order[:analyzeMaxGroups]
		out.Notes = append(out.Notes, fmt.Sprintf("reporting the %d largest of %d groups", analyzeMaxGroups, out.GroupCount))
	}
	for _, key := range order {
		gs := GroupSummary{Group: key, RowCount: len(groups[key])}
		for _, idx := range idxs {
			// Grouped summaries skip percentiles/histograms so
			// groups × columns stays well under the inline threshold.
			gs.Columns = append(gs.Columns, buildColumnSummary(rs, idx, groups[key], false))
		}
		out.Groups = append(out.Groups, gs)
	}
	return out, nil
}

// buildColumnSummary computes one column's stats over the given row
// indices (nil = all rows). full adds percentiles and a histogram.
func buildColumnSummary(rs *models.ResultSet, idx int, rowIdxs []int, full bool) ColumnSummary {
	cs := ColumnSummary{Name: rs.Columns[idx]}
	distinct := map[string]struct{}{}
	var values []float64
	visit := func(row []interface{}) {
		if idx >= len(row) || row[idx] == nil {
			cs.NullCount++
			return
		}
		distinct[fmt.Sprintf("%v", row[idx])] = struct{}{}
		v, ok := stats.ToFloat64(row[idx])
		if !ok {
			cs.NonNumeric++
			return
		}
		values = append(values, v)
	}
	if rowIdxs == nil {
		for _, row := range rs.Rows {
			visit(row)
		}
	} else {
		for _, i := range rowIdxs {
			visit(rs.Rows[i])
		}
	}
	cs.Count = len(values)
	cs.DistinctCount = len(distinct)
	if cs.Count > 0 {
		cs.Mean = sig6(stats.Mean(values))
		cs.StdDev = sig6(stats.StdDev(values))
		mn, mx := stats.MinMax(values)
		cs.Min, cs.Max = sig6(mn), sig6(mx)
		cs.Last = sig6(values[len(values)-1])
		if full {
			sorted := stats.SortedCopy(values)
			cs.Percentiles = map[string]float64{
				"p05": sig6(stats.Percentile(sorted, 5)),
				"p25": sig6(stats.Percentile(sorted, 25)),
				"p50": sig6(stats.Percentile(sorted, 50)),
				"p75": sig6(stats.Percentile(sorted, 75)),
				"p95": sig6(stats.Percentile(sorted, 95)),
			}
			cs.Histogram = roundBins(stats.Histogram(values, analyzeHistogramBins))
		}
	}
	return cs
}

// summaryTimeRange stamps the first/last parseable timestamp of the
// requested time column onto the output.
func summaryTimeRange(tsColumn string, rs *models.ResultSet, out *AnalyzeDatasetOutput) error {
	tsIdx, err := columnIndex(rs, tsColumn)
	if err != nil {
		return err
	}
	var first, last time.Time
	for _, row := range rs.Rows {
		if tsIdx >= len(row) {
			continue
		}
		t := stats.ParseTimestamp(row[tsIdx])
		if t.IsZero() {
			continue
		}
		if first.IsZero() || t.Before(first) {
			first = t
		}
		if last.IsZero() || t.After(last) {
			last = t
		}
	}
	if !first.IsZero() {
		out.TimeRange = &AnalyzeTimeRange{
			Start: first.UTC().Format(time.RFC3339),
			End:   last.UTC().Format(time.RFC3339),
		}
	}
	return nil
}

// ─── anomaly ──────────────────────────────────────────────────────

func analyzeAnomaly(in AnalyzeDatasetInput, rs *models.ResultSet, out *AnalyzeDatasetOutput) (*AnalyzeDatasetOutput, error) {
	if in.Column == "" {
		return nil, fmt.Errorf("column is required for the anomaly analysis")
	}
	series, err := extractSeries(rs, in.Column, in.TimestampColumn, out)
	if err != nil {
		return nil, err
	}
	n := len(series.values)
	if n < 10 {
		return nil, fmt.Errorf("only %d numeric values in column %q — need at least 10 for anomaly detection", n, in.Column)
	}
	threshold := in.Sensitivity
	if threshold <= 0 {
		threshold = 3.0
	}
	threshold = math.Min(math.Max(threshold, 1), 10)

	res := &AnomalyResult{Column: series.name, Threshold: threshold}
	flagged := make([]bool, n)
	scores := make([]float64, n)
	if n >= 30 {
		res.Method = "rolling_zscore"
		res.Window = clampInt(n/20, 10, 100)
		scores = stats.RollingZScores(series.values, res.Window)
		for i, s := range scores {
			if math.Abs(s) >= threshold {
				flagged[i] = true
			}
		}
	} else {
		res.Method = "iqr"
		lo, hi := stats.IQRBounds(series.values)
		sorted := stats.SortedCopy(series.values)
		med := stats.Percentile(sorted, 50)
		// Robust z-score (IQR/1.349 ≈ stddev for normal data) so peak
		// reporting has a comparable score even on the small-n path.
		scale := (stats.Percentile(sorted, 75) - stats.Percentile(sorted, 25)) / 1.349
		for i, v := range series.values {
			if scale > 0 {
				scores[i] = (v - med) / scale
			} else if v != med {
				scores[i] = math.Copysign(99, v-med)
			}
			if v < lo || v > hi {
				flagged[i] = true
			}
		}
	}
	for _, f := range flagged {
		if f {
			res.TotalFlagged++
		}
	}
	res.Windows, res.WindowsTruncated = groupAnomalyWindows(series, flagged, scores)
	if res.WindowsTruncated {
		out.Notes = append(out.Notes, fmt.Sprintf("reporting the first %d anomaly windows of %d flagged points", analyzeMaxAnomalyWindows, res.TotalFlagged))
	}
	out.Anomaly = res
	return out, nil
}

// groupAnomalyWindows merges flagged points separated by at most two
// unflagged rows into windows, capped at analyzeMaxAnomalyWindows.
func groupAnomalyWindows(series numericSeries, flagged []bool, scores []float64) ([]AnomalyWindow, bool) {
	var windows []AnomalyWindow
	start := -1
	last := -1
	flush := func() {
		if start < 0 {
			return
		}
		w := AnomalyWindow{StartIndex: start, EndIndex: last}
		peakIdx := -1
		for i := start; i <= last; i++ {
			if !flagged[i] {
				continue
			}
			if peakIdx < 0 || math.Abs(scores[i]) > math.Abs(scores[peakIdx]) {
				peakIdx = i
			}
		}
		if peakIdx >= 0 {
			w.PeakScore = sig6(scores[peakIdx])
			w.PeakValue = sig6(series.values[peakIdx])
		}
		if len(series.times) > 0 {
			w.Start = series.times[start].UTC().Format(time.RFC3339)
			w.End = series.times[last].UTC().Format(time.RFC3339)
		}
		windows = append(windows, w)
		start, last = -1, -1
	}
	for i, f := range flagged {
		if !f {
			if start >= 0 && i-last > 2 {
				flush()
			}
			continue
		}
		if start < 0 {
			start = i
		}
		last = i
	}
	flush()
	if len(windows) > analyzeMaxAnomalyWindows {
		return windows[:analyzeMaxAnomalyWindows], true
	}
	return windows, false
}

// ─── correlation ──────────────────────────────────────────────────

func analyzeCorrelation(in AnalyzeDatasetInput, rs *models.ResultSet, out *AnalyzeDatasetOutput) (*AnalyzeDatasetOutput, error) {
	if in.ColumnA == "" || in.ColumnB == "" {
		return nil, fmt.Errorf("column_a and column_b are required for the correlation analysis")
	}
	idxA, err := columnIndex(rs, in.ColumnA)
	if err != nil {
		return nil, err
	}
	idxB, err := columnIndex(rs, in.ColumnB)
	if err != nil {
		return nil, err
	}
	tsIdx := -1
	if in.TimestampColumn != "" {
		if tsIdx, err = columnIndex(rs, in.TimestampColumn); err != nil {
			return nil, err
		}
	}
	type pair struct {
		t    time.Time
		a, b float64
	}
	var pairs []pair
	skipped := 0
	for _, row := range rs.Rows {
		if idxA >= len(row) || idxB >= len(row) {
			skipped++
			continue
		}
		a, okA := stats.ToFloat64(row[idxA])
		b, okB := stats.ToFloat64(row[idxB])
		if !okA || !okB {
			skipped++
			continue
		}
		p := pair{a: a, b: b}
		if tsIdx >= 0 {
			if tsIdx >= len(row) {
				skipped++
				continue
			}
			p.t = stats.ParseTimestamp(row[tsIdx])
			if p.t.IsZero() {
				skipped++
				continue
			}
		}
		pairs = append(pairs, p)
	}
	if skipped > 0 {
		out.Notes = append(out.Notes, fmt.Sprintf("%d rows skipped (non-numeric or unparseable values)", skipped))
	}
	if len(pairs) < 3 {
		return nil, fmt.Errorf("only %d usable row pairs for %q vs %q — need at least 3", len(pairs), in.ColumnA, in.ColumnB)
	}
	if tsIdx >= 0 {
		sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].t.Before(pairs[j].t) })
	}
	a := make([]float64, len(pairs))
	b := make([]float64, len(pairs))
	for i, p := range pairs {
		a[i], b[i] = p.a, p.b
	}
	res := &CorrelationResult{ColumnA: rs.Columns[idxA], ColumnB: rs.Columns[idxB], N: len(pairs)}
	r0, ok := stats.Pearson(a, b)
	if !ok {
		out.Notes = append(out.Notes, "correlation undefined: one of the columns has zero variance")
	}
	res.Pearson = sig6(r0)

	maxLag := clampInt(in.MaxLag, 0, minInt(100, len(pairs)/4))
	if maxLag > 0 {
		best := LagResult{Lag: 0, Pearson: r0}
		for lag := 1; lag <= maxLag; lag++ {
			// Positive lag: column_a precedes column_b by lag rows.
			if r, ok := stats.Pearson(a[:len(a)-lag], b[lag:]); ok && math.Abs(r) > math.Abs(best.Pearson) {
				best = LagResult{Lag: lag, Pearson: r}
			}
			if r, ok := stats.Pearson(a[lag:], b[:len(b)-lag]); ok && math.Abs(r) > math.Abs(best.Pearson) {
				best = LagResult{Lag: -lag, Pearson: r}
			}
		}
		best.Pearson = sig6(best.Pearson)
		res.BestLag = &best
		if maxLag < in.MaxLag {
			out.Notes = append(out.Notes, fmt.Sprintf("max_lag clamped to %d (quarter of the usable rows, capped at 100)", maxLag))
		}
	}
	out.Correlation = res
	return out, nil
}

// ─── trend ────────────────────────────────────────────────────────

func analyzeTrend(in AnalyzeDatasetInput, rs *models.ResultSet, out *AnalyzeDatasetOutput) (*AnalyzeDatasetOutput, error) {
	if in.Column == "" {
		return nil, fmt.Errorf("column is required for the trend analysis")
	}
	series, err := extractSeries(rs, in.Column, in.TimestampColumn, out)
	if err != nil {
		return nil, err
	}
	n := len(series.values)
	if n < 3 {
		return nil, fmt.Errorf("only %d numeric values in column %q — need at least 3 for trend", n, in.Column)
	}
	res := &TrendResult{Column: series.name, N: n}
	x := make([]float64, n)
	if len(series.times) > 0 {
		t0 := series.times[0]
		for i, t := range series.times {
			x[i] = t.Sub(t0).Seconds()
		}
		res.SlopeUnit = "per_second"
		res.Start = series.times[0].UTC().Format(time.RFC3339)
		res.End = series.times[n-1].UTC().Format(time.RFC3339)
	} else {
		for i := range x {
			x[i] = float64(i)
		}
		res.SlopeUnit = "per_row"
	}
	slope, intercept, r2, ok := stats.LinReg(x, series.values)
	if !ok {
		out.Notes = append(out.Notes, "trend fit undefined: the x axis has zero variance (identical timestamps?)")
	}
	res.Slope, res.Intercept, res.R2 = sig6(slope), sig6(intercept), sig6(r2)
	if len(series.times) > 0 {
		res.HourOfDay = bucketMeans(series, 24, func(t time.Time) int { return t.Hour() })
		res.DayOfWeek = bucketMeans(series, 7, func(t time.Time) int { return int(t.Weekday()) })
	}
	out.Trend = res
	return out, nil
}

func bucketMeans(series numericSeries, buckets int, key func(time.Time) int) []BucketMean {
	sums := make([]float64, buckets)
	counts := make([]int, buckets)
	for i, t := range series.times {
		k := key(t)
		sums[k] += series.values[i]
		counts[k]++
	}
	var res []BucketMean
	for b := 0; b < buckets; b++ {
		if counts[b] == 0 {
			continue
		}
		res = append(res, BucketMean{Bucket: b, Mean: sig6(sums[b] / float64(counts[b])), Count: counts[b]})
	}
	return res
}

// ─── shared extraction helpers ────────────────────────────────────

type numericSeries struct {
	name   string
	values []float64
	times  []time.Time // empty when no timestamp column; else aligned with values
}

// extractSeries pulls one numeric column (optionally paired with a
// timestamp column, in which case the series is sorted by time) and
// records skip counts as notes on the output.
func extractSeries(rs *models.ResultSet, column, tsColumn string, out *AnalyzeDatasetOutput) (numericSeries, error) {
	var s numericSeries
	idx, err := columnIndex(rs, column)
	if err != nil {
		return s, err
	}
	s.name = rs.Columns[idx]
	tsIdx := -1
	if tsColumn != "" {
		if tsIdx, err = columnIndex(rs, tsColumn); err != nil {
			return s, err
		}
	}
	skipped := 0
	for _, row := range rs.Rows {
		if idx >= len(row) {
			skipped++
			continue
		}
		v, ok := stats.ToFloat64(row[idx])
		if !ok {
			skipped++
			continue
		}
		if tsIdx >= 0 {
			if tsIdx >= len(row) {
				skipped++
				continue
			}
			t := stats.ParseTimestamp(row[tsIdx])
			if t.IsZero() {
				skipped++
				continue
			}
			s.times = append(s.times, t)
		}
		s.values = append(s.values, v)
	}
	if skipped > 0 {
		out.Notes = append(out.Notes, fmt.Sprintf("%d rows skipped in column %q (null, non-numeric, or unparseable timestamp)", skipped, s.name))
	}
	if len(s.times) > 0 {
		type tv struct {
			t time.Time
			v float64
		}
		pairs := make([]tv, len(s.values))
		for i := range s.values {
			pairs[i] = tv{s.times[i], s.values[i]}
		}
		sort.SliceStable(pairs, func(i, j int) bool { return pairs[i].t.Before(pairs[j].t) })
		for i, p := range pairs {
			s.times[i], s.values[i] = p.t, p.v
		}
	}
	return s, nil
}

func columnIndex(rs *models.ResultSet, name string) (int, error) {
	for i, c := range rs.Columns {
		if c == name {
			return i, nil
		}
	}
	for i, c := range rs.Columns {
		if strings.EqualFold(c, name) {
			return i, nil
		}
	}
	return -1, fmt.Errorf("column %q not found — available columns: %s", name, strings.Join(rs.Columns, ", "))
}

// sig6 rounds to six significant digits so the JSON stays compact and
// float artifacts (0.30000000000000004) never reach the model.
// NaN/Inf collapse to 0 — callers add a note when that matters.
func sig6(x float64) float64 {
	if x == 0 || math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	mag := math.Pow(10, 5-math.Floor(math.Log10(math.Abs(x))))
	return math.Round(x*mag) / mag
}

func roundBins(bins []stats.Bin) []stats.Bin {
	for i := range bins {
		bins[i].Lo = sig6(bins[i].Lo)
		bins[i].Hi = sig6(bins[i].Hi)
	}
	return bins
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
