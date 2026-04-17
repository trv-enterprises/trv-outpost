// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package datasource

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// SocketDataSource implements the DataSource interface for socket/WebSocket streams
type SocketDataSource struct {
	config     *models.SocketConfig
	wsConn     *websocket.Conn
	tcpConn    net.Conn
	buffer     chan models.Record
	cancelFunc context.CancelFunc
}

// NewSocketDataSource creates a new Socket datasource
func NewSocketDataSource(config *models.SocketConfig) (*SocketDataSource, error) {
	ds := &SocketDataSource{
		config: config,
		buffer: make(chan models.Record, getBufferSize(config)),
	}

	if err := ds.connect(); err != nil {
		return nil, err
	}

	return ds, nil
}

func getBufferSize(config *models.SocketConfig) int {
	if config.BufferSize > 0 {
		return config.BufferSize
	}
	return 100 // default buffer size
}

// normalizeTimestamp converts timestamps to seconds (Unix epoch)
// Detects milliseconds (13+ digits) and converts to seconds
// Handles int, int64, float64, and string types
func normalizeTimestamp(val interface{}) interface{} {
	return normalizeTimestampWithScale(val, "")
}

// normalizeTimestampWithScale converts a timestamp value to Unix seconds
// using an explicit scale hint. Scale "ns" divides by 1e9, "ms" divides by
// 1e3, anything else falls back to magnitude-based auto-detect (>1e15 → ns,
// >1e12 → ms, otherwise seconds).
func normalizeTimestampWithScale(val interface{}, scale string) interface{} {
	var ts int64

	switch v := val.(type) {
	case int:
		ts = int64(v)
	case int64:
		ts = v
	case float64:
		ts = int64(v)
	case string:
		var f float64
		if _, err := fmt.Sscanf(v, "%f", &f); err == nil {
			ts = int64(f)
		} else {
			return val
		}
	default:
		return val
	}

	switch scale {
	case "ns":
		ts = ts / 1_000_000_000
	case "ms":
		ts = ts / 1_000
	default:
		// Auto-detect by magnitude: 16+ digits → ns, 13+ digits → ms.
		// Unix seconds stay 10 digits until year 2286.
		if ts > 1_000_000_000_000_000 {
			ts = ts / 1_000_000_000
		} else if ts > 9_999_999_999 {
			ts = ts / 1_000
		}
	}

	return ts
}

// connect establishes connection based on protocol
func (s *SocketDataSource) connect() error {
	switch s.config.Protocol {
	case "websocket":
		return s.connectWebSocket()
	case "tcp":
		return s.connectTCP()
	default:
		return fmt.Errorf("unsupported protocol: %s", s.config.Protocol)
	}
}

// connectWebSocket establishes a WebSocket connection
func (s *SocketDataSource) connectWebSocket() error {
	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	headers := make(map[string][]string)
	for k, v := range s.config.Headers {
		headers[k] = []string{v}
	}

	conn, _, err := dialer.Dial(s.config.URL, headers)
	if err != nil {
		return fmt.Errorf("failed to connect to WebSocket: %w", err)
	}

	s.wsConn = conn
	return nil
}

// connectTCP establishes a TCP connection
func (s *SocketDataSource) connectTCP() error {
	conn, err := net.Dial("tcp", s.config.URL)
	if err != nil {
		return fmt.Errorf("failed to connect to TCP socket: %w", err)
	}

	s.tcpConn = conn
	return nil
}

