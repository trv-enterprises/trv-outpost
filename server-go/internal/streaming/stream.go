// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Streamer is the interface that all stream implementations must satisfy
type Streamer interface {
	Start(ctx context.Context) error
	Stop()
	Subscribe() chan models.Record
	Unsubscribe(ch chan models.Record)
	GetBuffer() []models.Record
	BufferCount() int
	SubscriberCount() int
	IsConnected() bool
	LastError() error
}

// Stream represents a single streaming connection to a socket datasource
type Stream struct {
	connectionID string
	config       *models.SocketConfig
	wsConn       *websocket.Conn
	subscribers  map[chan models.Record]struct{}
	buffer       *RingBuffer
	mu           sync.RWMutex
	cancelFunc   context.CancelFunc
	connected    bool
	lastError    error
	reconnecting bool
}

// StreamConfig holds configuration for stream behavior
type StreamConfig struct {
	BufferSize         int
	ReconnectDelay     time.Duration
	MaxReconnectDelay  time.Duration
	HeartbeatInterval  time.Duration
}

// DefaultStreamConfig returns default stream configuration
func DefaultStreamConfig() StreamConfig {
	return StreamConfig{
		BufferSize:         100,
		ReconnectDelay:     time.Second,
		MaxReconnectDelay:  30 * time.Second,
		HeartbeatInterval:  30 * time.Second,
	}
}

// NewStream creates a new stream for a socket datasource
func NewStream(connectionID string, config *models.SocketConfig, streamConfig StreamConfig) *Stream {
	bufferSize := streamConfig.BufferSize
	if config.BufferSize > 0 {
		bufferSize = config.BufferSize
	}

	return &Stream{
		connectionID: connectionID,
		config:       config,
		subscribers:  make(map[chan models.Record]struct{}),
		buffer:       NewRingBuffer(bufferSize),
	}
}

// Start begins the streaming connection
func (s *Stream) Start(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	s.cancelFunc = cancel

	if err := s.connect(); err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	// Start reading goroutine
	go s.readLoop(streamCtx)

	return nil
}

// connect establishes the WebSocket connection
func (s *Stream) connect() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	dialer := websocket.Dialer{
		HandshakeTimeout: 10 * time.Second,
	}

	headers := make(map[string][]string)
	for k, v := range s.config.Headers {
		headers[k] = []string{v}
	}

	conn, _, err := dialer.Dial(s.config.URL, headers)
	if err != nil {
		s.lastError = err
		s.connected = false
		return fmt.Errorf("failed to connect to WebSocket: %w", err)
	}

	s.wsConn = conn
	s.connected = true
	s.lastError = nil
	log.Printf("[Stream %s] Connected to %s", s.connectionID, s.config.URL)

	return nil
}

// readLoop continuously reads from the WebSocket and broadcasts to subscribers
func (s *Stream) readLoop(ctx context.Context) {
	reconnectDelay := time.Second

	for {
		select {
		case <-ctx.Done():
			s.cleanup()
			return
		default:
			s.mu.RLock()
			conn := s.wsConn
			s.mu.RUnlock()

			if conn == nil {
				time.Sleep(reconnectDelay)
				continue
			}

			_, message, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[Stream %s] Read error: %v", s.connectionID, err)

				s.mu.Lock()
				s.connected = false
				s.lastError = err
				s.mu.Unlock()

				if s.config.ReconnectOnError {
					s.reconnect(ctx, &reconnectDelay)
				} else {
					s.cleanup()
					return
				}
				continue
			}

			// Reset reconnect delay on successful read
			reconnectDelay = time.Second

			// Parse message and broadcast to subscribers
			records := s.parseMessageToRecords(message)
			s.broadcast(records)
		}
	}
}

