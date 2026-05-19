// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register TSStore adapter
	registry.Register(
		"store.tsstore",
		"TSStore Time Series",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		tsstoreConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newTSStoreAdapterFromConfig(config)
		},
	)
}

// tsstoreConfigSchema returns configuration fields for TSStore adapter
func tsstoreConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "transport", Type: "string", Required: false, Options: []string{"rest", "streaming"}, Default: "rest", Description: "Transport mode: rest (HTTP polling) or streaming (WebSocket push)"},
		{Name: "protocol", Type: "string", Required: true, Options: []string{"http", "https"}, Description: "Protocol (http or https)"},
		{Name: "host", Type: "string", Required: true, Description: "TSStore host"},
		{Name: "port", Type: "int", Required: true, Description: "TSStore port"},
		{Name: "store_name", Type: "string", Required: true, Description: "Store name"},
		{Name: "data_type", Type: "string", Required: false, Options: []string{"json", "schema", "text"}, Description: "Data type"},
		{Name: "api_key", Type: "password", Required: false, Description: "API key"},
		{Name: "timeout", Type: "int", Required: false, Default: 30, Description: "Timeout (seconds)"},
		{Name: "insecure_skip_verify", Type: "bool", Required: false, Default: false, Description: "Skip TLS certificate verification for HTTPS endpoints (self-signed certs). Server must also have api.allow_insecure_tls enabled."},
	}
}

// TSStoreAdapter implements registry.Adapter for TSStore
type TSStoreAdapter struct {
	config     *models.TSStoreConfig
	httpClient *http.Client
	schema     *tsStoreSchema
}

// newTSStoreAdapterFromConfig creates a TSStore adapter from config map
func newTSStoreAdapterFromConfig(config map[string]interface{}) (*TSStoreAdapter, error) {
	tsConfig := &models.TSStoreConfig{}

	if transport, ok := config["transport"].(string); ok {
		tsConfig.Transport = models.TSStoreTransport(transport)
	}
	if protocol, ok := config["protocol"].(string); ok {
		tsConfig.Protocol = models.TSStoreProtocol(protocol)
	}
	if host, ok := config["host"].(string); ok {
		tsConfig.Host = host
	}
	if port, ok := config["port"].(float64); ok {
		tsConfig.Port = int(port)
	} else if port, ok := config["port"].(int); ok {
		tsConfig.Port = port
	}
	if storeName, ok := config["store_name"].(string); ok {
		tsConfig.StoreName = storeName
	}
	if dataType, ok := config["data_type"].(string); ok {
		tsConfig.DataType = models.TSStoreDataType(dataType)
	}
	if apiKey, ok := config["api_key"].(string); ok {
		tsConfig.APIKey = apiKey
	}
	if timeout, ok := config["timeout"].(float64); ok {
		tsConfig.Timeout = int(timeout)
	} else if timeout, ok := config["timeout"].(int); ok {
		tsConfig.Timeout = timeout
	}
	if skip, ok := config["insecure_skip_verify"].(bool); ok {
		tsConfig.InsecureSkipVerify = skip
	}

	// Same two-gate parity warning as the api adapter: a per-conn
	// skip flag without the deployment-level allow is silently
	// ignored, which is hard to debug without a hint at boot.
	if tsConfig.InsecureSkipVerify && !IsInsecureTLSAllowed() {
		log.Printf("tsstore adapter %s://%s:%d/%s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it",
			tsConfig.Protocol, tsConfig.Host, tsConfig.Port, tsConfig.StoreName)
	}

	return &TSStoreAdapter{
		config:     tsConfig,
		httpClient: BuildAPIHTTPClient(tsConfig.Timeout, tsConfig.InsecureSkipVerify),
	}, nil
}

// TypeID returns the adapter type identifier
func (a *TSStoreAdapter) TypeID() string {
	return "store.tsstore"
}

// DisplayName returns a human-readable name
func (a *TSStoreAdapter) DisplayName() string {
	return "TSStore Time Series"
}

// Capabilities returns what this adapter can do
func (a *TSStoreAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *TSStoreAdapter) ConfigSchema() []registry.ConfigField {
	return tsstoreConfigSchema()
}

// Connect tests the connection to TSStore
func (a *TSStoreAdapter) Connect(ctx context.Context) error {
	return a.TestConnection(ctx)
}

// TestConnection tests the connection to TSStore
func (a *TSStoreAdapter) TestConnection(ctx context.Context) error {
	reqURL := fmt.Sprintf("%s/api/stores/%s/stats", a.config.BaseURL(), a.config.StoreName)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("connection failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return fmt.Errorf("store '%s' not found", a.config.StoreName)
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("TSStore error (status %d): %s", resp.StatusCode, string(body))
	}

	return nil
}

