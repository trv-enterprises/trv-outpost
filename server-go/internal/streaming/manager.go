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
	failed       map[string]*failedStream // connections whose last start failed (backoff memory)
	mu           sync.RWMutex
	repo         *repository.ConnectionRepository
	config       ManagerConfig
	ctx          context.Context
	cancelFunc   context.CancelFunc
}

// failedStream remembers a stream whose Start failed so the Manager doesn't
// re-dial the upstream on every subscribe (the source of the "many errors per
// second" loop). A terminal failure (auth) is never retried automatically; a
// transient failure is retried only once nextRetry has passed.
type failedStream struct {
	err       error
	terminal  bool
	attempts  int
	nextRetry time.Time
}

// ManagerConfig holds configuration for the stream manager
type ManagerConfig struct {
	BufferSize          int           // Records to buffer per stream (default 100)
	CleanupGracePeriod  time.Duration // Time to keep stream alive with no subscribers (default 60s)
	CleanupInterval     time.Duration // How often to check for cleanup (default 30s)
	RetryBaseDelay      time.Duration // Backoff base for transient start failures (default 1s)
	RetryMaxDelay       time.Duration // Backoff cap (default 30s)
}

// DefaultManagerConfig returns default manager configuration
func DefaultManagerConfig() ManagerConfig {
	return ManagerConfig{
		BufferSize:          100,
		CleanupGracePeriod:  60 * time.Second,
		CleanupInterval:     30 * time.Second,
		RetryBaseDelay:      1 * time.Second,
		RetryMaxDelay:       30 * time.Second,
	}
}

