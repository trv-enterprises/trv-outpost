// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register WebSocket adapters
	registry.Register(
		"stream.websocket",
		"WebSocket (Read-Only)",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		websocketConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newWebSocketAdapterFromConfig(config)
		},
	)

	registry.Register(
		"stream.websocket-bidir",
		"WebSocket (Bidirectional)",
		registry.Capabilities{CanRead: true, CanWrite: true, CanStream: true},
		websocketConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newWebSocketBidirAdapterFromConfig(config)
		},
	)
}

// websocketConfigSchema returns configuration fields for WebSocket adapters
func websocketConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "url", Type: "string", Required: true, Description: "WebSocket URL (ws:// or wss://)"},
		{Name: "headers", Type: "object", Required: false, Description: "Custom headers"},
		{Name: "reconnect_on_error", Type: "bool", Required: false, Default: true, Description: "Auto-reconnect on error"},
		{Name: "reconnect_delay", Type: "int", Required: false, Default: 1000, Description: "Reconnect delay (ms)"},
		{Name: "ping_interval", Type: "int", Required: false, Default: 30, Description: "Ping interval (seconds)"},
		{Name: "buffer_size", Type: "int", Required: false, Default: 100, Description: "Message buffer size"},
		{Name: "data_path", Type: "string", Required: false, Description: "JSON path to data payload"},
		{Name: "timestamp_field", Type: "string", Required: false, Description: "Field containing timestamp"},
		{Name: "insecure_skip_verify", Type: "bool", Required: false, Default: false, Description: "Skip TLS certificate verification for wss:// endpoints (self-signed certs). Server must also have api.allow_insecure_tls enabled."},
	}
}

// WebSocketAdapter implements registry.Adapter for WebSocket connections (read-only)
type WebSocketAdapter struct {
	config     *models.SocketConfig
	conn       *websocket.Conn
	mu         sync.RWMutex
	cancelFunc context.CancelFunc
}

// newWebSocketAdapterFromConfig creates a WebSocket adapter from config map
func newWebSocketAdapterFromConfig(config map[string]interface{}) (*WebSocketAdapter, error) {
	socketConfig := &models.SocketConfig{
		Protocol: "websocket",
	}

	if url, ok := config["url"].(string); ok {
		socketConfig.URL = url
	}
	if headers, ok := config["headers"].(map[string]interface{}); ok {
		socketConfig.Headers = make(map[string]string)
		for k, v := range headers {
			if sv, ok := v.(string); ok {
				socketConfig.Headers[k] = sv
			}
		}
	}
	if reconnect, ok := config["reconnect_on_error"].(bool); ok {
		socketConfig.ReconnectOnError = reconnect
	}
	if delay, ok := config["reconnect_delay"].(float64); ok {
		socketConfig.ReconnectDelay = int(delay)
	} else if delay, ok := config["reconnect_delay"].(int); ok {
		socketConfig.ReconnectDelay = delay
	}
	if ping, ok := config["ping_interval"].(float64); ok {
		socketConfig.PingInterval = int(ping)
	} else if ping, ok := config["ping_interval"].(int); ok {
		socketConfig.PingInterval = ping
	}
	if bufSize, ok := config["buffer_size"].(float64); ok {
		socketConfig.BufferSize = int(bufSize)
	} else if bufSize, ok := config["buffer_size"].(int); ok {
		socketConfig.BufferSize = bufSize
	}
	if skip, ok := config["insecure_skip_verify"].(bool); ok {
		socketConfig.InsecureSkipVerify = skip
	}

	// Parser config — connection-level. data_path and timestamp_field unwrap
	// the JSON envelope; timestamp_scale hints how to interpret numeric
	// timestamps (ns / ms / empty=auto). When the connection is in text mode
	// (message_format != "json") this config is ignored by the adapter — text
	// payloads land verbatim in `data`.
	parser := &models.SocketParserConfig{}
	if dataPath, ok := config["data_path"].(string); ok {
		parser.DataPath = dataPath
	}
	if tsField, ok := config["timestamp_field"].(string); ok {
		parser.TimestampField = tsField
	}
	if scale, ok := config["timestamp_scale"].(string); ok {
		parser.TimestampScale = scale
	}
	if parser.DataPath != "" || parser.TimestampField != "" || parser.TimestampScale != "" {
		socketConfig.Parser = parser
	}

	return &WebSocketAdapter{
		config: socketConfig,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *WebSocketAdapter) TypeID() string {
	return "stream.websocket"
}

// DisplayName returns a human-readable name
func (a *WebSocketAdapter) DisplayName() string {
	return "WebSocket (Read-Only)"
}

// Capabilities returns what this adapter can do
func (a *WebSocketAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *WebSocketAdapter) ConfigSchema() []registry.ConfigField {
	return websocketConfigSchema()
}

// Connect establishes the WebSocket connection
func (a *WebSocketAdapter) Connect(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.conn != nil {
		return nil // Already connected
	}

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}
	if strings.HasPrefix(strings.ToLower(a.config.URL), "wss://") {
		if a.config.InsecureSkipVerify && !IsInsecureTLSAllowed() {
			log.Printf("websocket adapter %s: insecure_skip_verify is set on this connection but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it", a.config.URL)
		}
		if a.config.InsecureSkipVerify && IsInsecureTLSAllowed() {
			dialer.TLSClientConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec // gated by server-wide allow + per-connection flag
		}
	}

	headers := make(map[string][]string)
	for k, v := range a.config.Headers {
		headers[k] = []string{v}
	}

	conn, _, err := dialer.DialContext(ctx, a.config.URL, headers)
	if err != nil {
		return fmt.Errorf("failed to connect to WebSocket: %w", err)
	}

	a.conn = conn
	return nil
}

