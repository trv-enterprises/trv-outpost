// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// allowInsecureTLS is the deployment-wide gate that decides whether
// per-connection InsecureSkipVerify flags are honored. Stored as an
// int32 (0 = false, 1 = true) for lock-free reads via atomic.LoadInt32.
// Defaults to 0 (deny) and is set once at server startup via
// SetAllowInsecureTLS from cmd/server/main.go after config load.
var allowInsecureTLS int32

// SetAllowInsecureTLS is the server-level kill switch for per-connection
// TLS verification bypass. Called once at server boot from
// cmd/server/main.go with `cfg.API.AllowInsecureTLS`. When false (the
// default), every REST API adapter performs full TLS verification
// regardless of what's persisted on individual connection records.
func SetAllowInsecureTLS(allow bool) {
	if allow {
		atomic.StoreInt32(&allowInsecureTLS, 1)
		log.Printf("api adapter: insecure TLS skip is ENABLED at the server level — per-connection insecure_skip_verify flags will be honored")
	} else {
		atomic.StoreInt32(&allowInsecureTLS, 0)
	}
}

// effectiveInsecureSkipVerify returns true iff both gates are open:
// the deployment opted in via api.allow_insecure_tls AND this specific
// connection opted in via api.insecure_skip_verify. Either gate
// closed → full TLS verification (the safe default).
func effectiveInsecureSkipVerify(connWantsSkip bool) bool {
	return connWantsSkip && atomic.LoadInt32(&allowInsecureTLS) == 1
}

// IsInsecureTLSAllowed exposes the server-level kill-switch state to
// callers outside this package (e.g. the connection-test service)
// that want to log a parity warning when a per-conn flag is set but
// the deployment has not allowed it.
func IsInsecureTLSAllowed() bool {
	return atomic.LoadInt32(&allowInsecureTLS) == 1
}

// BuildAPIHTTPClient constructs the http.Client used by both the
// registry-path adapter and the legacy APIDataSource. Centralizing
// the construction keeps the two callers from drifting on TLS
// posture or timeout handling.
func BuildAPIHTTPClient(timeoutSec int, connWantsSkip bool) *http.Client {
	timeout := 30 * time.Second
	if timeoutSec > 0 {
		timeout = time.Duration(timeoutSec) * time.Second
	}
	client := &http.Client{Timeout: timeout}
	if effectiveInsecureSkipVerify(connWantsSkip) {
		client.Transport = &http.Transport{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: true}, //nolint:gosec // gated by server-wide allow + per-connection flag
		}
	}
	return client
}

func init() {
	// Register REST API adapter
	registry.Register(
		"api.rest",
		"REST API",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false},
		apiConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newAPIAdapterFromConfig(config)
		},
	)
}

// apiConfigSchema returns configuration fields for API adapter
func apiConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "url", Type: "string", Required: true, Description: "API base URL"},
		{Name: "method", Type: "string", Required: false, Default: "GET", Options: []string{"GET", "POST", "PUT", "DELETE"}, Description: "HTTP method"},
		{Name: "headers", Type: "object", Required: false, Description: "Request headers"},
		{Name: "auth_type", Type: "string", Required: false, Options: []string{"none", "bearer", "basic", "api-key"}, Description: "Authentication type"},
		{Name: "auth_credentials", Type: "object", Required: false, Description: "Auth credentials"},
		{Name: "query_params", Type: "object", Required: false, Description: "Query parameters"},
		{Name: "body", Type: "string", Required: false, Description: "Request body template"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Timeout (seconds)"},
		{Name: "retry_count", Type: "int", Required: false, Default: 3, Description: "Retry count"},
		{Name: "retry_delay", Type: "int", Required: false, Default: 1000, Description: "Retry delay (ms)"},
		{Name: "data_path", Type: "string", Required: false, Description: "JSON path to data array"},
		{Name: "insecure_skip_verify", Type: "bool", Required: false, Default: false, Description: "Skip TLS certificate verification for HTTPS endpoints (self-signed certs). Server must also have api.allow_insecure_tls enabled."},
	}
}

// APIAdapter implements registry.Adapter for REST APIs
type APIAdapter struct {
	config *models.APIConfig
	client *http.Client
}

