// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register Prometheus adapter
	registry.Register(
		"api.prometheus",
		"Prometheus",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		prometheusConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newPrometheusAdapterFromConfig(config)
		},
	)
}

// prometheusConfigSchema returns configuration fields for Prometheus adapter
func prometheusConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "url", Type: "string", Required: true, Description: "Prometheus server URL"},
		{Name: "username", Type: "string", Required: false, Description: "Basic auth username"},
		{Name: "password", Type: "password", Required: false, Description: "Basic auth password"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Query timeout (seconds)"},
	}
}

// PrometheusAdapter implements registry.Adapter for Prometheus
type PrometheusAdapter struct {
	config *models.PrometheusConfig
	client *http.Client
}

// newPrometheusAdapterFromConfig creates a Prometheus adapter from config map
func newPrometheusAdapterFromConfig(config map[string]interface{}) (*PrometheusAdapter, error) {
	promConfig := &models.PrometheusConfig{}

	if url, ok := config["url"].(string); ok {
		promConfig.URL = url
	}
	if username, ok := config["username"].(string); ok {
		promConfig.Username = username
	}
	if password, ok := config["password"].(string); ok {
		promConfig.Password = password
	}
	if timeout, ok := config["timeout"].(float64); ok {
		promConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		promConfig.Timeout = timeout
	}

	httpTimeout := 30 * time.Second
	if promConfig.Timeout > 0 {
		httpTimeout = time.Duration(promConfig.Timeout) * time.Second
	}

	return &PrometheusAdapter{
		config: promConfig,
		client: &http.Client{Timeout: httpTimeout},
	}, nil
}

// TypeID returns the adapter type identifier
func (a *PrometheusAdapter) TypeID() string {
	return "api.prometheus"
}

// DisplayName returns a human-readable name
func (a *PrometheusAdapter) DisplayName() string {
	return "Prometheus"
}

// Capabilities returns what this adapter can do
func (a *PrometheusAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *PrometheusAdapter) ConfigSchema() []registry.ConfigField {
	return prometheusConfigSchema()
}

// Connect tests connection to Prometheus
func (a *PrometheusAdapter) Connect(ctx context.Context) error {
	return a.TestConnection(ctx)
}

