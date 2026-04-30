// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/database"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
	"github.com/trv-enterprises/trve-dashboard/internal/version"
)

// StatusHandler handles the WebSocket status endpoint
type StatusHandler struct {
	mongodb       *database.MongoDB
	streamManager *streaming.Manager
	startTime     time.Time
}

// NewStatusHandler creates a new status handler
func NewStatusHandler(mongodb *database.MongoDB, streamManager *streaming.Manager) *StatusHandler {
	return &StatusHandler{
		mongodb:       mongodb,
		streamManager: streamManager,
		startTime:     time.Now(),
	}
}

// ServiceStatus represents the health status of a service
type ServiceStatus struct {
	Status    string `json:"status"`
	LatencyMs int64  `json:"latency_ms"`
	Error     string `json:"error,omitempty"`
}

// StatusPayload is the complete status message
type StatusPayload struct {
	Timestamp   time.Time                  `json:"timestamp"`
	Server      ServerInfo                 `json:"server"`
	Services    map[string]ServiceStatus   `json:"services"`
	Connections ConnectionSummary          `json:"connections"`
	Streams     StreamSummary              `json:"streams"`
}

// ServerInfo contains server metadata
type ServerInfo struct {
	Version    string  `json:"version"`
	Build      string  `json:"build"`
	GitCommit  string  `json:"git_commit"`
	UptimeSecs float64 `json:"uptime_secs"`
}

// ConnectionSummary aggregates connection info
type ConnectionSummary struct {
	TotalClients    int                            `json:"total_clients"`
	TotalWebsockets int                            `json:"total_websockets"`
	ByType          map[string]int                 `json:"by_type"`
	Connections     []registry.ClientConnectionInfo `json:"connections"`
}

// StreamSummary aggregates stream info
type StreamSummary struct {
	ActiveCount int                    `json:"active_count"`
	Streams     []StreamInfo           `json:"streams"`
	Aggregators map[string]interface{} `json:"aggregators"`
}

// StreamInfo represents a single stream's status
type StreamInfo struct {
	ConnectionID    string `json:"connection_id"`
	Connected       bool   `json:"connected"`
	SubscriberCount int    `json:"subscriber_count"`
	BufferCount     int    `json:"buffer_count"`
}

// HandleStatusWebSocket provides a WebSocket endpoint for status monitoring
// @Summary Subscribe to server status via WebSocket
// @Description WebSocket endpoint that pushes server status at specified intervals
// @Tags system
// @Param interval query string false "Update interval (e.g., '5s', '1s'). Default: 5s, Min: 1s, 0 means one-shot"
// @Success 101 {string} string "Switching Protocols"
// @Router /api/ws/status [get]
func (h *StatusHandler) HandleStatusWebSocket(c *gin.Context) {
	// Parse interval parameter
	intervalStr := c.DefaultQuery("interval", "5s")

	var interval time.Duration
	var oneShot bool

	if intervalStr == "0" {
		oneShot = true
	} else {
		parsed, err := time.ParseDuration(intervalStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid interval format"})
			return
		}

		// Enforce minimum interval of 1 second
		if parsed < time.Second {
			parsed = time.Second
		}
		interval = parsed
	}

	// Upgrade to WebSocket
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Printf("[StatusHandler] Failed to upgrade connection: %v\n", err)
		return
	}
	defer conn.Close()

	// Register this connection with the client registry
	clientRegistry := registry.GetClientRegistry()
	clientID := clientRegistry.Register(registry.ConnectionTypeStatusMonitor, map[string]interface{}{
		"interval": intervalStr,
		"one_shot": oneShot,
	})
	defer clientRegistry.Unregister(clientID)

	fmt.Printf("[StatusHandler] Status WebSocket connected (client: %d, interval: %s)\n", clientID, intervalStr)

	// Send initial status
	status := h.buildStatus()
	if err := h.sendStatus(conn, status); err != nil {
		fmt.Printf("[StatusHandler] Error sending initial status: %v\n", err)
		return
	}

	// If one-shot, close connection
	if oneShot {
		fmt.Printf("[StatusHandler] One-shot mode, closing connection\n")
		return
	}

	// Start ticker for periodic updates
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Monitor for client disconnect
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	}()

	// Main loop
	for {
		select {
		case <-ticker.C:
			status := h.buildStatus()
			if err := h.sendStatus(conn, status); err != nil {
				fmt.Printf("[StatusHandler] Error sending status: %v\n", err)
				return
			}

		case <-done:
			fmt.Printf("[StatusHandler] Client %d disconnected\n", clientID)
			return
		}
	}
}

// buildStatus creates a complete status payload
func (h *StatusHandler) buildStatus() *StatusPayload {
	now := time.Now()

	// Get version info
	versionInfo := version.Info()

	// Build server info
	serverInfo := ServerInfo{
		Version:    versionInfo["version"],
		Build:      versionInfo["build"],
		GitCommit:  versionInfo["git_commit"],
		UptimeSecs: now.Sub(h.startTime).Seconds(),
	}

	// Check service health
	services := make(map[string]ServiceStatus)
	services["mongodb"] = h.checkMongoDB()

	// Get connection stats from client registry
	clientRegistry := registry.GetClientRegistry()
	connStats := clientRegistry.GetStats()
	allConnections := clientRegistry.GetAllConnections()

	connectionSummary := ConnectionSummary{
		TotalClients:    connStats.TotalClients,
		TotalWebsockets: connStats.TotalClients,
		ByType:          connStats.ByType,
		Connections:     allConnections,
	}

	// Get stream info from StreamManager
	streamSummary := h.buildStreamSummary()

	return &StatusPayload{
		Timestamp:   now,
		Server:      serverInfo,
		Services:    services,
		Connections: connectionSummary,
		Streams:     streamSummary,
	}
}

// checkMongoDB pings MongoDB and returns status with latency
func (h *StatusHandler) checkMongoDB() ServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	err := h.mongodb.Client.Ping(ctx, nil)
	latency := time.Since(start)

	if err != nil {
		return ServiceStatus{
			Status:    "unhealthy",
			LatencyMs: latency.Milliseconds(),
			Error:     err.Error(),
		}
	}

	return ServiceStatus{
		Status:    "healthy",
		LatencyMs: latency.Milliseconds(),
	}
}

// buildStreamSummary gathers stream information
func (h *StatusHandler) buildStreamSummary() StreamSummary {
	streamIDs := h.streamManager.ListStreams()

	streams := make([]StreamInfo, 0, len(streamIDs))
	for _, id := range streamIDs {
		status := h.streamManager.GetStreamStatus(id)
		if status != nil {
			streams = append(streams, StreamInfo{
				ConnectionID:    status.ConnectionID,
				Connected:       status.Connected,
				SubscriberCount: status.SubscriberCount,
				BufferCount:     status.BufferCount,
			})
		}
	}

	// Get aggregator stats
	aggRegistry := streaming.GetRegistry()
	aggStats := aggRegistry.Stats()

	return StreamSummary{
		ActiveCount: len(streams),
		Streams:     streams,
		Aggregators: aggStats,
	}
}

// sendStatus sends a status payload over WebSocket
func (h *StatusHandler) sendStatus(conn *websocket.Conn, status *StatusPayload) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}
