// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	clientreg "github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// InboundHandler manages incoming WebSocket connections from external data
// sources (e.g., ts-store push).
//
// Maps are keyed by STREAM KEY (#248 PR 2): the bare connection id for a
// pinned tsstore connection (unchanged pre-#248 identity), or
// "<connID>/<hash>" for a per-component store channel. Keying by channel is
// what stops two stores' pushers from evicting each other's socket — the
// one-socket-per-key rule below is per CHANNEL, not per connection.
type InboundHandler struct {
	upgrader    websocket.Upgrader
	connections map[string]*inboundConnection   // keyed by stream key
	listeners   map[string][]chan models.Record // listeners per stream key
	mu          sync.RWMutex
}

// inboundConnection represents an active inbound WebSocket connection
type inboundConnection struct {
	conn             *websocket.Conn
	streamKey        string
	stopChan         chan struct{}
	clientRegistryID uint64
}

// tsStorePushMessage represents a message from ts-store's outbound WebSocket push
type tsStorePushMessage struct {
	Type      string          `json:"type"`      // "data"
	Timestamp int64           `json:"timestamp"` // nanoseconds since Unix epoch
	Data      json.RawMessage `json:"data"`      // record payload
}

// Global singleton instance
var (
	inboundHandlerInstance *InboundHandler
	inboundHandlerOnce     sync.Once
)

// GetInboundHandler returns the global inbound handler instance
func GetInboundHandler() *InboundHandler {
	inboundHandlerOnce.Do(func() {
		inboundHandlerInstance = &InboundHandler{
			upgrader: websocket.Upgrader{
				CheckOrigin: func(r *http.Request) bool {
					return true // Allow connections from ts-store
				},
			},
			connections: make(map[string]*inboundConnection),
			listeners:   make(map[string][]chan models.Record),
		}
	})
	return inboundHandlerInstance
}

// HandleInboundWebSocket handles incoming WebSocket connections from ts-store
// Routes: GET /api/streams/inbound/:connectionId            (pinned channel)
//
//	GET /api/streams/inbound/:connectionId/:channel    (per-store channel, #248)
//
// The path IS the stream key — a pinned connection's pusher dials the bare
// connection id exactly as before #248; a per-component store channel's
// pusher dials connID/<hash>.
//
// Deliberately excluded from swagger: this is a machine-to-machine
// WebSocket endpoint (ts-store push producers dial in), not a REST API
// surface for interactive clients.
func (h *InboundHandler) HandleInboundWebSocket(c *gin.Context) {
	streamKey := c.Param("connectionId")
	if streamKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connectionId is required"})
		return
	}
	if channel := c.Param("channel"); channel != "" {
		streamKey += "/" + channel
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[InboundHandler] Failed to upgrade connection for %s: %v", streamKey, err)
		return
	}

	log.Printf("[InboundHandler] Accepted inbound connection for channel %s from %s", streamKey, c.Request.RemoteAddr)

	// Register the connection
	h.mu.Lock()
	// Close existing connection if any — one socket per CHANNEL.
	if existing, exists := h.connections[streamKey]; exists {
		close(existing.stopChan)
		existing.conn.Close()
	}

	// Register with client registry
	clientRegistry := clientreg.GetClientRegistry()
	clientRegistryID := clientRegistry.Register(clientreg.ConnectionTypeInbound, map[string]interface{}{
		"connection_id": streamKey,
		"remote_addr":   c.Request.RemoteAddr,
	})

	ic := &inboundConnection{
		conn:             conn,
		streamKey:        streamKey,
		stopChan:         make(chan struct{}),
		clientRegistryID: clientRegistryID,
	}
	h.connections[streamKey] = ic
	h.mu.Unlock()

	// Start reading messages
	go h.readLoop(ic)
}

