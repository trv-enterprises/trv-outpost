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
	"net/http/httputil"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register EdgeLake adapter
	registry.Register(
		"api.edgelake",
		"EdgeLake",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false},
		edgelakeConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newEdgeLakeAdapterFromConfig(config)
		},
	)
}

// edgelakeConfigSchema returns configuration fields for EdgeLake adapter
func edgelakeConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "host", Type: "string", Required: true, Description: "EdgeLake node host"},
		{Name: "port", Type: "int", Required: true, Description: "REST API port"},
		{Name: "timeout", Type: "int", Required: false, Default: 20, Description: "Request timeout (seconds)"},
		{Name: "use_distributed_query", Type: "bool", Required: false, Default: false, Description: "Use distributed queries"},
	}
}

// EdgeLakeAdapter implements registry.Adapter for EdgeLake
type EdgeLakeAdapter struct {
	config *models.EdgeLakeConfig
	client *http.Client
}

// newEdgeLakeAdapterFromConfig creates an EdgeLake adapter from config map
func newEdgeLakeAdapterFromConfig(config map[string]interface{}) (*EdgeLakeAdapter, error) {
	elConfig := &models.EdgeLakeConfig{}

	if host, ok := config["host"].(string); ok {
		elConfig.Host = host
	}
	if port, ok := config["port"].(float64); ok {
		elConfig.Port = int(port)
	} else if port, ok := config["port"].(int); ok {
		elConfig.Port = port
	}
	if timeout, ok := config["timeout"].(float64); ok {
		elConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		elConfig.Timeout = timeout
	}
	if distributed, ok := config["use_distributed_query"].(bool); ok {
		elConfig.UseDistributedQuery = distributed
	}

	httpTimeout := 20 * time.Second
	if elConfig.Timeout > 0 {
		httpTimeout = time.Duration(elConfig.Timeout) * time.Second
	}

	return &EdgeLakeAdapter{
		config: elConfig,
		client: &http.Client{Timeout: httpTimeout},
	}, nil
}

// TypeID returns the adapter type identifier
func (a *EdgeLakeAdapter) TypeID() string {
	return "api.edgelake"
}

// DisplayName returns a human-readable name
func (a *EdgeLakeAdapter) DisplayName() string {
	return "EdgeLake"
}

// Capabilities returns what this adapter can do
func (a *EdgeLakeAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: false}
}

// ConfigSchema returns configuration fields
func (a *EdgeLakeAdapter) ConfigSchema() []registry.ConfigField {
	return edgelakeConfigSchema()
}

// Connect tests connection to EdgeLake
func (a *EdgeLakeAdapter) Connect(ctx context.Context) error {
	return a.TestConnection(ctx)
}

// TestConnection tests the connection to EdgeLake
func (a *EdgeLakeAdapter) TestConnection(ctx context.Context) error {
	_, err := a.executeCommandInternal(ctx, "get status", false)
	return err
}

// Close is a no-op for EdgeLake
func (a *EdgeLakeAdapter) Close() error {
	return nil
}

// Query executes a SQL query against EdgeLake
func (a *EdgeLakeAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	if query.Raw == "" {
		return nil, fmt.Errorf("query is required")
	}

	database := ""
	if query.Params != nil {
		if db, ok := query.Params["database"].(string); ok {
			database = db
		}
	}
	if database == "" {
		return nil, fmt.Errorf("database parameter is required for EdgeLake queries")
	}

	command := fmt.Sprintf(`sql %s format = json "%s"`, database, query.Raw)

	distributed := a.config.UseDistributedQuery
	if query.Params != nil {
		if dist, ok := query.Params["distributed"].(bool); ok {
			distributed = dist
		}
	}

	body, err := a.executeCommandInternal(ctx, command, distributed)
	if err != nil {
		return nil, err
	}

	return a.parseQueryResponseRegistry(body)
}

// Stream is not supported for EdgeLake
func (a *EdgeLakeAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	return nil, fmt.Errorf("streaming is not supported for EdgeLake; use refresh interval for periodic updates")
}