// TestConnection verifies the connection works
func (a *WebSocketAdapter) TestConnection(ctx context.Context) error {
	if err := a.Connect(ctx); err != nil {
		return err
	}
	return a.Close()
}

// Close closes the WebSocket connection
func (a *WebSocketAdapter) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.cancelFunc != nil {
		a.cancelFunc()
		a.cancelFunc = nil
	}

	if a.conn != nil {
		err := a.conn.Close()
		a.conn = nil
		return err
	}
	return nil
}

// Query collects messages for a period and returns as ResultSet
func (a *WebSocketAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	if err := a.Connect(ctx); err != nil {
		return nil, err
	}

	recordChan, err := a.Stream(ctx, query)
	if err != nil {
		return nil, err
	}

	// Collect records for limited time
	timeout := 5 * time.Second
	collectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var records []registry.Record
	for {
		select {
		case record, ok := <-recordChan:
			if !ok {
				goto processRecords
			}
			records = append(records, record)
		case <-collectCtx.Done():
			goto processRecords
		}
	}

processRecords:
	// Build column list from all records
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"}
	columnSet["timestamp"] = true

	for _, record := range records {
		for key := range record {
			if !columnSet[key] {
				columnSet[key] = true
				columnOrder = append(columnOrder, key)
			}
		}
	}

	if len(records) == 0 {
		return &registry.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0, "collection_timeout": timeout.String()},
		}, nil
	}

	// Build rows
	rows := make([][]interface{}, 0, len(records))
	for _, record := range records {
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

	return &registry.ResultSet{
		Columns:  columnOrder,
		Rows:     rows,
		Metadata: map[string]interface{}{"row_count": len(rows), "collection_timeout": timeout.String()},
	}, nil
}

// Stream starts streaming messages from the WebSocket
func (a *WebSocketAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
	if err := a.Connect(ctx); err != nil {
		return nil, err
	}

	bufferSize := a.config.BufferSize
	if bufferSize <= 0 {
		bufferSize = 100
	}

	recordChan := make(chan registry.Record, bufferSize)

	streamCtx, cancel := context.WithCancel(ctx)
	a.mu.Lock()
	a.cancelFunc = cancel
	a.mu.Unlock()

	go func() {
		defer close(recordChan)

		for {
			select {
			case <-streamCtx.Done():
				return
			default:
				a.mu.RLock()
				conn := a.conn
				a.mu.RUnlock()

				if conn == nil {
					return
				}

				_, message, err := conn.ReadMessage()
				if err != nil {
					if a.config.ReconnectOnError {
						time.Sleep(time.Duration(a.config.ReconnectDelay) * time.Millisecond)
						if err := a.Connect(streamCtx); err != nil {
							continue
						}
						continue
					}
					return
				}

				records := a.parseMessageToRecords(message)
				for _, record := range records {
					select {
					case recordChan <- record:
					case <-streamCtx.Done():
						return
					}
				}
			}
		}
	}()

	return recordChan, nil
}

// Write is not supported for read-only WebSocket adapter
func (a *WebSocketAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("stream.websocket is read-only; use stream.websocket-bidir for write operations")
}