// TestConnection tests the connection to Prometheus
func (a *PrometheusAdapter) TestConnection(ctx context.Context) error {
	endpoint := strings.TrimSuffix(a.config.URL, "/") + "/api/v1/labels"

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	if a.config.Username != "" || a.config.Password != "" {
		req.SetBasicAuth(a.config.Username, a.config.Password)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("prometheus returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// Close is a no-op for Prometheus
func (a *PrometheusAdapter) Close() error {
	return nil
}

// Query executes a PromQL query
func (a *PrometheusAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	params := models.PrometheusQueryParams{
		QueryType: models.PrometheusQueryTypeRange,
		Start:     "now-1h",
		End:       "now",
		Step:      "1m",
	}

	if query.Params != nil {
		if qt, ok := query.Params["query_type"].(string); ok {
			params.QueryType = models.PrometheusQueryType(qt)
		}
		if start, ok := query.Params["start"].(string); ok {
			params.Start = start
		}
		if end, ok := query.Params["end"].(string); ok {
			params.End = end
		}
		if step, ok := query.Params["step"].(string); ok {
			params.Step = step
		}
	}

	if params.QueryType == models.PrometheusQueryTypeInstant {
		return a.executeInstantQueryRegistry(ctx, query.Raw, params)
	}
	return a.executeRangeQueryRegistry(ctx, query.Raw, params)
}

// Stream polls Prometheus at regular intervals
func (a *PrometheusAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	ch := make(chan registry.Record, 100)

	interval := 15 * time.Second
	if query.Params != nil {
		if step, ok := query.Params["step"].(string); ok {
			if d, err := time.ParseDuration(step); err == nil {
				interval = d
			}
		}
	}

	go func() {
		defer close(ch)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				result, err := a.executeInstantQueryRegistry(ctx, query.Raw, models.PrometheusQueryParams{
					QueryType: models.PrometheusQueryTypeInstant,
					End:       "now",
				})
				if err != nil {
					continue
				}

				for _, row := range result.Rows {
					record := make(registry.Record)
					for i, col := range result.Columns {
						if i < len(row) {
							record[col] = row[i]
						}
					}
					select {
					case ch <- record:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return ch, nil
}

// Write is not supported for Prometheus
func (a *PrometheusAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("api.prometheus does not support write operations")
}

// executeRangeQueryRegistry executes a range query
func (a *PrometheusAdapter) executeRangeQueryRegistry(ctx context.Context, promQL string, params models.PrometheusQueryParams) (*registry.ResultSet, error) {
	endpoint := strings.TrimSuffix(a.config.URL, "/") + "/api/v1/query_range"

	startTime, err := a.parseTimeInternal(params.Start)
	if err != nil {
		return nil, fmt.Errorf("invalid start time: %w", err)
	}
	endTime, err := a.parseTimeInternal(params.End)
	if err != nil {
		return nil, fmt.Errorf("invalid end time: %w", err)
	}

	queryParams := url.Values{}
	queryParams.Set("query", promQL)
	queryParams.Set("start", strconv.FormatInt(startTime.Unix(), 10))
	queryParams.Set("end", strconv.FormatInt(endTime.Unix(), 10))
	queryParams.Set("step", params.Step)

	reqURL := endpoint + "?" + queryParams.Encode()
	resp, err := a.doRequestInternal(ctx, reqURL)
	if err != nil {
		return nil, err
	}

	return a.parseQueryResultRegistry(resp, true)
}

// executeInstantQueryRegistry executes an instant query
func (a *PrometheusAdapter) executeInstantQueryRegistry(ctx context.Context, promQL string, params models.PrometheusQueryParams) (*registry.ResultSet, error) {
	endpoint := strings.TrimSuffix(a.config.URL, "/") + "/api/v1/query"

	evalTime, err := a.parseTimeInternal(params.End)
	if err != nil {
		return nil, fmt.Errorf("invalid time: %w", err)
	}

	queryParams := url.Values{}
	queryParams.Set("query", promQL)
	queryParams.Set("time", strconv.FormatInt(evalTime.Unix(), 10))

	reqURL := endpoint + "?" + queryParams.Encode()
	resp, err := a.doRequestInternal(ctx, reqURL)
	if err != nil {
		return nil, err
	}

	return a.parseQueryResultRegistry(resp, false)
}

// parseTimeInternal parses time formats
func (a *PrometheusAdapter) parseTimeInternal(timeStr string) (time.Time, error) {
	return parsePromTime(timeStr)
}

// doRequestInternal executes an HTTP request
func (a *PrometheusAdapter) doRequestInternal(ctx context.Context, reqURL string) (*prometheusResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	if a.config.Username != "" || a.config.Password != "" {
		req.SetBasicAuth(a.config.Username, a.config.Password)
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus returned status %d: %s", resp.StatusCode, string(body))
	}

	var promResp prometheusResponse
	if err := json.Unmarshal(body, &promResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if promResp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s - %s", promResp.ErrorType, promResp.Error)
	}

	return &promResp, nil
}

// parseQueryResultRegistry parses Prometheus result into registry.ResultSet
func (a *PrometheusAdapter) parseQueryResultRegistry(resp *prometheusResponse, isRangeQuery bool) (*registry.ResultSet, error) {
	var queryResult prometheusQueryResult
	if err := json.Unmarshal(resp.Data, &queryResult); err != nil {
		return nil, fmt.Errorf("failed to parse query result: %w", err)
	}

	labelNames := make(map[string]bool)
	var series []prometheusSeries

	for _, raw := range queryResult.Result {
		var s prometheusSeries
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		series = append(series, s)
		for labelName := range s.Metric {
			labelNames[labelName] = true
		}
	}

	columns := []string{"timestamp", "value"}
	sortedLabels := make([]string, 0, len(labelNames))
	for name := range labelNames {
		sortedLabels = append(sortedLabels, name)
	}
	for i := 0; i < len(sortedLabels)-1; i++ {
		for j := i + 1; j < len(sortedLabels); j++ {
			if sortedLabels[i] > sortedLabels[j] {
				sortedLabels[i], sortedLabels[j] = sortedLabels[j], sortedLabels[i]
			}
		}
	}
	columns = append(columns, sortedLabels...)

	var rows [][]interface{}

	for _, s := range series {
		if isRangeQuery {
			for _, v := range s.Values {
				if len(v) < 2 {
					continue
				}
				row := a.buildRowRegistry(v[0], v[1], s.Metric, sortedLabels)
				rows = append(rows, row)
			}
		} else {
			if len(s.Value) >= 2 {
				row := a.buildRowRegistry(s.Value[0], s.Value[1], s.Metric, sortedLabels)
				rows = append(rows, row)
			}
		}
	}

	return &registry.ResultSet{
		Columns: columns,
		Rows:    rows,
		Metadata: map[string]interface{}{
			"result_type": queryResult.ResultType,
			"row_count":   len(rows),
		},
	}, nil
}

// buildRowRegistry creates a row
func (a *PrometheusAdapter) buildRowRegistry(timestamp, value interface{}, metric map[string]string, labelOrder []string) []interface{} {
	var ts int64
	switch t := timestamp.(type) {
	case float64:
		ts = int64(t)
	case int64:
		ts = t
	case int:
		ts = int64(t)
	}

	var val float64
	switch v := value.(type) {
	case string:
		val, _ = strconv.ParseFloat(v, 64)
	case float64:
		val = v
	}

	row := make([]interface{}, 2+len(labelOrder))
	row[0] = ts
	row[1] = val

	for i, labelName := range labelOrder {
		if labelValue, ok := metric[labelName]; ok {
			row[2+i] = labelValue
		} else {
			row[2+i] = ""
		}
	}

	return row
}

// GetMetricsAdapter returns all metric names
func (a *PrometheusAdapter) GetMetricsAdapter(ctx context.Context) ([]string, error) {
	endpoint := strings.TrimSuffix(a.config.URL, "/") + "/api/v1/label/__name__/values"
	resp, err := a.doRequestInternal(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var metrics []string
	if err := json.Unmarshal(resp.Data, &metrics); err != nil {
		return nil, fmt.Errorf("failed to parse metrics: %w", err)
	}
	return metrics, nil
}

// GetLabelsAdapter returns all label names
func (a *PrometheusAdapter) GetLabelsAdapter(ctx context.Context) ([]string, error) {
	endpoint := strings.TrimSuffix(a.config.URL, "/") + "/api/v1/labels"
	resp, err := a.doRequestInternal(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var labels []string
	if err := json.Unmarshal(resp.Data, &labels); err != nil {
		return nil, fmt.Errorf("failed to parse labels: %w", err)
	}
	return labels, nil
}

// PrometheusDataSource implements the DataSource interface for Prometheus
type PrometheusDataSource struct {
	config *models.PrometheusConfig
	client *http.Client
}

// prometheusResponse represents the common Prometheus API response structure
type prometheusResponse struct {
	Status    string          `json:"status"`
	Data      json.RawMessage `json:"data"`
	ErrorType string          `json:"errorType,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// prometheusQueryResult represents the data field for query results
type prometheusQueryResult struct {
	ResultType string            `json:"resultType"` // "matrix", "vector", "scalar", "string"
	Result     []json.RawMessage `json:"result"`
}

// prometheusSeries represents a single time series in the result
type prometheusSeries struct {
	Metric map[string]string `json:"metric"`
	Values [][]interface{}   `json:"values"` // For range queries: [[timestamp, value], ...]
	Value  []interface{}     `json:"value"`  // For instant queries: [timestamp, value]
}

// NewPrometheusDataSource creates a new Prometheus data source
func NewPrometheusDataSource(config *models.PrometheusConfig) (*PrometheusDataSource, error) {
	timeout := 30 * time.Second
	if config.Timeout > 0 {
		timeout = time.Duration(config.Timeout) * time.Second
	}

	client := &http.Client{
		Timeout: timeout,
	}

	return &PrometheusDataSource{
		config: config,
		client: client,
	}, nil
}

// Query executes a PromQL query and returns normalized results
func (p *PrometheusDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Parse query parameters
	params := models.PrometheusQueryParams{
		QueryType: models.PrometheusQueryTypeRange, // Default to range query
		Start:     "now-1h",
		End:       "now",
		Step:      "1m",
	}

	if query.Params != nil {
		if qt, ok := query.Params["query_type"].(string); ok {
			params.QueryType = models.PrometheusQueryType(qt)
		}
		if start, ok := query.Params["start"].(string); ok {
			params.Start = start
		}
		if end, ok := query.Params["end"].(string); ok {
			params.End = end
		}
		if step, ok := query.Params["step"].(string); ok {
			params.Step = step
		}
	}

	// Execute appropriate query type
	if params.QueryType == models.PrometheusQueryTypeInstant {
		return p.executeInstantQuery(ctx, query.Raw, params)
	}
	return p.executeRangeQuery(ctx, query.Raw, params)
}

// executeRangeQuery executes a range query and returns time series data
func (p *PrometheusDataSource) executeRangeQuery(ctx context.Context, promQL string, params models.PrometheusQueryParams) (*models.ResultSet, error) {
	// Build URL
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/query_range"

	// Parse time values
	startTime, err := p.parseTime(params.Start)
	if err != nil {
		return nil, fmt.Errorf("invalid start time: %w", err)
	}
	endTime, err := p.parseTime(params.End)
	if err != nil {
		return nil, fmt.Errorf("invalid end time: %w", err)
	}

	// Build query parameters
	queryParams := url.Values{}
	queryParams.Set("query", promQL)
	queryParams.Set("start", strconv.FormatInt(startTime.Unix(), 10))
	queryParams.Set("end", strconv.FormatInt(endTime.Unix(), 10))
	queryParams.Set("step", params.Step)

	reqURL := endpoint + "?" + queryParams.Encode()

	// Execute request
	resp, err := p.doRequest(ctx, reqURL)
	if err != nil {
		return nil, err
	}

	// Parse result
	return p.parseQueryResult(resp, true)
}

// executeInstantQuery executes an instant query and returns current values
func (p *PrometheusDataSource) executeInstantQuery(ctx context.Context, promQL string, params models.PrometheusQueryParams) (*models.ResultSet, error) {
	// Build URL
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/query"

	// Parse time (use end time for instant query)
	evalTime, err := p.parseTime(params.End)
	if err != nil {
		return nil, fmt.Errorf("invalid time: %w", err)
	}

	// Build query parameters
	queryParams := url.Values{}
	queryParams.Set("query", promQL)
	queryParams.Set("time", strconv.FormatInt(evalTime.Unix(), 10))

	reqURL := endpoint + "?" + queryParams.Encode()

	// Execute request
	resp, err := p.doRequest(ctx, reqURL)
	if err != nil {
		return nil, err
	}

	// Parse result
	return p.parseQueryResult(resp, false)
}

// parseTime parses various time formats: RFC3339, unix timestamp, or relative (now-1h)
func (p *PrometheusDataSource) parseTime(timeStr string) (time.Time, error) {
	return parsePromTime(timeStr)
}

// parsePromTime is the shared time-string parser used by both
// PrometheusAdapter and PrometheusDataSource. It accepts:
//
//   - "now", "now-1h", "now+5m"  — relative to the current instant
//   - "-1h", "+30m", "1h"        — bare durations, treated as offsets
//     from now (unsigned = past)
//   - Unix seconds as an integer
//   - RFC3339
//   - "2006-01-02T15:04:05" / "2006-01-02 15:04:05" / "2006-01-02"
//
// The bare-duration form matters for agent compatibility — LLMs and
// humans both commonly write "-1h" when they mean "one hour ago," and
// rejecting that form is a pointless papercut.
func parsePromTime(timeStr string) (time.Time, error) {
	timeStr = strings.TrimSpace(timeStr)
	if timeStr == "" {
		return time.Time{}, fmt.Errorf("empty time string")
	}

	// "now" / "now-..." / "now+..."
	if strings.HasPrefix(timeStr, "now") {
		now := time.Now()
		if timeStr == "now" {
			return now, nil
		}
		offset := strings.TrimPrefix(timeStr, "now")
		if len(offset) > 0 {
			if offset[0] == '-' {
				d, err := time.ParseDuration(offset[1:])
				if err != nil {
					return time.Time{}, fmt.Errorf("invalid duration: %s", offset)
				}
				return now.Add(-d), nil
			}
			if offset[0] == '+' {
				d, err := time.ParseDuration(offset[1:])
				if err != nil {
					return time.Time{}, fmt.Errorf("invalid duration: %s", offset)
				}
				return now.Add(d), nil
			}
		}
		return now, nil
	}

	// Bare duration: "-1h", "+30m", "1h". Treat as offset from now
	// (unsigned = past, to match Grafana / most monitoring UIs).
	if timeStr[0] == '-' || timeStr[0] == '+' {
		if d, err := time.ParseDuration(timeStr[1:]); err == nil {
			now := time.Now()
			if timeStr[0] == '-' {
				return now.Add(-d), nil
			}
			return now.Add(d), nil
		}
	}
	if d, err := time.ParseDuration(timeStr); err == nil {
		// "1h" style — ambiguous, but "past 1h" is the overwhelmingly
		// common intent in dashboard query params.
		return time.Now().Add(-d), nil
	}

	if ts, err := strconv.ParseInt(timeStr, 10, 64); err == nil {
		return time.Unix(ts, 0), nil
	}

	if t, err := time.Parse(time.RFC3339, timeStr); err == nil {
		return t, nil
	}

	for _, format := range []string{"2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(format, timeStr); err == nil {
			return t, nil
		}
	}

	return time.Time{}, fmt.Errorf("unrecognized time format: %s", timeStr)
}

// doRequest executes an HTTP request to Prometheus
func (p *PrometheusDataSource) doRequest(ctx context.Context, reqURL string) (*prometheusResponse, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	// Add basic auth if configured
	if p.config.Username != "" || p.config.Password != "" {
		req.SetBasicAuth(p.config.Username, p.config.Password)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus returned status %d: %s", resp.StatusCode, string(body))
	}

	var promResp prometheusResponse
	if err := json.Unmarshal(body, &promResp); err != nil {
		return nil, fmt.Errorf("failed to parse response: %w", err)
	}

	if promResp.Status != "success" {
		return nil, fmt.Errorf("prometheus error: %s - %s", promResp.ErrorType, promResp.Error)
	}

	return &promResp, nil
}

// parseQueryResult parses Prometheus query result into normalized ResultSet
func (p *PrometheusDataSource) parseQueryResult(resp *prometheusResponse, isRangeQuery bool) (*models.ResultSet, error) {
	var queryResult prometheusQueryResult
	if err := json.Unmarshal(resp.Data, &queryResult); err != nil {
		return nil, fmt.Errorf("failed to parse query result: %w", err)
	}

	// Collect all unique label names across all series
	labelNames := make(map[string]bool)
	var series []prometheusSeries

	for _, raw := range queryResult.Result {
		var s prometheusSeries
		if err := json.Unmarshal(raw, &s); err != nil {
			continue
		}
		series = append(series, s)

		for labelName := range s.Metric {
			labelNames[labelName] = true
		}
	}

	// Build columns: timestamp, value, then sorted label names
	columns := []string{"timestamp", "value"}
	sortedLabels := make([]string, 0, len(labelNames))
	for name := range labelNames {
		sortedLabels = append(sortedLabels, name)
	}
	// Sort for consistent column order
	for i := 0; i < len(sortedLabels)-1; i++ {
		for j := i + 1; j < len(sortedLabels); j++ {
			if sortedLabels[i] > sortedLabels[j] {
				sortedLabels[i], sortedLabels[j] = sortedLabels[j], sortedLabels[i]
			}
		}
	}
	columns = append(columns, sortedLabels...)

	// Build rows
	var rows [][]interface{}

	for _, s := range series {
		if isRangeQuery {
			// Range query: multiple values per series
			for _, v := range s.Values {
				if len(v) < 2 {
					continue
				}
				row := p.buildRow(v[0], v[1], s.Metric, sortedLabels)
				rows = append(rows, row)
			}
		} else {
			// Instant query: single value per series
			if len(s.Value) >= 2 {
				row := p.buildRow(s.Value[0], s.Value[1], s.Metric, sortedLabels)
				rows = append(rows, row)
			}
		}
	}

	return &models.ResultSet{
		Columns: columns,
		Rows:    rows,
		Metadata: map[string]interface{}{
			"result_type": queryResult.ResultType,
			"row_count":   len(rows),
		},
	}, nil
}

// buildRow creates a row from timestamp, value, and labels
func (p *PrometheusDataSource) buildRow(timestamp, value interface{}, metric map[string]string, labelOrder []string) []interface{} {
	// Parse timestamp (Prometheus returns float64 unix timestamp)
	var ts int64
	switch t := timestamp.(type) {
	case float64:
		ts = int64(t)
	case int64:
		ts = t
	case int:
		ts = int64(t)
	}

	// Parse value (Prometheus returns string values)
	var val float64
	switch v := value.(type) {
	case string:
		val, _ = strconv.ParseFloat(v, 64)
	case float64:
		val = v
	}

	// Build row: timestamp, value, labels...
	row := make([]interface{}, 2+len(labelOrder))
	row[0] = ts
	row[1] = val

	for i, labelName := range labelOrder {
		if labelValue, ok := metric[labelName]; ok {
			row[2+i] = labelValue
		} else {
			row[2+i] = ""
		}
	}

	return row
}

// Stream implements polling-based streaming for Prometheus
// Executes instant queries at regular intervals
func (p *PrometheusDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	ch := make(chan models.Record, 100)

	// Get polling interval from params (default: 15 seconds)
	interval := 15 * time.Second
	if query.Params != nil {
		if step, ok := query.Params["step"].(string); ok {
			if d, err := time.ParseDuration(step); err == nil {
				interval = d
			}
		}
	}

	go func() {
		defer close(ch)

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				// Execute instant query
				result, err := p.executeInstantQuery(ctx, query.Raw, models.PrometheusQueryParams{
					QueryType: models.PrometheusQueryTypeInstant,
					End:       "now",
				})
				if err != nil {
					continue
				}

				// Convert each row to a record
				for _, row := range result.Rows {
					record := make(models.Record)
					for i, col := range result.Columns {
						if i < len(row) {
							record[col] = row[i]
						}
					}
					select {
					case ch <- record:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return ch, nil
}

// Close closes the data source
func (p *PrometheusDataSource) Close() error {
	// HTTP client doesn't need explicit closing
	return nil
}

// TestConnection tests the connection to Prometheus
func (p *PrometheusDataSource) TestConnection(ctx context.Context) error {
	// Use /api/v1/labels - universally supported across Prometheus-compatible servers
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/labels"

	req, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	if p.config.Username != "" || p.config.Password != "" {
		req.SetBasicAuth(p.config.Username, p.config.Password)
	}

	resp, err := p.client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("prometheus returned status %d: %s", resp.StatusCode, string(body))
	}

	return nil
}

// GetMetrics returns a list of all metric names
func (p *PrometheusDataSource) GetMetrics(ctx context.Context) ([]string, error) {
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/label/__name__/values"

	resp, err := p.doRequest(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var metrics []string
	if err := json.Unmarshal(resp.Data, &metrics); err != nil {
		return nil, fmt.Errorf("failed to parse metrics: %w", err)
	}

	return metrics, nil
}

// GetLabels returns a list of all label names
func (p *PrometheusDataSource) GetLabels(ctx context.Context) ([]string, error) {
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/labels"

	resp, err := p.doRequest(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var labels []string
	if err := json.Unmarshal(resp.Data, &labels); err != nil {
		return nil, fmt.Errorf("failed to parse labels: %w", err)
	}

	return labels, nil
}

// GetLabelValues returns values for a specific label
func (p *PrometheusDataSource) GetLabelValues(ctx context.Context, labelName string) ([]string, error) {
	endpoint := strings.TrimSuffix(p.config.URL, "/") + "/api/v1/label/" + url.PathEscape(labelName) + "/values"

	resp, err := p.doRequest(ctx, endpoint)
	if err != nil {
		return nil, err
	}

	var values []string
	if err := json.Unmarshal(resp.Data, &values); err != nil {
		return nil, fmt.Errorf("failed to parse label values: %w", err)
	}

	return values, nil
}