// readLoop reads messages from the inbound connection and broadcasts to listeners
func (h *InboundHandler) readLoop(ic *inboundConnection) {
	defer func() {
		h.mu.Lock()
		if current, exists := h.connections[ic.streamKey]; exists && current == ic {
			delete(h.connections, ic.streamKey)
		}
		h.mu.Unlock()

		// Unregister from client registry
		if ic.clientRegistryID > 0 {
			clientRegistry := clientreg.GetClientRegistry()
			clientRegistry.Unregister(ic.clientRegistryID)
		}

		ic.conn.Close()
		log.Printf("[InboundHandler] Connection closed for datasource %s", ic.streamKey)
	}()

	for {
		select {
		case <-ic.stopChan:
			return
		default:
			_, message, err := ic.conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("[InboundHandler] Read error for %s: %v", ic.streamKey, err)
				}
				return
			}

			// Parse the ts-store message
			var msg tsStorePushMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Printf("[InboundHandler] Failed to parse message for %s: %v", ic.streamKey, err)
				continue
			}

			if msg.Type != "data" {
				continue
			}

			// Convert to Record
			record := h.messageToRecord(&msg)

			// Broadcast to listeners
			h.broadcast(ic.streamKey, record)
		}
	}
}

// messageToRecord converts a ts-store push message to a Record.
//
// Timestamp scale: the whole system's wire convention is epoch SECONDS
// (every raw stream uses time.Now().Unix(); the ts-store REST adapter and the
// bucket aggregator both emit seconds). msg.Timestamp is nanoseconds, so we
// normalize with /1e9. CRITICAL: the push payload's `data` map often carries
// its OWN `timestamp` field, and for push-AGGREGATED streams (agg_window set)
// ts-store emits that inner timestamp in a DIFFERENT scale (milliseconds,
// ~1.78e12) — which previously overwrote our seconds value during the merge.
// A value-axis consumer (scatter) then saw a mix of seconds (backfill) and
// milliseconds (stream) and spread points across a bogus multi-year range.
// Stamp the server-normalized seconds timestamp AFTER the merge so it always
// wins — the single source of truth for the wire scale.
func (h *InboundHandler) messageToRecord(msg *tsStorePushMessage) models.Record {
	record := models.Record{}

	// Parse the data payload
	var data map[string]interface{}
	if err := json.Unmarshal(msg.Data, &data); err != nil {
		// If not a JSON object, store as raw value
		var rawValue interface{}
		if err := json.Unmarshal(msg.Data, &rawValue); err != nil {
			record["data"] = string(msg.Data)
		} else {
			record["data"] = rawValue
		}
	} else {
		// Merge data fields into record
		for k, v := range data {
			record[k] = v
		}
	}

	// Stamp the normalized timestamp LAST so a `timestamp` from the payload
	// (possibly a different scale) can't clobber the canonical seconds value.
	record["timestamp"] = float64(msg.Timestamp) / 1e9 // nanoseconds -> seconds

	return record
}

// broadcast sends a record to all listeners for a channel
func (h *InboundHandler) broadcast(streamKey string, record models.Record) {
	h.mu.RLock()
	listeners := h.listeners[streamKey]
	h.mu.RUnlock()

	for _, ch := range listeners {
		select {
		case ch <- record:
		default:
			// Channel full, skip (listener is slow)
		}
	}
}

// Subscribe adds a listener for a channel and returns a channel for receiving records
func (h *InboundHandler) Subscribe(streamKey string) chan models.Record {
	ch := make(chan models.Record, 100)

	h.mu.Lock()
	h.listeners[streamKey] = append(h.listeners[streamKey], ch)
	count := len(h.listeners[streamKey])
	h.mu.Unlock()

	log.Printf("[InboundHandler] Subscriber added for %s (total: %d)", streamKey, count)
	return ch
}

// Unsubscribe removes a listener
func (h *InboundHandler) Unsubscribe(streamKey string, ch chan models.Record) {
	h.mu.Lock()
	defer h.mu.Unlock()

	listeners := h.listeners[streamKey]
	for i, listener := range listeners {
		if listener == ch {
			// Remove from slice
			h.listeners[streamKey] = append(listeners[:i], listeners[i+1:]...)
			close(ch)
			log.Printf("[InboundHandler] Subscriber removed for %s (total: %d)", streamKey, len(h.listeners[streamKey]))
			return
		}
	}
}

// GetInboundURL returns the WebSocket URL that ts-store should connect to.
// The dashboardHost is the external address of the dashboard server.
// streamKey is the channel identity and becomes the URL path verbatim — one
// segment for a pinned channel (the bare connection id, unchanged pre-#248
// shape), two segments ("<connID>/<hash>") for a per-component store
// channel. The key is a pure config hash, so this URL is stable across
// restarts — ts-store persists it, and stale-connection cleanup matches on
// it.
func GetInboundURL(dashboardHost string, streamKey string) string {
	return "ws://" + dashboardHost + "/api/streams/inbound/" + streamKey
}
