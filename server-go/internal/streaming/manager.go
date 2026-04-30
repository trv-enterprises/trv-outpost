// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"context"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// Manager orchestrates multiple streaming connections
type Manager struct {
	streams      map[string]Streamer
	mu           sync.RWMutex
	repo         *repository.ConnectionRepository
	config       ManagerConfig
	ctx          context.Context
	cancelFunc   context.CancelFunc
}

// ManagerConfig holds configuration for the stream manager
type ManagerConfig struct {
	BufferSize          int           // Records to buffer per stream (default 100)
	CleanupGracePeriod  time.Duration // Time to keep stream alive with no subscribers (default 60s)
	CleanupInterval     time.Duration // How often to check for cleanup (default 30s)
}

// DefaultManagerConfig returns default manager configuration
func DefaultManagerConfig() ManagerConfig {
	return ManagerConfig{
		BufferSize:          100,
		CleanupGracePeriod:  60 * time.Second,
		CleanupInterval:     30 * time.Second,
	}
}

// NewManager creates a new stream manager
func NewManager(repo *repository.ConnectionRepository, config ManagerConfig) *Manager {
	ctx, cancel := context.WithCancel(context.Background())

	m := &Manager{
		streams:    make(map[string]Streamer),
		repo:       repo,
		config:     config,
		ctx:        ctx,
		cancelFunc: cancel,
	}

	// Start cleanup goroutine
	go m.cleanupLoop()

	return m
}

// SubscribeWithTopics creates or gets a stream for the datasource and subscribes with specific topic filters.
// For MQTT streams, this subscribes only to the requested topics at the broker level.
// For non-MQTT streams, topics are ignored and it behaves like SubscribeAndGetChannel.
func (m *Manager) SubscribeWithTopics(ctx context.Context, connectionID string, topics []string) chan models.Record {
	m.mu.Lock()
	defer m.mu.Unlock()

	// Check if stream already exists
	stream, exists := m.streams[connectionID]
	if !exists {
		stream = m.createStream(ctx, connectionID)
		if stream == nil {
			return nil
		}
	}

	// If MQTT stream, use topic-aware subscription
	if mqttStream, ok := stream.(*MQTTStream); ok && len(topics) > 0 {
		return mqttStream.SubscribeWithTopics(topics)
	}

	return stream.Subscribe()
}

// GetBufferFiltered returns buffered records filtered by topic patterns (for MQTT streams).
// For non-MQTT streams, returns the full buffer.
func (m *Manager) GetBufferFiltered(connectionID string, topics []string) []models.Record {
	m.mu.RLock()
	stream, exists := m.streams[connectionID]
	m.mu.RUnlock()

	if !exists {
		return []models.Record{}
	}

	if mqttStream, ok := stream.(*MQTTStream); ok && len(topics) > 0 {
		return mqttStream.GetBufferFiltered(topics)
	}

	return stream.GetBuffer()
}

// createStream creates and starts a new stream for the given datasource.
// Must be called with m.mu held. Returns nil on failure.
func (m *Manager) createStream(ctx context.Context, connectionID string) Streamer {
	ds, err := m.repo.FindByID(ctx, connectionID)
	if err != nil {
		log.Printf("[StreamManager] Failed to get datasource: %v", err)
		return nil
	}
	if ds == nil {
		log.Printf("[StreamManager] Datasource not found: %s", connectionID)
		return nil
	}

	streamConfig := StreamConfig{
		BufferSize: m.config.BufferSize,
	}

	var stream Streamer
	switch ds.Type {
	case models.ConnectionTypeSocket:
		if ds.Config.Socket == nil {
			log.Printf("[StreamManager] Datasource %s has no socket configuration", connectionID)
			return nil
		}
		stream = NewStream(connectionID, ds.Config.Socket, streamConfig)

	case models.ConnectionTypeTSStore:
		if ds.Config.TSStore == nil {
			log.Printf("[StreamManager] Datasource %s has no TSStore configuration", connectionID)
			return nil
		}
		stream = NewTSStoreStream(connectionID, ds.Config.TSStore, streamConfig)

	case models.ConnectionTypeMQTT:
		if ds.Config.MQTT == nil {
			log.Printf("[StreamManager] Datasource %s has no MQTT configuration", connectionID)
			return nil
		}
		stream = NewMQTTStream(connectionID, ds.Config.MQTT, streamConfig)

	default:
		log.Printf("[StreamManager] Datasource %s is not a streaming type (got: %s)", connectionID, ds.Type)
		return nil
	}

	if err := stream.Start(m.ctx); err != nil {
		log.Printf("[StreamManager] Failed to start stream: %v", err)
		return nil
	}

	m.streams[connectionID] = stream
	log.Printf("[StreamManager] Created stream for datasource %s (type: %s)", connectionID, ds.Type)
	return stream
}

