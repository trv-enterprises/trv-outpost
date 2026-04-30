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

// InboundHandler manages incoming WebSocket connections from external data sources (e.g., ts-store push)
type InboundHandler struct {
	upgrader    websocket.Upgrader
	connections map[string]*inboundConnection // keyed by datasource ID
	listeners   map[string][]chan models.Record // listeners for each datasource
	mu          sync.RWMutex
}

// inboundConnection represents an active inbound WebSocket connection
type inboundConnection struct {
	conn             *websocket.Conn
	connectionID     string
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
// Route: GET /api/streams/inbound/:connectionId
func (h *InboundHandler) HandleInboundWebSocket(c *gin.Context) {
	connectionID := c.Param("connectionId")
	if connectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connectionId is required"})
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[InboundHandler] Failed to upgrade connection for %s: %v", connectionID, err)
		return
	}

	log.Printf("[InboundHandler] Accepted inbound connection for datasource %s from %s", connectionID, c.Request.RemoteAddr)

	// Register the connection
	h.mu.Lock()
	// Close existing connection if any
	if existing, exists := h.connections[connectionID]; exists {
		close(existing.stopChan)
		existing.conn.Close()
	}

	// Register with client registry
	clientRegistry := clientreg.GetClientRegistry()
	clientRegistryID := clientRegistry.Register(clientreg.ConnectionTypeInbound, map[string]interface{}{
		"connection_id": connectionID,
		"remote_addr":   c.Request.RemoteAddr,
	})

	ic := &inboundConnection{
		conn:             conn,
		connectionID:     connectionID,
		stopChan:         make(chan struct{}),
		clientRegistryID: clientRegistryID,
	}
	h.connections[connectionID] = ic
	h.mu.Unlock()

	// Start reading messages
	go h.readLoop(ic)
}

// readLoop reads messages from the inbound connection and broadcasts to listeners
func (h *InboundHandler) readLoop(ic *inboundConnection) {
	defer func() {
		h.mu.Lock()
		if current, exists := h.connections[ic.connectionID]; exists && current == ic {
			delete(h.connections, ic.connectionID)
		}
		h.mu.Unlock()

		// Unregister from client registry
		if ic.clientRegistryID > 0 {
			clientRegistry := clientreg.GetClientRegistry()
			clientRegistry.Unregister(ic.clientRegistryID)
		}

		ic.conn.Close()
		log.Printf("[InboundHandler] Connection closed for datasource %s", ic.connectionID)
	}()

	for {
		select {
		case <-ic.stopChan:
			return
		default:
			_, message, err := ic.conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("[InboundHandler] Read error for %s: %v", ic.connectionID, err)
				}
				return
			}

			// Parse the ts-store message
			var msg tsStorePushMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Printf("[InboundHandler] Failed to parse message for %s: %v", ic.connectionID, err)
				continue
			}

			if msg.Type != "data" {
				continue
			}

			// Convert to Record
			record := h.messageToRecord(&msg)

			// Broadcast to listeners
			h.broadcast(ic.connectionID, record)
		}
	}
}

// messageToRecord converts a ts-store push message to a Record
func (h *InboundHandler) messageToRecord(msg *tsStorePushMessage) models.Record {
	record := models.Record{
		"timestamp": msg.Timestamp / 1e9, // nanoseconds -> seconds
	}

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

	return record
}

// broadcast sends a record to all listeners for a datasource
func (h *InboundHandler) broadcast(connectionID string, record models.Record) {
	h.mu.RLock()
	listeners := h.listeners[connectionID]
	h.mu.RUnlock()

	for _, ch := range listeners {
		select {
		case ch <- record:
		default:
			// Channel full, skip (listener is slow)
		}
	}
}

// Subscribe adds a listener for a datasource and returns a channel for receiving records
func (h *InboundHandler) Subscribe(connectionID string) chan models.Record {
	ch := make(chan models.Record, 100)

	h.mu.Lock()
	h.listeners[connectionID] = append(h.listeners[connectionID], ch)
	count := len(h.listeners[connectionID])
	h.mu.Unlock()

	log.Printf("[InboundHandler] Subscriber added for %s (total: %d)", connectionID, count)
	return ch
}

// Unsubscribe removes a listener
func (h *InboundHandler) Unsubscribe(connectionID string, ch chan models.Record) {
	h.mu.Lock()
	defer h.mu.Unlock()

	listeners := h.listeners[connectionID]
	for i, listener := range listeners {
		if listener == ch {
			// Remove from slice
			h.listeners[connectionID] = append(listeners[:i], listeners[i+1:]...)
			close(ch)
			log.Printf("[InboundHandler] Subscriber removed for %s (total: %d)", connectionID, len(h.listeners[connectionID]))
			return
		}
	}
}

// IsConnected checks if there's an active inbound connection for a datasource
func (h *InboundHandler) IsConnected(connectionID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	_, exists := h.connections[connectionID]
	return exists
}

// CloseConnection closes an inbound connection
func (h *InboundHandler) CloseConnection(connectionID string) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if ic, exists := h.connections[connectionID]; exists {
		close(ic.stopChan)
		ic.conn.Close()
		delete(h.connections, connectionID)
		log.Printf("[InboundHandler] Closed connection for %s", connectionID)
	}
}

// GetInboundURL returns the WebSocket URL that ts-store should connect to
// The dashboardHost is the external address of the dashboard server
func GetInboundURL(dashboardHost string, connectionID string) string {
	return "ws://" + dashboardHost + "/api/streams/inbound/" + connectionID
}