// reconnect attempts to reconnect with exponential backoff
func (s *Stream) reconnect(ctx context.Context, delay *time.Duration) {
	s.mu.Lock()
	if s.reconnecting {
		s.mu.Unlock()
		return
	}
	s.reconnecting = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.reconnecting = false
		s.mu.Unlock()
	}()

	log.Printf("[Stream %s] Reconnecting in %v...", s.connectionID, *delay)

	select {
	case <-ctx.Done():
		return
	case <-time.After(*delay):
	}

	if err := s.connect(); err != nil {
		log.Printf("[Stream %s] Reconnect failed: %v", s.connectionID, err)
		// Exponential backoff
		*delay = *delay * 2
		if *delay > 30*time.Second {
			*delay = 30 * time.Second
		}
	} else {
		*delay = time.Second
	}
}

// parseMessageToRecords converts raw bytes to records (reuses logic from socket.go)
func (s *Stream) parseMessageToRecords(message []byte) []models.Record {
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
		rawData["timestamp"] = time.Now().Unix()
		return []models.Record{rawData}
	}

	// Extract data from data_path
	extracted := extractByPath(rawData, parser.DataPath)
	if extracted == nil {
		rawData["timestamp"] = time.Now().Unix()
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
				// Ensure timestamp exists
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

	// If not an array, return as single record
	if dataMap, ok := extracted.(map[string]interface{}); ok {
		if _, hasTimestamp := dataMap["timestamp"]; !hasTimestamp {
			dataMap["timestamp"] = time.Now().Unix()
		}
		return []models.Record{dataMap}
	}

	rawData["timestamp"] = time.Now().Unix()
	return []models.Record{rawData}
}

// extractByPath navigates a map using dot notation
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
			return nil
		}
	}

	return current
}

// broadcast sends records to all subscribers and adds to buffer
func (s *Stream) broadcast(records []models.Record) {
	s.mu.RLock()
	subscribers := make([]chan models.Record, 0, len(s.subscribers))
	for ch := range s.subscribers {
		subscribers = append(subscribers, ch)
	}
	s.mu.RUnlock()

	// Get the aggregator registry for feeding bucket aggregators
	registry := GetRegistry()

	for _, record := range records {
		// Add to buffer
		s.buffer.Push(record)

		// Feed to bucket aggregators for this datasource
		registry.FeedRecord(s.connectionID, record)

		// Send to all subscribers (non-blocking)
		for _, ch := range subscribers {
			select {
			case ch <- record:
			default:
				// Channel full, skip (subscriber is slow)
			}
		}
	}
}

// Subscribe adds a new subscriber and returns a channel for receiving records
func (s *Stream) Subscribe() chan models.Record {
	ch := make(chan models.Record, 100) // Buffered channel

	s.mu.Lock()
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()

	log.Printf("[Stream %s] Subscriber added (total: %d)", s.connectionID, len(s.subscribers))
	return ch
}

// Unsubscribe removes a subscriber
func (s *Stream) Unsubscribe(ch chan models.Record) {
	s.mu.Lock()
	delete(s.subscribers, ch)
	count := len(s.subscribers)
	s.mu.Unlock()

	close(ch)
	log.Printf("[Stream %s] Subscriber removed (total: %d)", s.connectionID, count)
}

// GetBuffer returns the current buffer contents
func (s *Stream) GetBuffer() []models.Record {
	return s.buffer.GetAll()
}

// BufferCount returns the number of records in the buffer
func (s *Stream) BufferCount() int {
	return s.buffer.Count()
}

// SubscriberCount returns the number of active subscribers
func (s *Stream) SubscriberCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.subscribers)
}

// IsConnected returns whether the stream is connected
func (s *Stream) IsConnected() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.connected
}

// LastError returns the last error, if any
func (s *Stream) LastError() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastError
}

// Stop stops the stream and closes the connection
func (s *Stream) Stop() {
	if s.cancelFunc != nil {
		s.cancelFunc()
	}
}

// cleanup closes the WebSocket connection and notifies subscribers
func (s *Stream) cleanup() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.wsConn != nil {
		s.wsConn.Close()
		s.wsConn = nil
	}
	s.connected = false

	log.Printf("[Stream %s] Cleaned up", s.connectionID)
}
