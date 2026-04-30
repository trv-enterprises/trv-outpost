// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func init() {
	// Register TCP adapter
	registry.Register(
		"stream.tcp",
		"TCP Socket",
		registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true},
		tcpConfigSchema(),
		func(config map[string]interface{}) (registry.Adapter, error) {
			return newTCPAdapterFromConfig(config)
		},
	)
}

// tcpConfigSchema returns configuration fields for TCP adapters
func tcpConfigSchema() []registry.ConfigField {
	return []registry.ConfigField{
		{Name: "url", Type: "string", Required: true, Description: "TCP address (host:port)"},
		{Name: "reconnect_on_error", Type: "bool", Required: false, Default: true, Description: "Auto-reconnect on error"},
		{Name: "reconnect_delay", Type: "int", Required: false, Default: 1000, Description: "Reconnect delay (ms)"},
		{Name: "buffer_size", Type: "int", Required: false, Default: 100, Description: "Message buffer size"},
		{Name: "message_format", Type: "string", Required: false, Default: "json", Options: []string{"json", "text"}, Description: "Message format"},
		// Connection-level JSON parser config — only meaningful when message_format=json.
		{Name: "data_path", Type: "string", Required: false, Description: "JSON path to the data payload (e.g. 'data', 'payload.readings')"},
		{Name: "timestamp_field", Type: "string", Required: false, Description: "Field name that carries the timestamp"},
		{Name: "timestamp_scale", Type: "string", Required: false, Options: []string{"", "ns", "ms"}, Description: "Numeric timestamp scale: ns / ms / empty=auto"},
	}
}

// TCPAdapter implements registry.Adapter for TCP socket connections
type TCPAdapter struct {
	config     *models.SocketConfig
	conn       net.Conn
	mu         sync.RWMutex
	cancelFunc context.CancelFunc
}

// newTCPAdapterFromConfig creates a TCP adapter from config map
func newTCPAdapterFromConfig(config map[string]interface{}) (*TCPAdapter, error) {
	socketConfig := &models.SocketConfig{
		Protocol: "tcp",
	}

	if url, ok := config["url"].(string); ok {
		socketConfig.URL = url
	}
	if reconnect, ok := config["reconnect_on_error"].(bool); ok {
		socketConfig.ReconnectOnError = reconnect
	}
	if delay, ok := config["reconnect_delay"].(float64); ok {
		socketConfig.ReconnectDelay = int(delay)
	} else if delay, ok := config["reconnect_delay"].(int); ok {
		socketConfig.ReconnectDelay = delay
	}
	if bufSize, ok := config["buffer_size"].(float64); ok {
		socketConfig.BufferSize = int(bufSize)
	} else if bufSize, ok := config["buffer_size"].(int); ok {
		socketConfig.BufferSize = bufSize
	}
	if format, ok := config["message_format"].(string); ok {
		socketConfig.MessageFormat = format
	}

	// Connection-level parser config (mirrors WebSocket adapter).
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

	return &TCPAdapter{
		config: socketConfig,
	}, nil
}

// TypeID returns the adapter type identifier
func (a *TCPAdapter) TypeID() string {
	return "stream.tcp"
}

// DisplayName returns a human-readable name
func (a *TCPAdapter) DisplayName() string {
	return "TCP Socket"
}

// Capabilities returns what this adapter can do
func (a *TCPAdapter) Capabilities() registry.Capabilities {
	return registry.Capabilities{CanRead: true, CanWrite: false, CanStream: true}
}

// ConfigSchema returns configuration fields
func (a *TCPAdapter) ConfigSchema() []registry.ConfigField {
	return tcpConfigSchema()
}

// Connect establishes the TCP connection
func (a *TCPAdapter) Connect(ctx context.Context) error {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.conn != nil {
		return nil
	}

	conn, err := net.Dial("tcp", a.config.URL)
	if err != nil {
		return fmt.Errorf("failed to connect to TCP socket: %w", err)
	}

	a.conn = conn
	return nil
}

