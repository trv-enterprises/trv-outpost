// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TSStoreStream represents a streaming connection from a TSStore datasource
// In ts-store v0.2.2+, streaming works via outbound push:
// 1. Dashboard calls ts-store API to create a push connection
// 2. ts-store dials out to dashboard's inbound WebSocket endpoint
// 3. Dashboard receives data on the inbound endpoint
type TSStoreStream struct {
	connectionID string
	config       *models.TSStoreConfig
	subscribers  map[chan models.Record]struct{}
	buffer       *RingBuffer
	mu           sync.RWMutex
	cancelFunc   context.CancelFunc
	connected    bool
	lastError    error
	pushID       string             // ts-store push connection ID (server-side identifier for the push lifecycle)
	inboundChan  chan models.Record // channel to receive from inbound handler
}

// tsStorePushConnectionRequest is the request body for creating a push connection
type tsStorePushConnectionRequest struct {
	Mode             string `json:"mode"`                         // "push"
	URL              string `json:"url"`                          // WebSocket URL of dashboard's inbound endpoint
	From             int64  `json:"from"`                         // Starting timestamp (nanoseconds)
	Format           string `json:"format,omitempty"`             // "full" or "compact"
	Filter           string `json:"filter,omitempty"`             // Optional substring filter
	FilterIgnoreCase bool   `json:"filter_ignore_case,omitempty"` // Case-insensitive filter
	AggWindow        string `json:"agg_window,omitempty"`         // Aggregation window (e.g., "1m")
	AggFields        string `json:"agg_fields,omitempty"`         // Per-field aggregation
	AggDefault       string `json:"agg_default,omitempty"`        // Default aggregation function
}