// Close is a no-op for TSStore
func (a *TSStoreAdapter) Close() error {
	return nil
}

// Query fetches data from TSStore
func (a *TSStoreAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	var limit int
	hasExplicitLimit := false
	if l, ok := query.Params["limit"].(float64); ok {
		limit = int(l)
		hasExplicitLimit = true
	} else if l, ok := query.Params["limit"].(int); ok {
		limit = l
		hasExplicitLimit = true
	}

	filter, _ := query.Params["filter"].(string)
	filterIgnoreCase, _ := query.Params["filter_ignore_case"].(bool)

	var objects []dataResponse
	var err error

	queryType := query.Raw
	if queryType == "" {
		queryType = "newest"
	}

	switch {
	case queryType == "newest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchNewest(ctx, limit, "", filter, filterIgnoreCase)
	case queryType == "oldest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchOldest(ctx, limit, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "since:":
		if !hasExplicitLimit {
			limit = 100000
		}
		since := queryType[6:]
		objects, err = a.fetchNewest(ctx, limit, since, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "range:":
		if !hasExplicitLimit {
			limit = 100000
		}
		var startTime, endTime int64
		if _, parseErr := fmt.Sscanf(queryType, "range:%d:%d", &startTime, &endTime); parseErr == nil {
			objects, err = a.fetchRange(ctx, startTime, endTime, limit, filter, filterIgnoreCase)
		} else {
			return nil, fmt.Errorf("invalid range format")
		}
	default:
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = a.fetchNewest(ctx, limit, "", filter, filterIgnoreCase)
	}

	if err != nil {
		return nil, err
	}

	return a.toRegistryResultSet(ctx, objects)
}

// Stream implements streaming for TSStore using WebSocket
func (a *TSStoreAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	recordChan := make(chan registry.Record, 100)

	wsURL, err := a.buildWebSocketURL(query)
	if err != nil {
		return nil, fmt.Errorf("failed to build WebSocket URL: %w", err)
	}

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	headers := http.Header{}
	for k, v := range a.config.Headers {
		headers.Set(k, v)
	}

	conn, _, err := dialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to TSStore WebSocket: %w", err)
	}

	go func() {
		defer close(recordChan)
		defer conn.Close()

		if a.config.DataType == models.TSStoreDataTypeSchema {
			schema, err := a.fetchSchemaInternal(ctx)
			if err == nil && schema != nil {
				schemaRecord := registry.Record{
					"_type": "schema",
					"schema": map[string]interface{}{
						"version": schema.Version,
						"fields":  a.schemaFieldsToInterface(schema.Fields),
					},
				}
				select {
				case recordChan <- schemaRecord:
				case <-ctx.Done():
					return
				}
			}
		}

		for {
			select {
			case <-ctx.Done():
				return
			default:
				conn.SetReadDeadline(time.Now().Add(5 * time.Second))
				_, messageBytes, err := conn.ReadMessage()
				if err != nil {
					if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
						return
					}
					if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
						continue
					}
					return
				}

				var msg wsMessage
				if err := json.Unmarshal(messageBytes, &msg); err != nil {
					continue
				}

				switch msg.Type {
				case "data":
					record := a.wsMessageToRegistryRecord(&msg)
					select {
					case recordChan <- record:
					case <-ctx.Done():
						return
					}
				case "caught_up":
					select {
					case recordChan <- registry.Record{"_type": "caught_up"}:
					case <-ctx.Done():
						return
					}
				case "error":
					select {
					case recordChan <- registry.Record{"_type": "error", "message": msg.Message}:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return recordChan, nil
}

// Write is not supported for TSStore adapter
func (a *TSStoreAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("store.tsstore does not support write operations")
}

// toRegistryResultSet converts TSStore objects to registry.ResultSet
func (a *TSStoreAdapter) toRegistryResultSet(ctx context.Context, objects []dataResponse) (*registry.ResultSet, error) {
	if len(objects) == 0 {
		return &registry.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0},
		}, nil
	}

	metadata := map[string]interface{}{
		"store_name":  a.config.StoreName,
		"source_type": "tsstore",
		"data_type":   string(a.config.DataType),
	}

	if a.config.DataType == models.TSStoreDataTypeSchema {
		schema, err := a.fetchSchemaInternal(ctx)
		if err == nil && schema != nil {
			schemaFields := make([]map[string]interface{}, len(schema.Fields))
			for i, f := range schema.Fields {
				schemaFields[i] = map[string]interface{}{
					"index": f.Index,
					"name":  f.Name,
					"type":  f.Type,
				}
			}
			metadata["schema"] = map[string]interface{}{
				"version": schema.Version,
				"fields":  schemaFields,
			}
		}
	}

	if a.config.DataType == models.TSStoreDataTypeText {
		return a.textToRegistryResultSet(objects, metadata)
	}

	return a.jsonToRegistryResultSet(objects, metadata)
}

// textToRegistryResultSet converts text objects to ResultSet
func (a *TSStoreAdapter) textToRegistryResultSet(objects []dataResponse, metadata map[string]interface{}) (*registry.ResultSet, error) {
	columns := []string{"timestamp", "data"}
	rows := make([][]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9
		var text string
		if err := json.Unmarshal(obj.Data, &text); err != nil {
			text = string(obj.Data)
		}
		rows = append(rows, []interface{}{timestamp, text})
	}

	metadata["row_count"] = len(rows)
	return &registry.ResultSet{Columns: columns, Rows: rows, Metadata: metadata}, nil
}

// jsonToRegistryResultSet converts JSON objects to ResultSet
func (a *TSStoreAdapter) jsonToRegistryResultSet(objects []dataResponse, metadata map[string]interface{}) (*registry.ResultSet, error) {
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"}
	columnSet["timestamp"] = true

	decodedObjects := make([]map[string]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9

		var records []map[string]interface{}
		if err := json.Unmarshal(obj.Data, &records); err == nil {
			for _, record := range records {
				record["timestamp"] = timestamp
				for key := range record {
					if !columnSet[key] {
						columnSet[key] = true
						columnOrder = append(columnOrder, key)
					}
				}
				decodedObjects = append(decodedObjects, record)
			}
		} else {
			var record map[string]interface{}
			if err := json.Unmarshal(obj.Data, &record); err != nil {
				record = map[string]interface{}{"data": string(obj.Data)}
			}
			record["timestamp"] = timestamp
			for key := range record {
				if !columnSet[key] {
					columnSet[key] = true
					columnOrder = append(columnOrder, key)
				}
			}
			decodedObjects = append(decodedObjects, record)
		}
	}

	rows := make([][]interface{}, 0, len(decodedObjects))
	for _, record := range decodedObjects {
		row := make([]interface{}, len(columnOrder))
		for i, col := range columnOrder {
			if val, exists := record[col]; exists {
				row[i] = flattenValue(val)
			} else {
				row[i] = nil
			}
		}
		rows = append(rows, row)
	}

	metadata["row_count"] = len(rows)
	return &registry.ResultSet{Columns: columnOrder, Rows: rows, Metadata: metadata}, nil
}

// wsMessageToRegistryRecord converts WebSocket message to registry.Record
func (a *TSStoreAdapter) wsMessageToRegistryRecord(msg *wsMessage) registry.Record {
	record := registry.Record{
		"_type":     "data",
		"timestamp": msg.Timestamp / 1e9,
	}

	switch a.config.DataType {
	case models.TSStoreDataTypeText:
		var text string
		if err := json.Unmarshal(msg.Data, &text); err != nil {
			text = string(msg.Data)
		}
		record["data"] = text
	default:
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			record["data"] = string(msg.Data)
		} else {
			for k, v := range data {
				record[k] = v
			}
		}
	}

	return record
}