// SubscribeAndGetChannel creates or gets a stream for the datasource and returns a bidirectional channel
// This is useful when the caller needs to pass the channel to Unsubscribe later
func (m *Manager) SubscribeAndGetChannel(ctx context.Context, connectionID string) chan models.Record {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, exists := m.streams[connectionID]
	if !exists {
		stream = m.createStream(ctx, connectionID)
		if stream == nil {
			return nil
		}
	}

	return stream.Subscribe()
}

// Subscribe creates or gets a stream for the datasource and returns a subscriber channel
func (m *Manager) Subscribe(ctx context.Context, connectionID string) (<-chan models.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, exists := m.streams[connectionID]
	if !exists {
		stream = m.createStream(ctx, connectionID)
		if stream == nil {
			return nil, fmt.Errorf("failed to create stream for datasource %s", connectionID)
		}
	}

	return stream.Subscribe(), nil
}

// Unsubscribe removes a subscriber from a stream
// Note: The caller must pass a bidirectional channel that was returned by Subscribe()
func (m *Manager) Unsubscribe(connectionID string, ch chan models.Record) {
	m.mu.RLock()
	stream, exists := m.streams[connectionID]
	m.mu.RUnlock()

	if !exists {
		return
	}

	stream.Unsubscribe(ch)
}

// GetBuffer returns the buffered records for a datasource
func (m *Manager) GetBuffer(connectionID string) []models.Record {
	m.mu.RLock()
	stream, exists := m.streams[connectionID]
	m.mu.RUnlock()

	if !exists {
		return []models.Record{}
	}

	return stream.GetBuffer()
}

// GetStreamStatus returns status information for a stream
func (m *Manager) GetStreamStatus(connectionID string) *StreamStatus {
	m.mu.RLock()
	stream, exists := m.streams[connectionID]
	m.mu.RUnlock()

	if !exists {
		return nil
	}

	return &StreamStatus{
		ConnectionID:    connectionID,
		Connected:       stream.IsConnected(),
		SubscriberCount: stream.SubscriberCount(),
		BufferCount:     stream.BufferCount(),
		LastError:       stream.LastError(),
	}
}

// StreamStatus contains status information for a stream
type StreamStatus struct {
	ConnectionID    string
	Connected       bool
	SubscriberCount int
	BufferCount     int
	LastError       error
}

// ListStreams returns a list of active stream IDs
func (m *Manager) ListStreams() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	ids := make([]string, 0, len(m.streams))
	for id := range m.streams {
		ids = append(ids, id)
	}
	return ids
}

// cleanupLoop periodically checks for streams with no subscribers and removes them
func (m *Manager) cleanupLoop() {
	ticker := time.NewTicker(m.config.CleanupInterval)
	defer ticker.Stop()

	// Track when streams became idle (no subscribers)
	idleSince := make(map[string]time.Time)

	for {
		select {
		case <-m.ctx.Done():
			return
		case <-ticker.C:
			m.mu.Lock()
			now := time.Now()

			for id, stream := range m.streams {
				if stream.SubscriberCount() == 0 {
					// No subscribers - track or cleanup
					if since, exists := idleSince[id]; exists {
						if now.Sub(since) > m.config.CleanupGracePeriod {
							// Grace period exceeded, cleanup
							log.Printf("[StreamManager] Cleaning up idle stream %s", id)
							stream.Stop()
							delete(m.streams, id)
							delete(idleSince, id)
						}
					} else {
						// Start tracking idle time
						idleSince[id] = now
						log.Printf("[StreamManager] Stream %s has no subscribers, will cleanup in %v", id, m.config.CleanupGracePeriod)
					}
				} else {
					// Has subscribers, remove from idle tracking
					delete(idleSince, id)
				}
			}

			m.mu.Unlock()
		}
	}
}

// Stop stops the manager and all streams
func (m *Manager) Stop() {
	m.cancelFunc()

	m.mu.Lock()
	defer m.mu.Unlock()

	for id, stream := range m.streams {
		log.Printf("[StreamManager] Stopping stream %s", id)
		stream.Stop()
	}

	m.streams = make(map[string]Streamer)
	log.Println("[StreamManager] Stopped")
}

// IsStreamingConnection checks if a datasource supports streaming
// Socket and MQTT are always streaming; TSStore only when transport is "streaming"
func (m *Manager) IsStreamingConnection(ctx context.Context, connectionID string) (bool, error) {
	ds, err := m.repo.FindByID(ctx, connectionID)
	if err != nil {
		return false, err
	}
	if ds == nil {
		return false, fmt.Errorf("datasource not found")
	}
	switch ds.Type {
	case models.ConnectionTypeSocket, models.ConnectionTypeMQTT:
		return true, nil
	case models.ConnectionTypeTSStore:
		return ds.Config.TSStore != nil && ds.Config.TSStore.IsStreaming(), nil
	default:
		return false, nil
	}
}