// Write is not supported for EdgeLake
func (a *EdgeLakeAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("api.edgelake does not support write operations")
}

// baseURLInternal returns the base URL
func (a *EdgeLakeAdapter) baseURLInternal() string {
	return fmt.Sprintf("http://%s:%d", a.config.Host, a.config.Port)
}

// executeCommandInternal sends a command to EdgeLake
func (a *EdgeLakeAdapter) executeCommandInternal(ctx context.Context, command string, distributed bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", a.baseURLInternal(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", "anylog")
	req.Header.Set("command", command)

	if distributed {
		req.Header.Set("destination", "network")
	}

	resp, err := a.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("EdgeLake returned status %d: %s", resp.StatusCode, string(body))
	}

	// EdgeLake uses HTTP/1.0 with chunked transfer encoding, which Go doesn't
	// auto-dechunk. Strip chunk size prefixes if present.
	body = decodeChunkedBody(body)

	return body, nil
}

// decodeChunkedBody handles HTTP/1.0 responses that incorrectly use chunked transfer encoding.
// Go's http.Client doesn't auto-dechunk HTTP/1.0 bodies, so chunk size prefixes leak into the data.
// This detects and strips them using Go's built-in chunked reader.
func decodeChunkedBody(body []byte) []byte {
	// Quick check: if the body starts with a valid JSON character, it's not chunked
	trimmed := strings.TrimSpace(string(body))
	if len(trimmed) > 0 && (trimmed[0] == '{' || trimmed[0] == '[' || trimmed[0] == '"') {
		return body
	}

	// Use Go's built-in chunked reader to decode
	reader := httputil.NewChunkedReader(strings.NewReader(string(body)))
	decoded, err := io.ReadAll(reader)
	if err != nil || len(decoded) == 0 {
		// Not chunked or decode failed — return original
		return body
	}
	return decoded
}

// parseQueryResponseRegistry parses EdgeLake response into registry.ResultSet
func (a *EdgeLakeAdapter) parseQueryResponseRegistry(body []byte) (*registry.ResultSet, error) {
	bodyStr := strings.TrimSpace(string(body))

	if bodyStr == "" || bodyStr == "[]" || bodyStr == "{}" {
		return &registry.ResultSet{
			Columns: []string{},
			Rows:    [][]interface{}{},
		}, nil
	}

	var queryResult struct {
		Query []map[string]interface{} `json:"Query"`
	}
	if err := json.Unmarshal(body, &queryResult); err == nil && queryResult.Query != nil {
		return a.recordsToRegistryResultSet(queryResult.Query), nil
	}

	var records []map[string]interface{}
	if err := json.Unmarshal(body, &records); err == nil {
		return a.recordsToRegistryResultSet(records), nil
	}

	var rowsResult struct {
		Rows []map[string]interface{} `json:"rows"`
	}
	if err := json.Unmarshal(body, &rowsResult); err == nil && rowsResult.Rows != nil {
		return a.recordsToRegistryResultSet(rowsResult.Rows), nil
	}

	return nil, fmt.Errorf("unable to parse EdgeLake response: %s", string(body[:minInt(200, len(body))]))
}

// recordsToRegistryResultSet converts array of maps to registry.ResultSet
func (a *EdgeLakeAdapter) recordsToRegistryResultSet(records []map[string]interface{}) *registry.ResultSet {
	if len(records) == 0 {
		return &registry.ResultSet{
			Columns: []string{},
			Rows:    [][]interface{}{},
		}
	}

	columns := make([]string, 0)
	seen := make(map[string]bool)
	for _, record := range records {
		for key := range record {
			if !seen[key] {
				columns = append(columns, key)
				seen[key] = true
			}
		}
	}

	rows := make([][]interface{}, len(records))
	for i, record := range records {
		row := make([]interface{}, len(columns))
		for j, col := range columns {
			row[j] = record[col]
		}
		rows[i] = row
	}

	return &registry.ResultSet{
		Columns:  columns,
		Rows:     rows,
		Metadata: map[string]interface{}{"row_count": len(rows)},
	}
}