// fetchSchemaInternal fetches and caches schema
func (a *TSStoreAdapter) fetchSchemaInternal(ctx context.Context) (*tsStoreSchema, error) {
	if a.schema != nil {
		return a.schema, nil
	}

	reqURL := fmt.Sprintf("%s/api/stores/%s/schema", a.config.BaseURL(), a.config.StoreName)
	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch schema: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore schema error (status %d): %s", resp.StatusCode, string(body))
	}

	var schema tsStoreSchema
	if err := json.NewDecoder(resp.Body).Decode(&schema); err != nil {
		return nil, fmt.Errorf("failed to decode schema: %w", err)
	}

	a.schema = &schema
	return a.schema, nil
}

// schemaFieldsToInterface converts schema fields to interface slice
func (a *TSStoreAdapter) schemaFieldsToInterface(fields []tsStoreSchemaField) []map[string]interface{} {
	result := make([]map[string]interface{}, len(fields))
	for i, f := range fields {
		result[i] = map[string]interface{}{
			"index": f.Index,
			"name":  f.Name,
			"type":  f.Type,
		}
	}
	return result
}

// buildWebSocketURL constructs WebSocket URL
func (a *TSStoreAdapter) buildWebSocketURL(query registry.Query) (string, error) {
	baseURL := a.config.WebSocketURL()
	params := url.Values{}

	if a.config.APIKey != "" {
		params.Set("api_key", a.config.APIKey)
	}

	from := "now"
	if f, ok := query.Params["from"].(string); ok && f != "" {
		from = f
	} else if f, ok := query.Params["from"].(int64); ok {
		from = strconv.FormatInt(f, 10)
	} else if f, ok := query.Params["from"].(float64); ok {
		from = strconv.FormatInt(int64(f), 10)
	}
	params.Set("from", from)

	if a.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	if filter, ok := query.Params["filter"].(string); ok && filter != "" {
		params.Set("filter", filter)
		if ignoreCase, ok := query.Params["filter_ignore_case"].(bool); ok && ignoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}

	return fmt.Sprintf("%s/api/stores/%s/ws/read?%s", baseURL, a.config.StoreName, params.Encode()), nil
}