// newAPIAdapterFromConfig creates an API adapter from config map
func newAPIAdapterFromConfig(config map[string]interface{}) (*APIAdapter, error) {
	apiConfig := &models.APIConfig{
		Method: "GET",
	}

	if url, ok := config["url"].(string); ok {
		apiConfig.URL = url
	}
	if method, ok := config["method"].(string); ok {
		apiConfig.Method = method
	}
	if headers, ok := config["headers"].(map[string]interface{}); ok {
		apiConfig.Headers = make(map[string]string)
		for k, v := range headers {
			if sv, ok := v.(string); ok {
				apiConfig.Headers[k] = sv
			}
		}
	}
	if authType, ok := config["auth_type"].(string); ok {
		apiConfig.AuthType = authType
	}
	if authCreds, ok := config["auth_credentials"].(map[string]interface{}); ok {
		apiConfig.AuthCredentials = make(map[string]string)
		for k, v := range authCreds {
			if sv, ok := v.(string); ok {
				apiConfig.AuthCredentials[k] = sv
			}
		}
	}
	if queryParams, ok := config["query_params"].(map[string]interface{}); ok {
		apiConfig.QueryParams = make(map[string]string)
		for k, v := range queryParams {
			if sv, ok := v.(string); ok {
				apiConfig.QueryParams[k] = sv
			}
		}
	}
	if body, ok := config["body"].(string); ok {
		apiConfig.Body = body
	}
	if timeout, ok := config["timeout"].(float64); ok {
		apiConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		apiConfig.Timeout = timeout
	}
	if retryCount, ok := config["retry_count"].(float64); ok {
		apiConfig.RetryCount = int(retryCount)
	} else if retryCount, ok := config["retry_count"].(int); ok {
		apiConfig.RetryCount = retryCount
	}
	if retryDelay, ok := config["retry_delay"].(float64); ok {
		apiConfig.RetryDelay = int(retryDelay)
	} else if retryDelay, ok := config["retry_delay"].(int); ok {
		apiConfig.RetryDelay = retryDelay
	}
	if dataPath, ok := config["data_path"].(string); ok {
		apiConfig.ResponseConfig = &models.APIResponseConfig{DataPath: dataPath}
	}
	if skip, ok := config["insecure_skip_verify"].(bool); ok {
		apiConfig.InsecureSkipVerify = skip
	}

	// Warn — but don't fail — when the connection asks for skip-verify
	// but the server hasn't allowed it. The connection still works
	// (with full verification); the user just sees a hint in the log
	// that their per-connection flag is being ignored.
	if apiConfig.InsecureSkipVerify && atomic.LoadInt32(&allowInsecureTLS) != 1 {
		log.Printf("api adapter %s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it", apiConfig.URL)
	}

	return &APIAdapter{
		config: apiConfig,
		client: BuildAPIHTTPClient(apiConfig.Timeout, apiConfig.InsecureSkipVerify),
	}, nil
}

// TypeID returns the adapter type identifier
func (a *APIAdapter) TypeID() string {
	return "api.rest"
}

// DisplayName returns a human-readable name
func (a *APIAdapter) DisplayName() string {
	return "REST API"
}

// Capabilities returns what this adapter can do
func (a *APIAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false}
}

// ConfigSchema returns configuration fields
func (a *APIAdapter) ConfigSchema() []registry.ConfigField {
	return apiConfigSchema()
}

// Connect is a no-op for API (stateless)
func (a *APIAdapter) Connect(ctx context.Context) error {
	return nil
}

// TestConnection verifies the API endpoint is reachable
func (a *APIAdapter) TestConnection(ctx context.Context) error {
	req, err := a.buildRequest(ctx, registry.Query{})
	if err != nil {
		return err
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		return fmt.Errorf("API returned status %d", resp.StatusCode)
	}

	return nil
}

// Close closes idle connections
func (a *APIAdapter) Close() error {
	a.client.CloseIdleConnections()
	return nil
}

// Query executes an API request and returns normalized results
func (a *APIAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	req, err := a.buildRequest(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to build request: %w", err)
	}

	var resp *http.Response
	var lastErr error

	maxRetries := a.config.RetryCount
	if maxRetries <= 0 {
		maxRetries = 1
	}

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			retryDelay := a.config.RetryDelay
			if retryDelay <= 0 {
				retryDelay = 1000
			}
			time.Sleep(time.Duration(retryDelay) * time.Millisecond)
		}

		resp, lastErr = a.client.Do(req)
		if lastErr == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			break
		}

		if resp != nil {
			resp.Body.Close()
		}
	}

	if lastErr != nil {
		return nil, fmt.Errorf("request failed after %d attempts: %w", maxRetries, lastErr)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	return a.parseResponse(body, resp.Header.Get("Content-Type"))
}