// tsStorePushConnectionResponse is the response from creating a push connection
type tsStorePushConnectionResponse struct {
	ID        string `json:"id"`
	Mode      string `json:"mode"`
	URL       string `json:"url"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	Error     string `json:"error,omitempty"`
}

// NewTSStoreStream creates a new stream for a TSStore datasource
func NewTSStoreStream(connectionID string, config *models.TSStoreConfig, streamConfig StreamConfig) Streamer {
	bufferSize := streamConfig.BufferSize
	if bufferSize <= 0 {
		bufferSize = 100
	}

	return &TSStoreStream{
		connectionID: connectionID,
		config:       config,
		subscribers:  make(map[chan models.Record]struct{}),
		buffer:       NewRingBuffer(bufferSize),
	}
}

// Start begins the TSStore streaming connection
func (ts *TSStoreStream) Start(ctx context.Context) error {
	streamCtx, cancel := context.WithCancel(ctx)
	ts.cancelFunc = cancel

	// Subscribe to inbound handler to receive data from ts-store
	inboundHandler := GetInboundHandler()
	ts.inboundChan = inboundHandler.Subscribe(ts.connectionID)

	// Create push connection with ts-store
	if err := ts.createPushConnection(streamCtx); err != nil {
		inboundHandler.Unsubscribe(ts.connectionID, ts.inboundChan)
		return fmt.Errorf("failed to create push connection: %w", err)
	}

	ts.mu.Lock()
	ts.connected = true
	ts.mu.Unlock()

	// Start goroutine to receive from inbound handler and broadcast to subscribers
	go ts.receiveLoop(streamCtx)

	return nil
}

// cleanupStalePushConnections lists existing push connections on ts-store and deletes
// any that target our inbound URL. This clears persisted cursors so the new connection
// starts fresh with from=-1 instead of resuming from a stale position.
func (ts *TSStoreStream) cleanupStalePushConnections(ctx context.Context, inboundURL string) {
	apiURL := fmt.Sprintf("%s/api/stores/%s/ws/connections", ts.config.BaseURL(), ts.config.StoreName)

	req, err := http.NewRequestWithContext(ctx, "GET", apiURL, nil)
	if err != nil {
		return
	}
	if ts.config.APIKey != "" {
		req.Header.Set("X-API-Key", ts.config.APIKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[TSStoreStream %s] Failed to list push connections: %v", ts.connectionID, err)
		return
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		log.Printf("[TSStoreStream %s] List push connections returned %d: %s", ts.connectionID, resp.StatusCode, string(body))
		return
	}

	// Parse response — ts-store returns an array directly
	var connections []struct {
		ID  string `json:"id"`
		URL string `json:"url"`
	}
	if err := json.Unmarshal(body, &connections); err != nil {
		// Try unwrapping from { connections: [...] } envelope
		var envelope struct {
			Connections []struct {
				ID  string `json:"id"`
				URL string `json:"url"`
			} `json:"connections"`
		}
		if err2 := json.Unmarshal(body, &envelope); err2 == nil {
			connections = envelope.Connections
		} else {
			log.Printf("[TSStoreStream %s] Failed to parse push connections list: %s", ts.connectionID, string(body[:200]))
		}
	}

	log.Printf("[TSStoreStream %s] Found %d existing push connections, looking for URL: %s", ts.connectionID, len(connections), inboundURL)
	for _, conn := range connections {
		if conn.URL == inboundURL {
			log.Printf("[TSStoreStream %s] Deleting stale push connection %s (URL: %s)", ts.connectionID, conn.ID, conn.URL)
			delURL := fmt.Sprintf("%s/%s", apiURL, conn.ID)
			delReq, err := http.NewRequestWithContext(ctx, "DELETE", delURL, nil)
			if err != nil {
				continue
			}
			if ts.config.APIKey != "" {
				delReq.Header.Set("X-API-Key", ts.config.APIKey)
			}
			delResp, err := client.Do(delReq)
			if err != nil {
				continue
			}
			delResp.Body.Close()
		}
	}
}

// createPushConnection calls ts-store API to create a push connection
func (ts *TSStoreStream) createPushConnection(ctx context.Context) error {
	// Build the inbound URL that ts-store will connect to
	// Use the configured dashboard host or default to localhost
	dashboardHost := ts.getDashboardHost()
	inboundURL := GetInboundURL(dashboardHost, ts.connectionID)

	// Clean up any stale push connections that target our inbound URL
	// This ensures ts-store doesn't resume from a persisted cursor
	ts.cleanupStalePushConnections(ctx, inboundURL)

	// Build request
	pushConfig := ts.config.Push
	req := tsStorePushConnectionRequest{
		Mode: "push",
		URL:  inboundURL,
		From: -1, // Default to current time (realtime only)
	}

	if pushConfig != nil {
		req.From = -1 // Always start from now (realtime only)
		req.Format = pushConfig.Format
		req.Filter = pushConfig.Filter
		req.FilterIgnoreCase = pushConfig.FilterIgnoreCase
		req.AggWindow = pushConfig.AggWindow
		req.AggFields = pushConfig.AggFields
		req.AggDefault = pushConfig.AggDefault
	}

	// Use "full" format by default
	if req.Format == "" {
		req.Format = "full"
	}

	reqBody, err := json.Marshal(req)
	if err != nil {
		return fmt.Errorf("failed to marshal request: %w", err)
	}

	log.Printf("[TSStoreStream %s] Push request: %s", ts.connectionID, string(reqBody))

	// Build API URL
	apiURL := fmt.Sprintf("%s/api/stores/%s/ws/connections", ts.config.BaseURL(), ts.config.StoreName)

	log.Printf("[TSStoreStream %s] Creating push connection to %s, inbound URL: %s", ts.connectionID, apiURL, inboundURL)

	// Create HTTP request
	httpReq, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(reqBody))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")
	if ts.config.APIKey != "" {
		httpReq.Header.Set("X-API-Key", ts.config.APIKey)
	}
	for k, v := range ts.config.Headers {
		httpReq.Header.Set(k, v)
	}

	// Execute request
	client := &http.Client{
		Timeout: time.Duration(ts.getTimeout()) * time.Second,
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("failed to call ts-store API: %w", err)
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return fmt.Errorf("ts-store API error (status %d): %s", resp.StatusCode, string(body))
	}

	// Parse response
	var pushResp tsStorePushConnectionResponse
	if err := json.Unmarshal(body, &pushResp); err != nil {
		return fmt.Errorf("failed to parse response: %w", err)
	}

	if pushResp.Error != "" {
		return fmt.Errorf("ts-store error: %s", pushResp.Error)
	}

	ts.pushID = pushResp.ID
	log.Printf("[TSStoreStream %s] Push connection created: ID=%s, status=%s", ts.connectionID, pushResp.ID, pushResp.Status)

	return nil
}

// deletePushConnection removes the push connection from ts-store
func (ts *TSStoreStream) deletePushConnection(ctx context.Context) error {
	if ts.pushID == "" {
		return nil
	}

	apiURL := fmt.Sprintf("%s/api/stores/%s/ws/connections/%s", ts.config.BaseURL(), ts.config.StoreName, ts.pushID)

	httpReq, err := http.NewRequestWithContext(ctx, "DELETE", apiURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	if ts.config.APIKey != "" {
		httpReq.Header.Set("X-API-Key", ts.config.APIKey)
	}

	client := &http.Client{
		Timeout: 10 * time.Second,
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return fmt.Errorf("failed to delete push connection: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusNoContent {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to delete push connection (status %d): %s", resp.StatusCode, string(body))
	}

	log.Printf("[TSStoreStream %s] Push connection deleted: ID=%s", ts.connectionID, ts.pushID)
	ts.pushID = ""

	return nil
}

// getDashboardHost returns the dashboard host address for the inbound
// WebSocket URL. Resolution order:
//
//  1. DASHBOARD_HOST env var — explicit, always wins. This is what
//     the homelab Ansible role sets from `lan_ip`, and what users
//     should set in shell/.env for local dev with a remote ts-store.
//  2. discoverReachableHostIP() — autodiscovery picks an interface
//     on a safe private subnet (RFC1918 minus Docker, plus CGNAT
//     for Tailscale). Overlay networks like Tailscale are preferred
//     over physical LAN since they're more likely to be reachable
//     from another host in dev setups.
//  3. localhost:<port> with a warning — only works when ts-store
//     runs on this host.
//
// The discovery fallback is intentionally conservative — it only
// returns an address we can confidently advertise. The v0.6.4
// version returned the first non-loopback IP it found, which often
// turned out to be a Docker bridge IP. The current implementation
// allowlists subnets and excludes Docker bridges by both subnet and
// interface name.
func (ts *TSStoreStream) getDashboardHost() string {
	if host := os.Getenv("DASHBOARD_HOST"); host != "" {
		return host
	}
	if ip := discoverReachableHostIP(); ip != "" {
		return fmt.Sprintf("%s:%d", ip, serverPort)
	}
	log.Printf("[TSStoreStream] WARNING: DASHBOARD_HOST not set and no reachable LAN/overlay IP found — falling back to localhost:%d (push will only work if ts-store runs on this host)", serverPort)
	return fmt.Sprintf("localhost:%d", serverPort)
}

// getTimeout returns the configured timeout or default
func (ts *TSStoreStream) getTimeout() int {
	if ts.config.Timeout > 0 {
		return ts.config.Timeout
	}
	return 30
}

// receiveLoop receives records from the inbound handler and broadcasts to subscribers
func (ts *TSStoreStream) receiveLoop(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			ts.cleanup(ctx)
			return
		case record, ok := <-ts.inboundChan:
			if !ok {
				// Channel closed
				ts.mu.Lock()
				ts.connected = false
				ts.mu.Unlock()
				return
			}

			// Broadcast to subscribers
			ts.broadcast([]models.Record{record})
		}
	}
}

// broadcast sends records to all subscribers and adds to buffer
func (ts *TSStoreStream) broadcast(records []models.Record) {
	ts.mu.RLock()
	subscribers := make([]chan models.Record, 0, len(ts.subscribers))
	for ch := range ts.subscribers {
		subscribers = append(subscribers, ch)
	}
	ts.mu.RUnlock()

	// Get the aggregator registry for feeding bucket aggregators
	registry := GetRegistry()

	for _, record := range records {
		// Add to buffer
		ts.buffer.Push(record)

		// Feed to bucket aggregators for this datasource
		registry.FeedRecord(ts.connectionID, record)

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
func (ts *TSStoreStream) Subscribe() chan models.Record {
	ch := make(chan models.Record, 100) // Buffered channel

	ts.mu.Lock()
	ts.subscribers[ch] = struct{}{}
	ts.mu.Unlock()

	log.Printf("[TSStoreStream %s] Subscriber added (total: %d)", ts.connectionID, len(ts.subscribers))
	return ch
}

// Unsubscribe removes a subscriber
func (ts *TSStoreStream) Unsubscribe(ch chan models.Record) {
	ts.mu.Lock()
	delete(ts.subscribers, ch)
	count := len(ts.subscribers)
	ts.mu.Unlock()

	close(ch)
	log.Printf("[TSStoreStream %s] Subscriber removed (total: %d)", ts.connectionID, count)
}

// GetBuffer returns the current buffer contents
func (ts *TSStoreStream) GetBuffer() []models.Record {
	return ts.buffer.GetAll()
}

// BufferCount returns the number of records in the buffer
func (ts *TSStoreStream) BufferCount() int {
	return ts.buffer.Count()
}

// SubscriberCount returns the number of active subscribers
func (ts *TSStoreStream) SubscriberCount() int {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return len(ts.subscribers)
}

// IsConnected returns whether the stream is connected
func (ts *TSStoreStream) IsConnected() bool {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.connected
}

// LastError returns the last error, if any
func (ts *TSStoreStream) LastError() error {
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.lastError
}

// Stop stops the stream and closes the connection
func (ts *TSStoreStream) Stop() {
	if ts.cancelFunc != nil {
		ts.cancelFunc()
	}
}

// cleanup removes the push connection and cleans up resources
func (ts *TSStoreStream) cleanup(ctx context.Context) {
	ts.mu.Lock()
	defer ts.mu.Unlock()

	// Delete the push connection from ts-store
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := ts.deletePushConnection(cleanupCtx); err != nil {
		log.Printf("[TSStoreStream %s] Error deleting push connection: %v", ts.connectionID, err)
	}

	// Unsubscribe from inbound handler
	if ts.inboundChan != nil {
		GetInboundHandler().Unsubscribe(ts.connectionID, ts.inboundChan)
		ts.inboundChan = nil
	}

	ts.connected = false
	log.Printf("[TSStoreStream %s] Cleaned up", ts.connectionID)
}