// NewManager creates a new stream manager
func NewManager(repo *repository.ConnectionRepository, config ManagerConfig) *Manager {
	ctx, cancel := context.WithCancel(context.Background())

	if config.RetryBaseDelay <= 0 {
		config.RetryBaseDelay = 1 * time.Second
	}
	if config.RetryMaxDelay <= 0 {
		config.RetryMaxDelay = 30 * time.Second
	}

	m := &Manager{
		streams:    make(map[string]Streamer),
		failed:     make(map[string]*failedStream),
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
func (m *Manager) SubscribeWithTopics(ctx context.Context, connectionID string, topics []string) (chan models.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, err := m.getOrCreateStream(ctx, connectionID)
	if err != nil {
		return nil, err
	}

	// If MQTT stream, use topic-aware subscription
	if mqttStream, ok := stream.(*MQTTStream); ok && len(topics) > 0 {
		return mqttStream.SubscribeWithTopics(topics), nil
	}

	return stream.Subscribe(), nil
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

// getOrCreateStream returns a live stream for the connection, applying the
// failed-stream backoff gate so a broken connection (e.g. a tsstore stream with
// a rejected api-key) doesn't get re-dialed on every subscribe. Must be called
// with m.mu held. Returns the live stream, or an error describing why it can't
// be established (the cached error within the backoff window, or a fresh start
// failure).
func (m *Manager) getOrCreateStream(ctx context.Context, connectionID string) (Streamer, error) {
	if stream, exists := m.streams[connectionID]; exists {
		return stream, nil
	}

	// Honor the backoff/terminal memory before re-dialing.
	if f, ok := m.failed[connectionID]; ok {
		if f.terminal {
			return nil, f.err // never auto-retry an auth failure
		}
		if time.Now().Before(f.nextRetry) {
			return nil, f.err // still cooling down — return cached error, no re-dial
		}
		// past the cooldown → fall through and retry
	}

	stream, err := m.createStream(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return stream, nil
}

// backoffDelay computes the exponential backoff for the Nth transient failure.
func (m *Manager) backoffDelay(attempts int) time.Duration {
	d := m.config.RetryBaseDelay << uint(attempts-1) // base * 2^(attempts-1)
	if d <= 0 || d > m.config.RetryMaxDelay {
		return m.config.RetryMaxDelay
	}
	return d
}

// recordFailure remembers a start failure so subscribes within the backoff
// window (or forever, when terminal) return the cached error instead of
// re-dialing the upstream.
func (m *Manager) recordFailure(connectionID string, err error) {
	prev := m.failed[connectionID]
	attempts := 1
	if prev != nil {
		attempts = prev.attempts + 1
	}
	terminal := false
	if se, ok := AsStreamStartError(err); ok {
		terminal = se.Terminal
	}
	f := &failedStream{err: err, terminal: terminal, attempts: attempts}
	if !terminal {
		f.nextRetry = time.Now().Add(m.backoffDelay(attempts))
	}
	m.failed[connectionID] = f
}

// createStream creates and starts a new stream for the given datasource. Must
// be called with m.mu held. On failure it records the failure for backoff and
// returns the error (so callers can surface it); on success it caches the live
// stream and clears any prior failure memory.
func (m *Manager) createStream(ctx context.Context, connectionID string) (Streamer, error) {
	fail := func(err error) (Streamer, error) {
		log.Printf("[StreamManager] Failed to start stream for %s: %v", connectionID, err)
		m.recordFailure(connectionID, err)
		return nil, err
	}

	ds, err := m.repo.FindByID(ctx, connectionID)
	if err != nil {
		return fail(&StreamStartError{Terminal: false, Message: fmt.Sprintf("could not load connection %s: %v", connectionID, err)})
	}
	if ds == nil {
		return fail(&StreamStartError{Terminal: true, Message: fmt.Sprintf("connection %s not found", connectionID)})
	}

	streamConfig := StreamConfig{
		BufferSize: m.config.BufferSize,
	}

	var stream Streamer
	switch ds.Type {
	case models.ConnectionTypeSocket:
		if ds.Config.Socket == nil {
			return fail(&StreamStartError{Terminal: true, Message: fmt.Sprintf("connection %s has no socket configuration", connectionID)})
		}
		stream = NewStream(connectionID, ds.Config.Socket, streamConfig)

	case models.ConnectionTypeTSStore:
		if ds.Config.TSStore == nil {
			return fail(&StreamStartError{Terminal: true, Message: fmt.Sprintf("connection %s has no ts-store configuration", connectionID)})
		}
		stream = NewTSStoreStream(connectionID, ds.Config.TSStore, streamConfig)

	case models.ConnectionTypeMQTT:
		if ds.Config.MQTT == nil {
			return fail(&StreamStartError{Terminal: true, Message: fmt.Sprintf("connection %s has no MQTT configuration", connectionID)})
		}
		stream = NewMQTTStream(connectionID, ds.Config.MQTT, streamConfig)

	default:
		return fail(&StreamStartError{Terminal: true, Message: fmt.Sprintf("connection %s is not a streaming type (got: %s)", connectionID, ds.Type)})
	}

	if err := stream.Start(m.ctx); err != nil {
		return fail(err)
	}

	m.streams[connectionID] = stream
	delete(m.failed, connectionID) // success clears failure memory
	log.Printf("[StreamManager] Created stream for datasource %s (type: %s)", connectionID, ds.Type)
	return stream, nil
}

// SubscribeAndGetChannel creates or gets a stream for the datasource and returns a bidirectional channel
// This is useful when the caller needs to pass the channel to Unsubscribe later
func (m *Manager) SubscribeAndGetChannel(ctx context.Context, connectionID string) (chan models.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, err := m.getOrCreateStream(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	return stream.Subscribe(), nil
}

// Subscribe creates or gets a stream for the datasource and returns a subscriber channel
func (m *Manager) Subscribe(ctx context.Context, connectionID string) (<-chan models.Record, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	stream, err := m.getOrCreateStream(ctx, connectionID)
	if err != nil {
		return nil, err
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

// GetStreamStatus returns status information for a stream. When no live stream
// exists but the last start failed, it reports Connected:false with the failure
// error (and whether it's terminal) so the SSE client can show an actionable
// message and stop reconnecting.
func (m *Manager) GetStreamStatus(connectionID string) *StreamStatus {
	m.mu.RLock()
	stream, exists := m.streams[connectionID]
	f := m.failed[connectionID]
	m.mu.RUnlock()

	if exists {
		return &StreamStatus{
			ConnectionID:    connectionID,
			Connected:       stream.IsConnected(),
			SubscriberCount: stream.SubscriberCount(),
			BufferCount:     stream.BufferCount(),
			LastError:       stream.LastError(),
		}
	}

	if f != nil {
		return &StreamStatus{
			ConnectionID: connectionID,
			Connected:    false,
			LastError:    f.err,
			Terminal:     f.terminal,
		}
	}

	return nil
}

// InvalidateStream clears any cached live stream and failure/backoff memory for
// a connection. Call this when the connection's config changes (e.g. the admin
// fixes a rejected api-key and re-saves) so the next subscribe rebuilds the
// stream with the new config — no server restart needed.
func (m *Manager) InvalidateStream(connectionID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if stream, ok := m.streams[connectionID]; ok {
		stream.Stop()
		delete(m.streams, connectionID)
	}
	delete(m.failed, connectionID)
}

// StreamStatus contains status information for a stream
type StreamStatus struct {
	ConnectionID    string
	Connected       bool
	SubscriberCount int
	BufferCount     int
	LastError       error
	// Terminal is true when LastError is a non-retryable start failure (e.g.
	// a rejected api-key) — the client should stop reconnecting and surface it.
	Terminal bool
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