// Stream polls the API at regular intervals
func (a *APIAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	recordChan := make(chan registry.Record, 100)

	go func() {
		defer close(recordChan)

		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				resultSet, err := a.Query(ctx, query)
				if err != nil {
					continue
				}

				for _, row := range resultSet.Rows {
					record := make(registry.Record)
					for i, col := range resultSet.Columns {
						if i < len(row) {
							record[col] = row[i]
						}
					}

					select {
					case recordChan <- record:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return recordChan, nil
}

// Write is not supported for API adapter
func (a *APIAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("api.rest does not support write operations")
}

// buildRequest creates an HTTP request
func (a *APIAdapter) buildRequest(ctx context.Context, query registry.Query) (*http.Request, error) {
	url := a.config.URL
	if query.Raw != "" {
		if strings.HasPrefix(query.Raw, "/") {
			url = strings.TrimSuffix(a.config.URL, "/") + query.Raw
		} else if strings.HasPrefix(query.Raw, "http://") || strings.HasPrefix(query.Raw, "https://") {
			url = query.Raw
		} else {
			url = strings.TrimSuffix(a.config.URL, "/") + "/" + query.Raw
		}
	}

	var bodyReader io.Reader
	if a.config.Body != "" {
		bodyReader = strings.NewReader(a.config.Body)
	}

	req, err := http.NewRequestWithContext(ctx, a.config.Method, url, bodyReader)
	if err != nil {
		return nil, err
	}

	for key, value := range a.config.Headers {
		req.Header.Set(key, value)
	}

	if len(a.config.QueryParams) > 0 {
		q := req.URL.Query()
		for key, value := range a.config.QueryParams {
			q.Add(key, value)
		}
		req.URL.RawQuery = q.Encode()
	}

	if len(query.Params) > 0 {
		q := req.URL.Query()
		for key, value := range query.Params {
			q.Add(key, fmt.Sprintf("%v", value))
		}
		req.URL.RawQuery = q.Encode()
	}

	switch a.config.AuthType {
	case "bearer":
		if token := a.config.AuthCredentials["token"]; token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	case "basic":
		username := a.config.AuthCredentials["username"]
		password := a.config.AuthCredentials["password"]
		if username != "" || password != "" {
			req.SetBasicAuth(username, password)
		}
	case "api-key":
		if key := a.config.AuthCredentials["key"]; key != "" {
			headerName := a.config.AuthCredentials["header"]
			if headerName == "" {
				headerName = "X-API-Key"
			}
			req.Header.Set(headerName, key)
		}
	}

	return req, nil
}

// parseResponse parses API response into ResultSet
func (a *APIAdapter) parseResponse(body []byte, contentType string) (*registry.ResultSet, error) {
	if strings.Contains(contentType, "json") || strings.HasPrefix(string(body), "{") || strings.HasPrefix(string(body), "[") {
		var data interface{}
		if err := json.Unmarshal(body, &data); err != nil {
			return a.parseAsText(body), nil
		}

		switch v := data.(type) {
		case []interface{}:
			return a.parseJSONArray(v), nil
		case map[string]interface{}:
			return a.parseJSONObject(v), nil
		default:
			return a.parseAsPrimitive(v), nil
		}
	}

	return a.parseAsText(body), nil
}

// parseJSONArray converts JSON array to ResultSet
func (a *APIAdapter) parseJSONArray(data []interface{}) *registry.ResultSet {
	resultSet := &registry.ResultSet{
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	if len(data) == 0 {
		return resultSet
	}

	if first, ok := data[0].(map[string]interface{}); ok {
		columns := make([]string, 0, len(first))
		for key := range first {
			columns = append(columns, key)
		}
		resultSet.Columns = columns

		for _, item := range data {
			if obj, ok := item.(map[string]interface{}); ok {
				row := make([]interface{}, len(columns))
				for i, col := range columns {
					row[i] = obj[col]
				}
				resultSet.Rows = append(resultSet.Rows, row)
			}
		}
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	return resultSet
}

// parseJSONObject converts JSON object to ResultSet
func (a *APIAdapter) parseJSONObject(data map[string]interface{}) *registry.ResultSet {
	if a.config.ResponseConfig != nil && a.config.ResponseConfig.DataPath != "" {
		if extracted, ok := data[a.config.ResponseConfig.DataPath]; ok {
			if arr, ok := extracted.([]interface{}); ok {
				return a.parseJSONArray(arr)
			}
		}
	}

	resultSet := &registry.ResultSet{
		Columns:  []string{"key", "value"},
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	for key, value := range data {
		row := []interface{}{key, value}
		resultSet.Rows = append(resultSet.Rows, row)
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	return resultSet
}

// parseAsText converts plain text to ResultSet
func (a *APIAdapter) parseAsText(body []byte) *registry.ResultSet {
	return &registry.ResultSet{
		Columns: []string{"data"},
		Rows:    [][]interface{}{{string(body)}},
		Metadata: map[string]interface{}{
			"row_count": 1,
			"format":    "text",
		},
	}
}

// parseAsPrimitive converts primitive value to ResultSet
func (a *APIAdapter) parseAsPrimitive(value interface{}) *registry.ResultSet {
	return &registry.ResultSet{
		Columns: []string{"value"},
		Rows:    [][]interface{}{{value}},
		Metadata: map[string]interface{}{
			"row_count": 1,
			"format":    "primitive",
		},
	}
}

// APIDataSource implements the DataSource interface for REST APIs
type APIDataSource struct {
	config *models.APIConfig
	client *http.Client
}

// NewAPIDataSource creates a new API datasource
func NewAPIDataSource(config *models.APIConfig) (*APIDataSource, error) {
	if config.InsecureSkipVerify && atomic.LoadInt32(&allowInsecureTLS) != 1 {
		log.Printf("api datasource %s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it", config.URL)
	}
	return &APIDataSource{
		config: config,
		client: BuildAPIHTTPClient(config.Timeout, config.InsecureSkipVerify),
	}, nil
}

// Query executes an API request and returns normalized results
func (a *APIDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Build request
	req, err := a.buildRequest(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to build request: %w", err)
	}

	// Execute request with retries
	var resp *http.Response
	var lastErr error

	maxRetries := a.config.RetryCount
	if maxRetries <= 0 {
		maxRetries = 1 // At least one attempt
	}

	for attempt := 0; attempt < maxRetries; attempt++ {
		if attempt > 0 {
			// Wait before retry
			retryDelay := a.config.RetryDelay
			if retryDelay <= 0 {
				retryDelay = 1000 // default 1 second
			}
			time.Sleep(time.Duration(retryDelay) * time.Millisecond)
		}

		resp, lastErr = a.client.Do(req)
		if lastErr == nil && resp.StatusCode >= 200 && resp.StatusCode < 300 {
			break
		}

		if resp != nil {
			resp.Body.Close()
		}
	}

	if lastErr != nil {
		return nil, fmt.Errorf("request failed after %d attempts: %w", maxRetries, lastErr)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, resp.Status)
	}

	// Read response body
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	// Parse response and normalize
	return a.parseResponse(body, resp.Header.Get("Content-Type"))
}

// Stream is not typically used for API datasources
// But can be implemented for polling-based streaming
func (a *APIDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	recordChan := make(chan models.Record, 100)

	go func() {
		defer close(recordChan)

		// Poll API at regular intervals
		ticker := time.NewTicker(5 * time.Second) // TODO: Make configurable
		defer ticker.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				resultSet, err := a.Query(ctx, query)
				if err != nil {
					continue
				}

				// Convert result set to records
				for _, row := range resultSet.Rows {
					record := make(models.Record)
					for i, col := range resultSet.Columns {
						if i < len(row) {
							record[col] = row[i]
						}
					}

					select {
					case recordChan <- record:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return recordChan, nil
}

// buildRequest creates an HTTP request with all configured options
func (a *APIDataSource) buildRequest(ctx context.Context, query models.Query) (*http.Request, error) {
	// Use config URL as base, append query.Raw as path if it starts with /
	url := a.config.URL
	if query.Raw != "" {
		if strings.HasPrefix(query.Raw, "/") {
			// Append path to base URL
			url = strings.TrimSuffix(a.config.URL, "/") + query.Raw
		} else if strings.HasPrefix(query.Raw, "http://") || strings.HasPrefix(query.Raw, "https://") {
			// Full URL override
			url = query.Raw
		} else {
			// Treat as path segment
			url = strings.TrimSuffix(a.config.URL, "/") + "/" + query.Raw
		}
	}

	// Create request body
	var bodyReader io.Reader
	if a.config.Body != "" {
		bodyReader = strings.NewReader(a.config.Body)
	}

	req, err := http.NewRequestWithContext(ctx, a.config.Method, url, bodyReader)
	if err != nil {
		return nil, err
	}

	// Add headers
	for key, value := range a.config.Headers {
		req.Header.Set(key, value)
	}

	// Add query parameters
	if len(a.config.QueryParams) > 0 {
		q := req.URL.Query()
		for key, value := range a.config.QueryParams {
			q.Add(key, value)
		}
		req.URL.RawQuery = q.Encode()
	}

	// Add query params from Query object
	if len(query.Params) > 0 {
		q := req.URL.Query()
		for key, value := range query.Params {
			q.Add(key, fmt.Sprintf("%v", value))
		}
		req.URL.RawQuery = q.Encode()
	}

	// Add authentication
	switch a.config.AuthType {
	case "bearer":
		if token := a.config.AuthCredentials["token"]; token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
	case "basic":
		username := a.config.AuthCredentials["username"]
		password := a.config.AuthCredentials["password"]
		if username != "" || password != "" {
			req.SetBasicAuth(username, password)
		}
	case "api-key":
		if key := a.config.AuthCredentials["key"]; key != "" {
			headerName := a.config.AuthCredentials["header"]
			if headerName == "" {
				headerName = "X-API-Key"
			}
			req.Header.Set(headerName, key)
		}
	}

	return req, nil
}

// parseResponse parses API response and converts to ResultSet
func (a *APIDataSource) parseResponse(body []byte, contentType string) (*models.ResultSet, error) {
	// Try to parse as JSON
	if strings.Contains(contentType, "json") || strings.HasPrefix(string(body), "{") || strings.HasPrefix(string(body), "[") {
		var data interface{}
		if err := json.Unmarshal(body, &data); err != nil {
			// Fallback to text
			return a.parseAsText(body), nil
		}

		// Handle different JSON structures
		switch v := data.(type) {
		case []interface{}:
			// Array of objects
			return a.parseJSONArray(v), nil
		case map[string]interface{}:
			// Single object or nested structure
			return a.parseJSONObject(v), nil
		default:
			// Primitive value
			return a.parseAsPrimitive(v), nil
		}
	}

	// Default to text
	return a.parseAsText(body), nil
}

// parseJSONArray converts JSON array to ResultSet
func (a *APIDataSource) parseJSONArray(data []interface{}) *models.ResultSet {
	resultSet := &models.ResultSet{
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	if len(data) == 0 {
		return resultSet
	}

	// Extract columns from first object
	if first, ok := data[0].(map[string]interface{}); ok {
		columns := make([]string, 0, len(first))
		for key := range first {
			columns = append(columns, key)
		}
		resultSet.Columns = columns

		// Convert each object to row
		for _, item := range data {
			if obj, ok := item.(map[string]interface{}); ok {
				row := make([]interface{}, len(columns))
				for i, col := range columns {
					row[i] = obj[col]
				}
				resultSet.Rows = append(resultSet.Rows, row)
			}
		}
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	return resultSet
}

// parseJSONObject converts JSON object to ResultSet
func (a *APIDataSource) parseJSONObject(data map[string]interface{}) *models.ResultSet {
	// Check if there's a DataPath configured to extract array from object
	if a.config.ResponseConfig != nil && a.config.ResponseConfig.DataPath != "" {
		if extracted, ok := data[a.config.ResponseConfig.DataPath]; ok {
			if arr, ok := extracted.([]interface{}); ok {
				// Found the array at the configured path, parse it
				return a.parseJSONArray(arr)
			}
		}
	}

	// Default behavior: convert object to key-value pairs
	resultSet := &models.ResultSet{
		Columns:  []string{"key", "value"},
		Rows:     make([][]interface{}, 0),
		Metadata: make(map[string]interface{}),
	}

	for key, value := range data {
		row := []interface{}{key, value}
		resultSet.Rows = append(resultSet.Rows, row)
	}

	resultSet.Metadata["row_count"] = len(resultSet.Rows)
	return resultSet
}

// parseAsText converts plain text to ResultSet
func (a *APIDataSource) parseAsText(body []byte) *models.ResultSet {
	return &models.ResultSet{
		Columns: []string{"data"},
		Rows:    [][]interface{}{{string(body)}},
		Metadata: map[string]interface{}{
			"row_count": 1,
			"format":    "text",
		},
	}
}

// parseAsPrimitive converts primitive value to ResultSet
func (a *APIDataSource) parseAsPrimitive(value interface{}) *models.ResultSet {
	return &models.ResultSet{
		Columns: []string{"value"},
		Rows:    [][]interface{}{{value}},
		Metadata: map[string]interface{}{
			"row_count": 1,
			"format":    "primitive",
		},
	}
}

// Close closes any open resources
func (a *APIDataSource) Close() error {
	// HTTP client doesn't require explicit closing
	a.client.CloseIdleConnections()
	return nil
}