// addHeaders adds authentication and custom headers
func (a *TSStoreAdapter) addHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")
	if a.config.APIKey != "" {
		req.Header.Set("X-API-Key", a.config.APIKey)
	}
	for k, v := range a.config.Headers {
		req.Header.Set(k, v)
	}
}

// fetchNewest retrieves newest objects
func (a *TSStoreAdapter) fetchNewest(ctx context.Context, limit int, since string, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if since != "" {
		params.Set("since", since)
	}
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/newest?%s", a.config.StoreName, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// fetchOldest retrieves oldest objects
func (a *TSStoreAdapter) fetchOldest(ctx context.Context, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/oldest?%s", a.config.StoreName, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// fetchRange retrieves objects in time range
func (a *TSStoreAdapter) fetchRange(ctx context.Context, startTime, endTime int64, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("start_time", strconv.FormatInt(startTime, 10))
	params.Set("end_time", strconv.FormatInt(endTime, 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("include_data", "true")
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if a.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/range?%s", a.config.StoreName, params.Encode())
	return a.fetchList(ctx, endpoint)
}

// fetchList makes request to list endpoint
func (a *TSStoreAdapter) fetchList(ctx context.Context, endpoint string) ([]dataResponse, error) {
	reqURL := a.config.BaseURL() + endpoint

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	a.addHeaders(req)

	resp, err := a.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp dataListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return listResp.Objects, nil
}

// TSStoreDataSource implements the DataSource interface for TSStore timeseries databases.
// TSStore stores objects at timestamps with support for json, schema (compact json), and text data types.
// Uses the unified /data/* endpoints.
type TSStoreDataSource struct {
	config     *models.TSStoreConfig
	httpClient *http.Client
	schema     *tsStoreSchema // Cached schema for schema-type stores
}

// tsStoreSchema represents the schema for a schema-type store
type tsStoreSchema struct {
	Version int                  `json:"version"`
	Fields  []tsStoreSchemaField `json:"fields"`
}

// tsStoreSchemaField represents a field in the schema
type tsStoreSchemaField struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Type  string `json:"type"`
}

// dataResponse represents a single data object from TSStore
type dataResponse struct {
	Timestamp int64           `json:"timestamp"`
	BlockNum  uint32          `json:"block_num"`
	Size      uint32          `json:"size"`
	Data      json.RawMessage `json:"data"`
}

// dataListResponse represents a list response from TSStore
type dataListResponse struct {
	Objects []dataResponse `json:"objects"`
	Count   int            `json:"count"`
}

// storeStatsResponse represents the stats response from TSStore
type storeStatsResponse struct {
	Name         string `json:"name"`
	DataType     string `json:"data_type"`
	NumBlocks    uint32 `json:"num_blocks"`
	ActiveBlocks uint32 `json:"active_blocks"`
	HeadBlock    uint32 `json:"head_block"`
	TailBlock    uint32 `json:"tail_block"`
}

// wsMessage represents a WebSocket message from TSStore
type wsMessage struct {
	Type      string          `json:"type"`                 // "data", "caught_up", "error"
	Timestamp int64           `json:"timestamp,omitempty"`  // For data messages
	BlockNum  uint32          `json:"block_num,omitempty"`  // For data messages
	Size      uint32          `json:"size,omitempty"`       // For data messages
	Data      json.RawMessage `json:"data,omitempty"`       // For data messages
	Message   string          `json:"message,omitempty"`    // For error messages
}

// NewTSStoreDataSource creates a new TSStore datasource. Uses
// BuildAPIHTTPClient so the same two-gate TLS skip model applies
// here as on the registry adapter: per-conn flag + server allow.
func NewTSStoreDataSource(config *models.TSStoreConfig) (*TSStoreDataSource, error) {
	if config.InsecureSkipVerify && !IsInsecureTLSAllowed() {
		log.Printf("tsstore datasource %s://%s:%d/%s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it",
			config.Protocol, config.Host, config.Port, config.StoreName)
	}

	return &TSStoreDataSource{
		config:     config,
		httpClient: BuildAPIHTTPClient(config.Timeout, config.InsecureSkipVerify),
	}, nil
}

// Query fetches data from TSStore using the unified /data endpoints.
// Query.Raw can specify:
// - "newest" or empty: fetch the N newest objects (default 10)
// - "oldest": fetch the N oldest objects
// - "since:DURATION": fetch objects from the last duration (e.g., "since:30m", "since:2h", "since:7d")
// - "range:START_TIME:END_TIME": fetch objects in time range (epoch nanoseconds)
// Query.Params can include:
// - "limit": number of records to fetch
// - "filter": substring filter
// - "filter_ignore_case": true/false for case-insensitive filtering
func (t *TSStoreDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Get limit from params, default depends on query type
	var limit int
	hasExplicitLimit := false
	if l, ok := query.Params["limit"].(float64); ok {
		limit = int(l)
		hasExplicitLimit = true
	} else if l, ok := query.Params["limit"].(int); ok {
		limit = l
		hasExplicitLimit = true
	}

	// Get filter params
	filter, _ := query.Params["filter"].(string)
	filterIgnoreCase, _ := query.Params["filter_ignore_case"].(bool)

	var objects []dataResponse
	var err error

	queryType := query.Raw
	if queryType == "" {
		queryType = "newest"
	}

	switch {
	case queryType == "newest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchNewest(ctx, limit, "", filter, filterIgnoreCase)
	case queryType == "oldest":
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchOldest(ctx, limit, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "since:":
		// Relative time query: "since:30m", "since:2h", "since:7d"
		if !hasExplicitLimit {
			limit = 100000 // High default for time-range queries
		}
		since := queryType[6:]
		objects, err = t.fetchNewest(ctx, limit, since, filter, filterIgnoreCase)
	case len(queryType) > 6 && queryType[:6] == "range:":
		// Absolute time range: "range:START:END"
		if !hasExplicitLimit {
			limit = 100000
		}
		var startTime, endTime int64
		if _, parseErr := fmt.Sscanf(queryType, "range:%d:%d", &startTime, &endTime); parseErr == nil {
			objects, err = t.fetchRange(ctx, startTime, endTime, limit, filter, filterIgnoreCase)
		} else {
			return nil, fmt.Errorf("invalid range format, expected 'range:START_TIME:END_TIME'")
		}
	default:
		// Default to newest with low limit
		if !hasExplicitLimit {
			limit = 10
		}
		objects, err = t.fetchNewest(ctx, limit, "", filter, filterIgnoreCase)
	}

	if err != nil {
		return nil, err
	}

	// Convert objects to ResultSet
	return t.toResultSet(ctx, objects)
}

// fetchNewest retrieves the N newest objects
func (t *TSStoreDataSource) fetchNewest(ctx context.Context, limit int, since string, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if since != "" {
		params.Set("since", since)
	}
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	// For schema stores, request compact format (frontend will expand)
	if t.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/newest?%s", t.config.StoreName, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchOldest retrieves the N oldest objects
func (t *TSStoreDataSource) fetchOldest(ctx context.Context, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("limit", strconv.Itoa(limit))
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if t.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/oldest?%s", t.config.StoreName, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchRange retrieves objects within a time range
func (t *TSStoreDataSource) fetchRange(ctx context.Context, startTime, endTime int64, limit int, filter string, filterIgnoreCase bool) ([]dataResponse, error) {
	params := url.Values{}
	params.Set("start_time", strconv.FormatInt(startTime, 10))
	params.Set("end_time", strconv.FormatInt(endTime, 10))
	params.Set("limit", strconv.Itoa(limit))
	params.Set("include_data", "true")
	if filter != "" {
		params.Set("filter", filter)
		if filterIgnoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}
	if t.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	endpoint := fmt.Sprintf("/api/stores/%s/data/range?%s", t.config.StoreName, params.Encode())
	return t.fetchList(ctx, endpoint)
}

// fetchList makes a request to a list endpoint and returns the objects
func (t *TSStoreDataSource) fetchList(ctx context.Context, endpoint string) ([]dataResponse, error) {
	reqURL := t.config.BaseURL() + endpoint

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch data: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp dataListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return listResp.Objects, nil
}

// fetchSchema retrieves and caches the schema for schema-type stores
func (t *TSStoreDataSource) fetchSchema(ctx context.Context) (*tsStoreSchema, error) {
	if t.schema != nil {
		return t.schema, nil
	}

	reqURL := fmt.Sprintf("%s/api/stores/%s/schema", t.config.BaseURL(), t.config.StoreName)

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch schema: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore schema error (status %d): %s", resp.StatusCode, string(body))
	}

	var schema tsStoreSchema
	if err := json.NewDecoder(resp.Body).Decode(&schema); err != nil {
		return nil, fmt.Errorf("failed to decode schema: %w", err)
	}

	t.schema = &schema
	return t.schema, nil
}

// GetStoreStats retrieves store statistics including data type
func (t *TSStoreDataSource) GetStoreStats(ctx context.Context) (*storeStatsResponse, error) {
	reqURL := fmt.Sprintf("%s/api/stores/%s/stats", t.config.BaseURL(), t.config.StoreName)

	req, err := http.NewRequestWithContext(ctx, "GET", reqURL, nil)
	if err != nil {
		return nil, err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch stats: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("store '%s' not found", t.config.StoreName)
	}

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("TSStore API error (status %d): %s", resp.StatusCode, string(body))
	}

	var stats storeStatsResponse
	if err := json.NewDecoder(resp.Body).Decode(&stats); err != nil {
		return nil, fmt.Errorf("failed to decode stats: %w", err)
	}

	return &stats, nil
}

// toResultSet converts TSStore objects to a normalized ResultSet
// For schema stores, includes schema in metadata for frontend expansion
func (t *TSStoreDataSource) toResultSet(ctx context.Context, objects []dataResponse) (*models.ResultSet, error) {
	if len(objects) == 0 {
		return &models.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0},
		}, nil
	}

	metadata := map[string]interface{}{
		"store_name":  t.config.StoreName,
		"source_type": "tsstore",
		"data_type":   string(t.config.DataType),
	}

	// For schema stores, fetch and include schema for frontend expansion
	if t.config.DataType == models.TSStoreDataTypeSchema {
		schema, err := t.fetchSchema(ctx)
		if err == nil && schema != nil {
			// Convert schema to format frontend can use
			schemaFields := make([]map[string]interface{}, len(schema.Fields))
			for i, f := range schema.Fields {
				schemaFields[i] = map[string]interface{}{
					"index": f.Index,
					"name":  f.Name,
					"type":  f.Type,
				}
			}
			metadata["schema"] = map[string]interface{}{
				"version": schema.Version,
				"fields":  schemaFields,
			}
		}
	}

	// Handle text data type - simple single column
	if t.config.DataType == models.TSStoreDataTypeText {
		return t.textToResultSet(objects, metadata)
	}

	// Handle JSON and Schema data types
	return t.jsonToResultSet(objects, metadata)
}

// textToResultSet converts text objects to ResultSet
func (t *TSStoreDataSource) textToResultSet(objects []dataResponse, metadata map[string]interface{}) (*models.ResultSet, error) {
	columns := []string{"timestamp", "data"}
	rows := make([][]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9 // nanoseconds -> seconds
		// Text data comes as a JSON string
		var text string
		if err := json.Unmarshal(obj.Data, &text); err != nil {
			// If not a JSON string, use raw
			text = string(obj.Data)
		}
		rows = append(rows, []interface{}{timestamp, text})
	}

	metadata["row_count"] = len(rows)
	return &models.ResultSet{
		Columns:  columns,
		Rows:     rows,
		Metadata: metadata,
	}, nil
}

// jsonToResultSet converts JSON/Schema objects to ResultSet
// For JSON: discovers columns from data structure
// For Schema: passes compact data through (frontend expands using schema in metadata)
func (t *TSStoreDataSource) jsonToResultSet(objects []dataResponse, metadata map[string]interface{}) (*models.ResultSet, error) {
	// Discover columns from all objects
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"}
	columnSet["timestamp"] = true

	// First pass: decode all objects and discover columns
	decodedObjects := make([]map[string]interface{}, 0, len(objects))

	for _, obj := range objects {
		timestamp := obj.Timestamp / 1e9 // nanoseconds -> seconds

		// Try to parse as array of records
		var records []map[string]interface{}
		if err := json.Unmarshal(obj.Data, &records); err == nil {
			for _, record := range records {
				record["timestamp"] = timestamp
				for key := range record {
					if !columnSet[key] {
						columnSet[key] = true
						columnOrder = append(columnOrder, key)
					}
				}
				decodedObjects = append(decodedObjects, record)
			}
		} else {
			// Try as single object
			var record map[string]interface{}
			if err := json.Unmarshal(obj.Data, &record); err != nil {
				record = map[string]interface{}{"data": string(obj.Data)}
			}
			record["timestamp"] = timestamp
			for key := range record {
				if !columnSet[key] {
					columnSet[key] = true
					columnOrder = append(columnOrder, key)
				}
			}
			decodedObjects = append(decodedObjects, record)
		}
	}

	// Second pass: build rows with consistent column order
	rows := make([][]interface{}, 0, len(decodedObjects))
	for _, record := range decodedObjects {
		row := make([]interface{}, len(columnOrder))
		for i, col := range columnOrder {
			if val, exists := record[col]; exists {
				row[i] = flattenValue(val)
			} else {
				row[i] = nil
			}
		}
		rows = append(rows, row)
	}

	metadata["row_count"] = len(rows)
	return &models.ResultSet{
		Columns:  columnOrder,
		Rows:     rows,
		Metadata: metadata,
	}, nil
}

// addHeaders adds authentication and custom headers to requests
func (t *TSStoreDataSource) addHeaders(req *http.Request) {
	req.Header.Set("Content-Type", "application/json")

	if t.config.APIKey != "" {
		req.Header.Set("X-API-Key", t.config.APIKey)
	}

	for k, v := range t.config.Headers {
		req.Header.Set(k, v)
	}
}

// Stream implements streaming for TSStore using WebSocket connection.
// Connects to /api/stores/:store/ws/read endpoint for real-time data.
// For schema stores, sends schema as first message, then streams compact data.
// Query.Params can include:
// - "from": start point - Unix nanosecond timestamp or "now" (default: "now")
// - "filter": substring filter
// - "filter_ignore_case": true/false for case-insensitive filtering
func (t *TSStoreDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	recordChan := make(chan models.Record, 100)

	// Build WebSocket URL
	wsURL, err := t.buildWebSocketURL(query)
	if err != nil {
		return nil, fmt.Errorf("failed to build WebSocket URL: %w", err)
	}

	// Connect to WebSocket
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	// Add custom headers for WebSocket connection
	headers := http.Header{}
	for k, v := range t.config.Headers {
		headers.Set(k, v)
	}

	conn, _, err := dialer.DialContext(ctx, wsURL, headers)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to TSStore WebSocket: %w", err)
	}

	go func() {
		defer close(recordChan)
		defer conn.Close()

		// For schema stores, send schema as first message
		if t.config.DataType == models.TSStoreDataTypeSchema {
			schema, err := t.fetchSchema(ctx)
			if err == nil && schema != nil {
				schemaRecord := models.Record{
					"_type": "schema",
					"schema": map[string]interface{}{
						"version": schema.Version,
						"fields":  t.schemaFieldsToInterface(schema.Fields),
					},
				}
				select {
				case recordChan <- schemaRecord:
				case <-ctx.Done():
					return
				}
			}
		}

		// Read messages from WebSocket
		for {
			select {
			case <-ctx.Done():
				return
			default:
				// Set read deadline to allow checking context
				conn.SetReadDeadline(time.Now().Add(5 * time.Second))

				_, messageBytes, err := conn.ReadMessage()
				if err != nil {
					if websocket.IsCloseError(err, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
						return
					}
					// Check if it's a timeout (expected, allows context check)
					if netErr, ok := err.(interface{ Timeout() bool }); ok && netErr.Timeout() {
						continue
					}
					// Log error and try to reconnect or exit
					// For now, just exit on error
					return
				}

				var msg wsMessage
				if err := json.Unmarshal(messageBytes, &msg); err != nil {
					continue
				}

				switch msg.Type {
				case "data":
					record := t.wsMessageToRecord(&msg)
					select {
					case recordChan <- record:
					case <-ctx.Done():
						return
					}
				case "caught_up":
					// Send a special record indicating we're caught up to real-time
					caughtUpRecord := models.Record{
						"_type": "caught_up",
					}
					select {
					case recordChan <- caughtUpRecord:
					case <-ctx.Done():
						return
					}
				case "error":
					// Send error as a record
					errorRecord := models.Record{
						"_type":   "error",
						"message": msg.Message,
					}
					select {
					case recordChan <- errorRecord:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()

	return recordChan, nil
}

// buildWebSocketURL constructs the WebSocket URL for TSStore streaming
func (t *TSStoreDataSource) buildWebSocketURL(query models.Query) (string, error) {
	// Get WebSocket base URL from config
	baseURL := t.config.WebSocketURL()

	// Build query parameters
	params := url.Values{}

	// API key for authentication
	if t.config.APIKey != "" {
		params.Set("api_key", t.config.APIKey)
	}

	// Start point: default to "now" for real-time streaming
	from := "now"
	if f, ok := query.Params["from"].(string); ok && f != "" {
		from = f
	} else if f, ok := query.Params["from"].(int64); ok {
		from = strconv.FormatInt(f, 10)
	} else if f, ok := query.Params["from"].(float64); ok {
		from = strconv.FormatInt(int64(f), 10)
	}
	params.Set("from", from)

	// For schema stores, request compact format
	if t.config.DataType == models.TSStoreDataTypeSchema {
		params.Set("format", "compact")
	}

	// Optional filter
	if filter, ok := query.Params["filter"].(string); ok && filter != "" {
		params.Set("filter", filter)
		if ignoreCase, ok := query.Params["filter_ignore_case"].(bool); ok && ignoreCase {
			params.Set("filter_ignore_case", "true")
		}
	}

	return fmt.Sprintf("%s/api/stores/%s/ws/read?%s", baseURL, t.config.StoreName, params.Encode()), nil
}

// wsMessageToRecord converts a WebSocket data message to a Record
func (t *TSStoreDataSource) wsMessageToRecord(msg *wsMessage) models.Record {
	record := models.Record{
		"_type":     "data",
		"timestamp": msg.Timestamp / 1e9, // nanoseconds -> seconds
	}

	// Parse the data based on store type
	switch t.config.DataType {
	case models.TSStoreDataTypeText:
		var text string
		if err := json.Unmarshal(msg.Data, &text); err != nil {
			text = string(msg.Data)
		}
		record["data"] = text

	case models.TSStoreDataTypeSchema:
		// Pass through compact data - frontend will expand using schema
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			record["data"] = string(msg.Data)
		} else {
			// Merge compact data into record (keys are indices like "1", "2", etc.)
			for k, v := range data {
				record[k] = v
			}
		}

	default: // JSON
		var data map[string]interface{}
		if err := json.Unmarshal(msg.Data, &data); err != nil {
			record["data"] = string(msg.Data)
		} else {
			for k, v := range data {
				record[k] = v
			}
		}
	}

	return record
}

// schemaFieldsToInterface converts schema fields to interface slice for JSON
func (t *TSStoreDataSource) schemaFieldsToInterface(fields []tsStoreSchemaField) []map[string]interface{} {
	result := make([]map[string]interface{}, len(fields))
	for i, f := range fields {
		result[i] = map[string]interface{}{
			"index": f.Index,
			"name":  f.Name,
			"type":  f.Type,
		}
	}
	return result
}

// Close closes the TSStore datasource
func (t *TSStoreDataSource) Close() error {
	return nil
}

// TestConnection tests the connection to TSStore and returns store info
// TestConnection runs in two stages so a passing result actually
// means "the dashboard can use this connection end-to-end" — not
// just "the host is reachable."
//
//  1. GetStoreStats — hits /api/stores/:store/stats, which ts-store
//     leaves unauthenticated by design (monitoring/dashboards poll
//     it without a key). Confirms the host is up, the store exists,
//     protocol/host/port/store_name are right, and lets us auto-
//     detect the data type below.
//  2. probeAuth — hits an authenticated endpoint (/alerts) to
//     confirm the api_key is actually accepted by this store.
//     ts-store keys are stored as per-store hashes; a key that's
//     valid for one store can 401 on another (the homelab seed
//     misses a store, ts-store data was reset, etc.). Stage 1 alone
//     wouldn't catch this — the symptom would surface later when a
//     downstream feature tried to read data or hit the alerts
//     aggregator.
//
// The alerts endpoint is the cheapest authenticated probe: it's
// always present (unlike /schema, which 400s for non-schema stores),
// has no side effects (unlike /metrics/reset), and returns at most a
// small JSON list (often empty), so the round-trip is fast.
func (t *TSStoreDataSource) TestConnection(ctx context.Context) error {
	stats, err := t.GetStoreStats(ctx)
	if err != nil {
		return err
	}

	// Auto-detect and set data type from store if not configured
	if t.config.DataType == "" {
		switch stats.DataType {
		case "json":
			t.config.DataType = models.TSStoreDataTypeJSON
		case "schema":
			t.config.DataType = models.TSStoreDataTypeSchema
		case "text":
			t.config.DataType = models.TSStoreDataTypeText
		default:
			t.config.DataType = models.TSStoreDataTypeJSON
		}
	}

	return t.probeAuth(ctx)
}

// probeAuth hits an authenticated endpoint so TestConnection can
// catch a wrong / missing / unseeded api_key at edit time. Returns
// nil on any 2xx; shapes a clear error on 401/403 so the user knows
// the fix is in the store's keys.json (or the api_key field), not
// the network.
func (t *TSStoreDataSource) probeAuth(ctx context.Context) error {
	url := fmt.Sprintf("%s/api/stores/%s/alerts", t.config.BaseURL(), t.config.StoreName)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return err
	}
	t.addHeaders(req)

	resp, err := t.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("authenticated probe failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		if t.config.APIKey == "" {
			return fmt.Errorf("authentication required: this store expects an API key but none is configured")
		}
		return fmt.Errorf("api_key rejected by store '%s' (HTTP %d): the key is missing from this store's keys.json on the ts-store host. ts-store keys are per-store hashes — verify the seed reached this store/host", t.config.StoreName, resp.StatusCode)
	}
	return fmt.Errorf("authenticated probe returned HTTP %d", resp.StatusCode)
}