// ListDatabasesAdapter returns all databases
func (a *EdgeLakeAdapter) ListDatabasesAdapter(ctx context.Context) ([]string, error) {
	body, err := a.executeCommandInternal(ctx, "blockchain get table", false)
	if err != nil {
		return nil, err
	}
	return a.parseDatabaseListInternal(body)
}

// parseDatabaseListInternal extracts database names
func (a *EdgeLakeAdapter) parseDatabaseListInternal(body []byte) ([]string, error) {
	bodyStr := strings.TrimSpace(string(body))

	var tables []map[string]interface{}
	if err := json.Unmarshal(body, &tables); err == nil {
		dbSet := make(map[string]bool)
		for _, t := range tables {
			// EdgeLake wraps each entry: {"table": {"dbms": "...", "name": "..."}}
			entry := t
			if nested, ok := t["table"].(map[string]interface{}); ok {
				entry = nested
			}
			if db, ok := entry["dbms"].(string); ok && db != "" {
				dbSet[db] = true
			}
			if db, ok := entry["database"].(string); ok && db != "" {
				dbSet[db] = true
			}
		}
		databases := make([]string, 0, len(dbSet))
		for db := range dbSet {
			databases = append(databases, db)
		}
		return databases, nil
	}

	databases := make(map[string]bool)
	lines := strings.Split(bodyStr, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.Contains(line, "Database") {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) >= 1 {
			db := strings.TrimSpace(parts[0])
			if db != "" {
				databases[db] = true
			}
		}
	}

	result := make([]string, 0, len(databases))
	for db := range databases {
		result = append(result, db)
	}
	return result, nil
}

// minInt returns minimum of two ints
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

// EdgeLakeDataSource implements the DataSource interface for EdgeLake
type EdgeLakeDataSource struct {
	config *models.EdgeLakeConfig
	client *http.Client
}

// NewEdgeLakeDataSource creates a new EdgeLake data source
func NewEdgeLakeDataSource(config *models.EdgeLakeConfig) (*EdgeLakeDataSource, error) {
	timeout := 20 * time.Second
	if config.Timeout > 0 {
		timeout = time.Duration(config.Timeout) * time.Second
	}

	return &EdgeLakeDataSource{
		config: config,
		client: &http.Client{Timeout: timeout},
	}, nil
}

// baseURL returns the base URL for the EdgeLake node
func (e *EdgeLakeDataSource) baseURL() string {
	return fmt.Sprintf("http://%s:%d", e.config.Host, e.config.Port)
}

// executeCommand sends a command to EdgeLake via the command header
func (e *EdgeLakeDataSource) executeCommand(ctx context.Context, command string, distributed bool) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", e.baseURL(), nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("User-Agent", "anylog")
	req.Header.Set("command", command)

	if distributed {
		req.Header.Set("destination", "network")
	}

	resp, err := e.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("EdgeLake returned status %d: %s", resp.StatusCode, string(body))
	}

	// EdgeLake uses HTTP/1.0 with chunked transfer encoding, which Go doesn't
	// auto-dechunk. Strip chunk size prefixes if present.
	body = decodeChunkedBody(body)

	return body, nil
}

// Query executes a SQL query against EdgeLake and returns normalized results
func (e *EdgeLakeDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	if query.Raw == "" {
		return nil, fmt.Errorf("query is required")
	}

	// Extract database from params
	database := ""
	if query.Params != nil {
		if db, ok := query.Params["database"].(string); ok {
			database = db
		}
	}
	if database == "" {
		return nil, fmt.Errorf("database parameter is required for EdgeLake queries")
	}

	// Build the EdgeLake SQL command
	command := fmt.Sprintf(`sql %s format = json "%s"`, database, query.Raw)

	// Determine if this should be a distributed query
	distributed := e.config.UseDistributedQuery
	if query.Params != nil {
		if dist, ok := query.Params["distributed"].(bool); ok {
			distributed = dist
		}
	}

	body, err := e.executeCommand(ctx, command, distributed)
	if err != nil {
		return nil, err
	}

	return e.parseQueryResponse(body)
}

