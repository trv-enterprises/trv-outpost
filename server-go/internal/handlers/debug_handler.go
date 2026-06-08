// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/ai"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for debug endpoint
	},
}

// DebugHandler handles WebSocket connections for AI debug streaming
type DebugHandler struct{}

// NewDebugHandler creates a new debug handler
func NewDebugHandler() *DebugHandler {
	return &DebugHandler{}
}

// HandleDebugWebSocket handles WebSocket connections for debug streaming
// @Summary Connect to AI debug WebSocket
// @Description Stream real-time debug events from the AI agent including LLM requests, responses, and tool calls
// @Tags debug
// @Produce json
// @Success 101 {string} string "Switching Protocols"
// @Router /ai/debug [get]
func (h *DebugHandler) HandleDebugWebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to upgrade to WebSocket"})
		return
	}

	// Register with client registry
	clientRegistry := registry.GetClientRegistry()
	clientID := clientRegistry.Register(registry.ConnectionTypeDebug, map[string]interface{}{
		"remote_addr": c.Request.RemoteAddr,
	})

	// Get the debug hub and register this connection
	hub := ai.GetDebugHub()
	hub.Register(conn)

	// Send welcome message
	conn.WriteJSON(map[string]interface{}{
		"type":    "connected",
		"message": "Connected to AI debug stream",
		"clients": hub.ClientCount(),
	})

	// Keep the connection open and handle incoming messages (if any)
	go func() {
		defer func() {
			hub.Unregister(conn)
			clientRegistry.Unregister(clientID)
		}()
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				break
			}
			// We don't process incoming messages, just keep connection alive
		}
	}()
}

// GetDebugStatus returns the current debug hub status
// @Summary Get debug status
// @Description Get the current status of the AI debug system
// @Tags debug
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Router /ai/debug/status [get]
func (h *DebugHandler) GetDebugStatus(c *gin.Context) {
	hub := ai.GetDebugHub()
	c.JSON(http.StatusOK, gin.H{
		"enabled":      true,
		"clients":      hub.ClientCount(),
		"websocket_url": "/api/ai/debug",
	})
}