// TestConnection verifies the connection works
func (a *TCPAdapter) TestConnection(ctx context.Context) error {
	if err := a.Connect(ctx); err != nil {
		return err
	}
	return a.Close()
}

// Close closes the TCP connection
func (a *TCPAdapter) Close() error {
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
func (a *TCPAdapter) Query(ctx context.Context, query registry.Query) (*registry.ResultSet, error) {
	if err := a.Connect(ctx); err != nil {
		return nil, err
	}

	recordChan, err := a.Stream(ctx, query)
	if err != nil {
		return nil, err
	}

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
			Metadata: map[string]interface{}{"row_count": 0},
		}, nil
	}

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
		Metadata: map[string]interface{}{"row_count": len(rows)},
	}, nil
}

// Stream starts streaming messages from the TCP socket
func (a *TCPAdapter) Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error) {
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

		buffer := make([]byte, 4096)

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

				conn.SetReadDeadline(time.Now().Add(1 * time.Second))
				n, err := conn.Read(buffer)
				if err != nil {
					if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
						continue
					}
					if a.config.ReconnectOnError {
						time.Sleep(time.Duration(a.config.ReconnectDelay) * time.Millisecond)
						a.Connect(streamCtx)
						continue
					}
					return
				}

				if n > 0 {
					record := a.parseMessage(buffer[:n])
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

// Write is not supported for TCP adapter
func (a *TCPAdapter) Write(ctx context.Context, cmd registry.Command) (*registry.WriteResult, error) {
	return nil, fmt.Errorf("stream.tcp does not support write operations")
}

// parseMessage converts raw bytes to a Record. JSON mode also applies the
// connection-level parser (data_path / timestamp_field / timestamp_scale)
// so every consumer of this connection sees the same unwrapped shape. Text
// mode bypasses the parser entirely — payloads land verbatim in `data`.
func (a *TCPAdapter) parseMessage(message []byte) registry.Record {
	record := make(registry.Record)

	switch a.config.MessageFormat {
	case "json":
		if err := json.Unmarshal(message, &record); err != nil {
			record["data"] = string(message)
			record["error"] = err.Error()
		} else {
			record = a.applyParserConfig(record)
		}
	case "text":
		record["data"] = string(message)
	default:
		if err := json.Unmarshal(message, &record); err != nil {
			record["data"] = string(message)
		} else {
			record = a.applyParserConfig(record)
		}
	}

	if _, hasTimestamp := record["timestamp"]; !hasTimestamp {
		record["timestamp"] = time.Now().Unix()
	}

	return record
}

// applyParserConfig applies connection-level parser config to a parsed
// JSON record: optionally re-roots at data_path, lifts a named timestamp
// field, and normalizes numeric timestamps using the scale hint.
func (a *TCPAdapter) applyParserConfig(record registry.Record) registry.Record {
	parser := a.config.Parser
	if parser == nil {
		return record
	}

	// Re-root at data_path if set, lifting the timestamp from the envelope
	// before we replace `record` with the inner object.
	if parser.DataPath != "" {
		recordMap := map[string]interface{}(record)
		var liftedTimestamp interface{}
		if parser.TimestampField != "" {
			if ts := extractByPath(recordMap, parser.TimestampField); ts != nil {
				liftedTimestamp = normalizeTimestampWithScale(ts, parser.TimestampScale)
			}
		}
		extracted := extractByPath(recordMap, parser.DataPath)
		if dataMap, ok := extracted.(map[string]interface{}); ok {
			out := make(registry.Record, len(dataMap))
			for k, v := range dataMap {
				out[k] = v
			}
			if liftedTimestamp != nil {
				out["timestamp"] = liftedTimestamp
			}
			record = out
		}
	} else if parser.TimestampField != "" {
		if val, exists := record[parser.TimestampField]; exists {
			record["timestamp"] = normalizeTimestampWithScale(val, parser.TimestampScale)
		}
	} else if ts, exists := record["timestamp"]; exists {
		// Conventional `timestamp` field already in the record — normalize it.
		record["timestamp"] = normalizeTimestampWithScale(ts, parser.TimestampScale)
	}

	return record
}