// parseQueryResponse parses an EdgeLake query response into a ResultSet
func (e *EdgeLakeDataSource) parseQueryResponse(body []byte) (*models.ResultSet, error) {
	// EdgeLake returns JSON in format: {"Query": [{...}, {...}]}
	// or sometimes just an array of objects
	bodyStr := strings.TrimSpace(string(body))

	if bodyStr == "" || bodyStr == "[]" || bodyStr == "{}" {
		return &models.ResultSet{
			Columns: []string{},
			Rows:    [][]interface{}{},
		}, nil
	}

	// Try parsing as {"Query": [...]} format
	var queryResult struct {
		Query []map[string]interface{} `json:"Query"`
	}
	if err := json.Unmarshal(body, &queryResult); err == nil && queryResult.Query != nil {
		return e.recordsToResultSet(queryResult.Query), nil
	}

	// Try parsing as a direct array of objects
	var records []map[string]interface{}
	if err := json.Unmarshal(body, &records); err == nil {
		return e.recordsToResultSet(records), nil
	}

	// Try parsing as {"rows": [...]} format
	var rowsResult struct {
		Rows []map[string]interface{} `json:"rows"`
	}
	if err := json.Unmarshal(body, &rowsResult); err == nil && rowsResult.Rows != nil {
		return e.recordsToResultSet(rowsResult.Rows), nil
	}

	return nil, fmt.Errorf("unable to parse EdgeLake response: %s", string(body[:min(200, len(body))]))
}

// recordsToResultSet converts an array of maps to a normalized ResultSet
func (e *EdgeLakeDataSource) recordsToResultSet(records []map[string]interface{}) *models.ResultSet {
	if len(records) == 0 {
		return &models.ResultSet{
			Columns: []string{},
			Rows:    [][]interface{}{},
		}
	}

	// Extract columns from the first record to maintain order
	columns := make([]string, 0)
	seen := make(map[string]bool)
	for _, record := range records {
		for key := range record {
			if !seen[key] {
				columns = append(columns, key)
				seen[key] = true
			}
		}
	}

	// Build rows
	rows := make([][]interface{}, len(records))
	for i, record := range records {
		row := make([]interface{}, len(columns))
		for j, col := range columns {
			row[j] = record[col]
		}
		rows[i] = row
	}

	return &models.ResultSet{
		Columns:  columns,
		Rows:     rows,
		Metadata: map[string]interface{}{"row_count": len(rows)},
	}
}

// Stream is not supported for EdgeLake (use polling via refresh interval)
func (e *EdgeLakeDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	return nil, fmt.Errorf("streaming is not supported for EdgeLake data sources; use refresh interval for periodic updates")
}

// Close cleans up resources
func (e *EdgeLakeDataSource) Close() error {
	return nil
}

// TestConnection tests the connection to an EdgeLake node
func (e *EdgeLakeDataSource) TestConnection(ctx context.Context) error {
	_, err := e.executeCommand(ctx, "get status", false)
	return err
}

// ListDatabases returns all databases from the EdgeLake blockchain registry
func (e *EdgeLakeDataSource) ListDatabases(ctx context.Context) ([]string, error) {
	body, err := e.executeCommand(ctx, "blockchain get table", false)
	if err != nil {
		return nil, err
	}

	return e.parseDatabaseList(body)
}

// parseDatabaseList extracts unique database names from blockchain table response
func (e *EdgeLakeDataSource) parseDatabaseList(body []byte) ([]string, error) {
	bodyStr := strings.TrimSpace(string(body))

	// Try JSON array format first
	var tables []map[string]interface{}
	if err := json.Unmarshal(body, &tables); err == nil {
		dbSet := make(map[string]bool)
		for _, t := range tables {
			// EdgeLake wraps each entry: {"table": {"dbms": "...", "name": "..."}}
			entry := t
			if nested, ok := t["table"].(map[string]interface{}); ok {
				entry = nested
			}
			if db, ok := entry["dbms"].(string); ok && db != "" {
				dbSet[db] = true
			}
			if db, ok := entry["database"].(string); ok && db != "" {
				dbSet[db] = true
			}
		}
		databases := make([]string, 0, len(dbSet))
		for db := range dbSet {
			databases = append(databases, db)
		}
		return databases, nil
	}

	// Try text table format:
	// Database   | Table name
	// -----------|-----------
	// new_company| rand_data
	databases := make(map[string]bool)
	lines := strings.Split(bodyStr, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.Contains(line, "Database") {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) >= 1 {
			db := strings.TrimSpace(parts[0])
			if db != "" {
				databases[db] = true
			}
		}
	}

	result := make([]string, 0, len(databases))
	for db := range databases {
		result = append(result, db)
	}

	if len(result) == 0 {
		return []string{}, nil
	}

	return result, nil
}