// parseMessageToRecords converts raw bytes to one or more Records
func (a *WebSocketAdapter) parseMessageToRecords(message []byte) []registry.Record {
	var rawData map[string]interface{}

	if err := json.Unmarshal(message, &rawData); err != nil {
		record := registry.Record{
			"data":      string(message),
			"error":     err.Error(),
			"timestamp": time.Now().Unix(),
		}
		return []registry.Record{record}
	}

	parser := a.config.Parser
	if parser == nil || parser.DataPath == "" {
		if ts, hasTimestamp := rawData["timestamp"]; hasTimestamp {
			rawData["timestamp"] = normalizeTimestamp(ts)
		} else {
			rawData["timestamp"] = time.Now().Unix()
		}
		return []registry.Record{rawData}
	}

	extracted := extractByPath(rawData, parser.DataPath)
	if extracted == nil {
		if ts, hasTimestamp := rawData["timestamp"]; hasTimestamp {
			rawData["timestamp"] = normalizeTimestamp(ts)
		} else {
			rawData["timestamp"] = time.Now().Unix()
		}
		return []registry.Record{rawData}
	}

	if dataArray, ok := extracted.([]interface{}); ok {
		records := make([]registry.Record, 0, len(dataArray))
		for _, item := range dataArray {
			if itemMap, ok := item.(map[string]interface{}); ok {
				record := registry.Record{}
				for k, v := range itemMap {
					record[k] = v
				}
				record = a.applyParserConfig(record)
				if _, hasTimestamp := record["timestamp"]; !hasTimestamp {
					record["timestamp"] = time.Now().Unix()
				}
				records = append(records, record)
			}
		}
		if len(records) > 0 {
			return records
		}
	}

	// Single object
	record := registry.Record{}
	if dataMap, ok := extracted.(map[string]interface{}); ok {
		for k, v := range dataMap {
			record[k] = v
		}
	} else {
		record["value"] = extracted
	}
	record = a.applyParserConfig(record)
	if _, hasTimestamp := record["timestamp"]; !hasTimestamp {
		record["timestamp"] = time.Now().Unix()
	}
	return []registry.Record{record}
}

// applyParserConfig applies parser configuration to a record
func (a *WebSocketAdapter) applyParserConfig(record registry.Record) registry.Record {
	parser := a.config.Parser
	if parser == nil {
		return record
	}

	// Extract timestamp from a named field (using the scale hint when set).
	if parser.TimestampField != "" {
		if val, exists := record[parser.TimestampField]; exists {
			record["timestamp"] = normalizeTimestampWithScale(val, parser.TimestampScale)
		}
	}

	// Normalize whatever timestamp we now hold (covers both the path above
	// and timestamps that arrived under the conventional `timestamp` key).
	if ts, exists := record["timestamp"]; exists {
		record["timestamp"] = normalizeTimestampWithScale(ts, parser.TimestampScale)
	}

	// Apply field mappings
	if len(parser.FieldMappings) > 0 {
		for oldName, newName := range parser.FieldMappings {
			if val, exists := record[oldName]; exists {
				record[newName] = val
				delete(record, oldName)
			}
		}
	}

	// Apply include fields filter
	if len(parser.IncludeFields) > 0 {
		filtered := make(registry.Record)
		for _, field := range parser.IncludeFields {
			if val, exists := record[field]; exists {
				filtered[field] = val
			}
		}
		if ts, exists := record["timestamp"]; exists {
			filtered["timestamp"] = ts
		}
		record = filtered
	}

	// Apply exclude fields filter
	if len(parser.ExcludeFields) > 0 {
		for _, field := range parser.ExcludeFields {
			delete(record, field)
		}
	}

	return record
}

// ============================================================================
// WebSocketBidirAdapter - Bidirectional WebSocket with Write support
// ============================================================================

// WebSocketBidirAdapter extends WebSocketAdapter with Write capability
type WebSocketBidirAdapter struct {
	WebSocketAdapter // Embeds base - inherits Query, Stream, Connect
}

// newWebSocketBidirAdapterFromConfig creates a bidirectional WebSocket adapter
func newWebSocketBidirAdapterFromConfig(config map[string]interface{}) (*WebSocketBidirAdapter, error) {
	base, err := newWebSocketAdapterFromConfig(config)
	if err != nil {
		return nil, err
	}
	return &WebSocketBidirAdapter{WebSocketAdapter: *base}, nil
}

// TypeID returns the adapter type identifier
func (a *WebSocketBidirAdapter) TypeID() string {
	return "stream.websocket-bidir"
}

// DisplayName returns a human-readable name
func (a *WebSocketBidirAdapter) DisplayName() string {
	return "WebSocket (Bidirectional)"
}

// Capabilities returns what this adapter can do
func (a *WebSocketBidirAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: true, CanStream: true}
}

// Write sends a command through the WebSocket connection
func (a *WebSocketBidirAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.conn == nil {
		return nil, fmt.Errorf("not connected")
	}

	// Marshal command to JSON
	data, err := json.Marshal(cmd)
	if err != nil {
		return &registry.WriteResult{
			Success:   false,
			Message:   fmt.Sprintf("failed to marshal command: %v", err),
			Timestamp: time.Now(),
		}, err
	}

	// Send through WebSocket
	if err := a.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		return &registry.WriteResult{
			Success:   false,
			Message:   err.Error(),
			Timestamp: time.Now(),
		}, err
	}

	return &registry.WriteResult{
		Success:   true,
		Message:   "Command sent successfully",
		Timestamp: time.Now(),
	}, nil
}