// Query is not typically used for streaming datasources
// Instead, it collects messages over a short time period and flattens JSON fields into columns
func (s *SocketDataSource) Query(ctx context.Context, query models.Query) (*models.ResultSet, error) {
	// Start streaming
	recordChan, err := s.Stream(ctx, query)
	if err != nil {
		return nil, err
	}

	// Collect records for a limited time (e.g., 5 seconds or until context timeout)
	timeout := 5 * time.Second
	collectCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Collect all records first to discover all fields
	var records []models.Record
	for {
		select {
		case record, ok := <-recordChan:
			if !ok {
				// Channel closed
				break
			}
			records = append(records, record)

		case <-collectCtx.Done():
			// Timeout reached, process collected records
			goto processRecords
		}
	}

processRecords:
	// Build column list from all records (discover all unique fields)
	columnSet := make(map[string]bool)
	columnOrder := []string{"timestamp"} // timestamp always first
	columnSet["timestamp"] = true

	for _, record := range records {
		for key := range record {
			if !columnSet[key] {
				columnSet[key] = true
				columnOrder = append(columnOrder, key)
			}
		}
	}

	// If no records collected, return empty result with timestamp column
	if len(records) == 0 {
		return &models.ResultSet{
			Columns:  []string{"timestamp"},
			Rows:     make([][]interface{}, 0),
			Metadata: map[string]interface{}{"row_count": 0, "collection_timeout": timeout.String()},
		}, nil
	}

	// Build rows with flattened data
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

	return &models.ResultSet{
		Columns: columnOrder,
		Rows:    rows,
		Metadata: map[string]interface{}{
			"row_count":          len(rows),
			"collection_timeout": timeout.String(),
		},
	}, nil
}

// flattenValue converts nested objects/arrays to JSON strings, keeps primitives as-is
func flattenValue(val interface{}) interface{} {
	switch v := val.(type) {
	case string, int, int64, float64, bool, nil:
		return v
	case map[string]interface{}, []interface{}:
		// Nested objects/arrays - convert to JSON string
		jsonBytes, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprintf("%v", v)
		}
		return string(jsonBytes)
	default:
		return v
	}
}

// Stream starts streaming messages from the socket
func (s *SocketDataSource) Stream(ctx context.Context, query models.Query) (<-chan models.Record, error) {
	recordChan := make(chan models.Record, getBufferSize(s.config))

	streamCtx, cancel := context.WithCancel(ctx)
	s.cancelFunc = cancel

	go func() {
		defer close(recordChan)

		switch s.config.Protocol {
		case "websocket":
			s.streamWebSocket(streamCtx, recordChan)
		case "tcp":
			s.streamTCP(streamCtx, recordChan)
		}
	}()

	return recordChan, nil
}