// ListTables returns tables for a specific database
func (e *EdgeLakeDataSource) ListTables(ctx context.Context, database string) ([]string, error) {
	body, err := e.executeCommand(ctx, "blockchain get table", false)
	if err != nil {
		return nil, err
	}

	return e.parseTableList(body, database)
}

// parseTableList extracts table names for a specific database
func (e *EdgeLakeDataSource) parseTableList(body []byte, database string) ([]string, error) {
	bodyStr := strings.TrimSpace(string(body))

	// Try JSON array format
	var tables []map[string]interface{}
	if err := json.Unmarshal(body, &tables); err == nil {
		var result []string
		for _, t := range tables {
			// EdgeLake wraps each entry: {"table": {"dbms": "...", "name": "..."}}
			entry := t
			if nested, ok := t["table"].(map[string]interface{}); ok {
				entry = nested
			}
			db := ""
			if d, ok := entry["dbms"].(string); ok {
				db = d
			} else if d, ok := entry["database"].(string); ok {
				db = d
			}
			if db == database {
				if name, ok := entry["name"].(string); ok {
					result = append(result, name)
				}
			}
		}
		return result, nil
	}

	// Try text table format
	var result []string
	lines := strings.Split(bodyStr, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "-") || strings.Contains(line, "Database") {
			continue
		}
		parts := strings.SplitN(line, "|", 2)
		if len(parts) == 2 {
			db := strings.TrimSpace(parts[0])
			tbl := strings.TrimSpace(parts[1])
			if db == database && tbl != "" {
				result = append(result, tbl)
			}
		}
	}

	return result, nil
}

// GetTableSchema returns column definitions for a table
func (e *EdgeLakeDataSource) GetTableSchema(ctx context.Context, database, table string) ([]models.EdgeLakeColumnInfo, error) {
	cmd := fmt.Sprintf(`get columns where dbms="%s" and table="%s" and format=json`, database, table)
	body, err := e.executeCommand(ctx, cmd, false)
	if err != nil {
		return nil, err
	}

	return e.parseColumnSchema(body)
}

// parseColumnSchema parses column schema JSON
func (e *EdgeLakeDataSource) parseColumnSchema(body []byte) ([]models.EdgeLakeColumnInfo, error) {
	// Try direct array format: [{"name": "col", "type": "INT"}, ...]
	var columns []models.EdgeLakeColumnInfo
	if err := json.Unmarshal(body, &columns); err == nil && len(columns) > 0 {
		return columns, nil
	}

	// Try wrapped format: {"columns": [...]}
	var wrapped struct {
		Columns []models.EdgeLakeColumnInfo `json:"columns"`
	}
	if err := json.Unmarshal(body, &wrapped); err == nil && len(wrapped.Columns) > 0 {
		return wrapped.Columns, nil
	}

	// Try key-value format: {"col_name": "col_type", ...}
	var kvMap map[string]string
	if err := json.Unmarshal(body, &kvMap); err == nil && len(kvMap) > 0 {
		cols := make([]models.EdgeLakeColumnInfo, 0, len(kvMap))
		for name, typ := range kvMap {
			cols = append(cols, models.EdgeLakeColumnInfo{Name: name, Type: typ})
		}
		return cols, nil
	}

	return nil, fmt.Errorf("unable to parse column schema: %s", string(body[:min(200, len(body))]))
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