// streamWebSocket reads messages from WebSocket
func (s *SocketDataSource) streamWebSocket(ctx context.Context, recordChan chan<- models.Record) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
			_, message, err := s.wsConn.ReadMessage()
			if err != nil {
				if s.config.ReconnectOnError {
					time.Sleep(time.Duration(s.config.ReconnectDelay) * time.Millisecond)
					if err := s.connectWebSocket(); err != nil {
						continue
					}
					continue
				}
				return
			}

			// Parse message - may return multiple records if data_path contains an array
			records := s.parseMessageToRecords(message)
			for _, record := range records {
				select {
				case recordChan <- record:
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

// streamTCP reads messages from TCP socket
func (s *SocketDataSource) streamTCP(ctx context.Context, recordChan chan<- models.Record) {
	buffer := make([]byte, 4096)

	for {
		select {
		case <-ctx.Done():
			return
		default:
			s.tcpConn.SetReadDeadline(time.Now().Add(1 * time.Second))
			n, err := s.tcpConn.Read(buffer)
			if err != nil {
				if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					continue
				}

				if s.config.ReconnectOnError {
					time.Sleep(time.Duration(s.config.ReconnectDelay) * time.Millisecond)
					s.connectTCP()
					continue
				}
				return
			}

			if n > 0 {
				record := s.parseMessage(buffer[:n])
				select {
				case recordChan <- record:
				case <-ctx.Done():
					return
				}
			}
		}
	}
}

// parseMessageToRecords converts raw bytes to one or more Records
// If the data_path points to an array, each item becomes a separate record
func (s *SocketDataSource) parseMessageToRecords(message []byte) []models.Record {
	var rawData map[string]interface{}

	// Parse JSON
	if err := json.Unmarshal(message, &rawData); err != nil {
		// If JSON parsing fails, return single record with raw data
		record := models.Record{
			"data":      string(message),
			"error":     err.Error(),
			"timestamp": time.Now().Unix(),
		}
		return []models.Record{record}
	}

	parser := s.config.Parser
	if parser == nil || parser.DataPath == "" {
		// No parser config or data path, return as single record
		// Preserve existing timestamp if present (normalized), otherwise add current time
		if ts, hasTimestamp := rawData["timestamp"]; hasTimestamp {
			rawData["timestamp"] = normalizeTimestamp(ts)
		} else {
			rawData["timestamp"] = time.Now().Unix()
		}
		return []models.Record{rawData}
	}

	// Extract data from data_path
	extracted := extractByPath(rawData, parser.DataPath)
	if extracted == nil {
		// data_path extraction failed, use raw data
		// Preserve existing timestamp if present (normalized), otherwise add current time
		if ts, hasTimestamp := rawData["timestamp"]; hasTimestamp {
			rawData["timestamp"] = normalizeTimestamp(ts)
		} else {
			rawData["timestamp"] = time.Now().Unix()
		}
		return []models.Record{rawData}
	}

	// Check if extracted data is an array
	if dataArray, ok := extracted.([]interface{}); ok {
		// Explode array into multiple records
		records := make([]models.Record, 0, len(dataArray))
		for _, item := range dataArray {
			if itemMap, ok := item.(map[string]interface{}); ok {
				record := models.Record{}
				for k, v := range itemMap {
					record[k] = v
				}
				// Apply parser config to extract timestamp_field and apply mappings
				record = s.applyParserConfigToRecord(record)
				// Ensure timestamp exists after parser config applied
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

	// If not an array, use original parseMessage logic
	return []models.Record{s.parseMessage(message)}
}

// parseMessage converts raw bytes to a Record based on MessageFormat and parser config
func (s *SocketDataSource) parseMessage(message []byte) models.Record {
	record := make(models.Record)

	switch s.config.MessageFormat {
	case "json":
		if err := json.Unmarshal(message, &record); err != nil {
			// If JSON parsing fails, store as raw data
			record["data"] = string(message)
			record["error"] = err.Error()
		} else {
			// Apply parser config if available
			record = s.applyParserConfig(record)
		}
	case "text":
		record["data"] = string(message)
	default:
		// Try JSON first, fallback to text
		if err := json.Unmarshal(message, &record); err != nil {
			record["data"] = string(message)
		} else {
			// Apply parser config if available
			record = s.applyParserConfig(record)
		}
	}

	// Only set timestamp if not already present from the data
	if _, hasTimestamp := record["timestamp"]; !hasTimestamp {
		record["timestamp"] = time.Now().Unix()
	}
	return record
}

// applyParserConfig applies the parser configuration to extract and transform data
func (s *SocketDataSource) applyParserConfig(record models.Record) models.Record {
	parser := s.config.Parser
	if parser == nil {
		return record
	}

	// Step 1: Extract timestamp from original record BEFORE data extraction
	// This allows timestamp to be at a different path than the data
	var extractedTimestamp interface{}
	if parser.TimestampField != "" {
		extractedTimestamp = extractByPath(record, parser.TimestampField)
	}

	// Step 2: Extract data from data_path if specified
	if parser.DataPath != "" {
		extracted := extractByPath(record, parser.DataPath)
		if extracted != nil {
			// If extraction returns a map, use it as the new record
			if dataMap, ok := extracted.(map[string]interface{}); ok {
				record = dataMap
			} else {
				// If it's not a map, wrap it
				record = models.Record{"value": extracted}
			}
		}
	}

	// Step 3: Add the extracted timestamp to the record (normalized to seconds)
	if extractedTimestamp != nil {
		record["timestamp"] = normalizeTimestamp(extractedTimestamp)
	} else if ts, exists := record["timestamp"]; exists {
		// Normalize existing timestamp if present
		record["timestamp"] = normalizeTimestamp(ts)
	}

	// Apply field mappings (rename fields)
	if len(parser.FieldMappings) > 0 {
		for oldName, newName := range parser.FieldMappings {
			if val, exists := record[oldName]; exists {
				record[newName] = val
				delete(record, oldName)
			}
		}
	}

	// Apply include fields filter (whitelist)
	if len(parser.IncludeFields) > 0 {
		filtered := make(models.Record)
		for _, field := range parser.IncludeFields {
			if val, exists := record[field]; exists {
				filtered[field] = val
			}
		}
		// Always preserve timestamp (already normalized in record)
		if ts, exists := record["timestamp"]; exists {
			filtered["timestamp"] = ts
		}
		record = filtered
	}

	// Apply exclude fields filter (blacklist)
	if len(parser.ExcludeFields) > 0 {
		for _, field := range parser.ExcludeFields {
			delete(record, field)
		}
	}

	return record
}

// applyParserConfigToRecord applies parser config to an individual record (already extracted from array)
// This skips data_path extraction since that's already done
func (s *SocketDataSource) applyParserConfigToRecord(record models.Record) models.Record {
	parser := s.config.Parser
	if parser == nil {
		return record
	}

	// Extract timestamp from timestamp_field if specified
	// For array items, the timestamp_field is a direct field name (not a path)
	if parser.TimestampField != "" {
		// Try direct field first
		if val, exists := record[parser.TimestampField]; exists {
			record["timestamp"] = normalizeTimestamp(val)
		} else {
			// Try as a path (for nested timestamps within the item)
			if extracted := extractByPath(record, parser.TimestampField); extracted != nil {
				record["timestamp"] = normalizeTimestamp(extracted)
			}
		}
	}

	// Normalize existing timestamp if present (even without timestamp_field config)
	if ts, exists := record["timestamp"]; exists {
		record["timestamp"] = normalizeTimestamp(ts)
	}

	// Apply field mappings (rename fields)
	if len(parser.FieldMappings) > 0 {
		for oldName, newName := range parser.FieldMappings {
			if val, exists := record[oldName]; exists {
				record[newName] = val
				delete(record, oldName)
			}
		}
	}

	// Apply include fields filter (whitelist)
	if len(parser.IncludeFields) > 0 {
		filtered := make(models.Record)
		for _, field := range parser.IncludeFields {
			if val, exists := record[field]; exists {
				filtered[field] = val
			}
		}
		// Always preserve timestamp
		if ts, exists := record["timestamp"]; exists {
			filtered["timestamp"] = ts
		}
		record = filtered
	}

	// Apply exclude fields filter (blacklist)
	if len(parser.ExcludeFields) > 0 {
		for _, field := range parser.ExcludeFields {
			delete(record, field)
		}
	}

	return record
}

// extractByPath navigates a map using dot notation (e.g., "data", "payload.readings")
func extractByPath(data map[string]interface{}, path string) interface{} {
	if path == "" {
		return data
	}

	parts := strings.Split(path, ".")
	var current interface{} = data

	for _, part := range parts {
		switch v := current.(type) {
		case map[string]interface{}:
			val, exists := v[part]
			if !exists {
				return nil
			}
			current = val
		default:
			// Can't navigate further
			return nil
		}
	}

	return current
}

// Close closes the socket connection
func (s *SocketDataSource) Close() error {
	if s.cancelFunc != nil {
		s.cancelFunc()
	}

	if s.wsConn != nil {
		return s.wsConn.Close()
	}

	if s.tcpConn != nil {
		return s.tcpConn.Close()
	}

	return nil
}
