// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/ai"
	"github.com/trv-enterprises/trve-dashboard/internal/hub"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// WebSocket upgrader with permissive origin check for development
var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for development
	},
}

// AISessionHandler handles AI session-related HTTP requests
type AISessionHandler struct {
	service  *service.AISessionService
	agent    *ai.Agent
	chartHub *hub.ComponentHub
}

// NewAISessionHandler creates a new AI session handler
func NewAISessionHandler(service *service.AISessionService, agent *ai.Agent, chartHub *hub.ComponentHub) *AISessionHandler {
	return &AISessionHandler{
		service:  service,
		agent:    agent,
		chartHub: chartHub,
	}
}

// CreateSession creates a new AI session
// @Summary Create a new AI session
// @Description Create a new AI session for chart creation or editing. Creates a chart draft.
// @Tags ai
// @Accept json
// @Produce json
// @Param request body models.CreateAISessionRequest true "Session creation request"
// @Success 201 {object} models.AISessionResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /ai/sessions [post]
func (h *AISessionHandler) CreateSession(c *gin.Context) {
	var req models.CreateAISessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	response, err := h.service.CreateSession(c.Request.Context(), &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already has an active AI session") {
			status = http.StatusConflict
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, response)
}

// GetSession retrieves a session by ID
// @Summary Get AI session
// @Description Get an AI session by ID with current chart state
// @Tags ai
// @Produce json
// @Param id path string true "Session ID"
// @Success 200 {object} models.AISessionResponse
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /ai/sessions/{id} [get]
func (h *AISessionHandler) GetSession(c *gin.Context) {
	id := c.Param("id")

	response, err := h.service.GetSession(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// SendMessage sends a user message to the session
// @Summary Send message to AI session
// @Description Send a user message to an AI session. The AI agent will process the message asynchronously.
// @Tags ai
// @Accept json
// @Produce json
// @Param id path string true "Session ID"
// @Param request body models.SendMessageRequest true "Message content"
// @Success 202 {object} map[string]interface{} "Message accepted for processing"
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /ai/sessions/{id}/messages [post]
func (h *AISessionHandler) SendMessage(c *gin.Context) {
	id := c.Param("id")

	var req models.SendMessageRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Add user message to session
	message, err := h.service.AddMessage(c.Request.Context(), id, req.Content)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "not active") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	// Process message with AI agent asynchronously
	// Use background context since HTTP request context will be cancelled after response
	if h.agent != nil {
		go func() {
			ctx := context.Background()

			fmt.Printf("[AI Agent] Starting to process message for session %s\n", id)

			// Get session for processing
			sessionResp, err := h.service.GetSession(ctx, id)
			if err != nil {
				fmt.Printf("[AI Agent] Error getting session: %v\n", err)
				h.service.SendErrorEvent(id, err, "session_error")
				return
			}

			fmt.Printf("[AI Agent] Got session, calling ProcessMessage\n")

			// Process the message with the AI agent
			if err := h.agent.ProcessMessage(ctx, sessionResp.Session, req.Content); err != nil {
				fmt.Printf("[AI Agent] Error processing message: %v\n", err)
				h.service.SendErrorEvent(id, err, "ai_error")
			} else {
				fmt.Printf("[AI Agent] ProcessMessage completed successfully\n")
			}
		}()
	} else {
		fmt.Printf("[AI Agent] Agent is nil, skipping AI processing\n")
	}

	// Return immediately with accepted status
	c.JSON(http.StatusAccepted, gin.H{
		"message_id": message.ID,
		"status":     "processing",
	})
}

// HandleWebSocket provides WebSocket connection for session updates
// @Summary Subscribe to AI session events via WebSocket
// @Description Subscribe to real-time updates for an AI session via WebSocket
// @Tags ai
// @Param id path string true "Session ID"
// @Success 101 {string} string "Switching Protocols"
// @Failure 404 {object} map[string]interface{}
// @Router /ai/sessions/{id}/ws [get]
func (h *AISessionHandler) HandleWebSocket(c *gin.Context) {
	id := c.Param("id")

	// Verify session exists
	response, err := h.service.GetSession(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Session not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Check if session is still active
	if response.Session.Status != models.AISessionStatusActive {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Session is not active"})
		return
	}

	// Upgrade HTTP connection to WebSocket
	conn, err := wsUpgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Printf("[WS] Failed to upgrade connection: %v\n", err)
		return
	}
	defer conn.Close()

	// Register with client registry for status monitoring
	clientRegistry := registry.GetClientRegistry()
	clientID := clientRegistry.Register(registry.ConnectionTypeAISession, map[string]interface{}{
		"session_id": id,
		"chart_id":   response.Session.ChartID,
	})
	defer clientRegistry.Unregister(clientID)

	fmt.Printf("[WS] New connection for session %s (client: %d)\n", id, clientID)

	// Register client with the AI session service
	client := h.service.RegisterWSClient(id, conn)
	defer h.service.UnregisterWSClient(client)

	// Subscribe this connection to chart updates via the ChartHub
	// This allows the connection to receive real-time updates when the chart is modified
	if h.chartHub != nil && response.Session.ChartID != "" {
		subscriberID := fmt.Sprintf("session-%s", id)
		chartSubscriber := &hub.ComponentSubscriber{
			ID:   subscriberID,
			Conn: conn,
		}
		h.chartHub.Subscribe(chartSubscriber, response.Session.ChartID)
		defer h.chartHub.UnsubscribeAll(subscriberID)
		fmt.Printf("[WS] Subscribed session %s to chart %s updates\n", id, response.Session.ChartID)
	}

	// Send initial connection event
	connectedEvent := &models.AIEvent{
		Type: "connected",
		Data: map[string]interface{}{
			"session_id": id,
		},
		Timestamp: time.Now(),
	}
	jsonData, _ := json.Marshal(connectedEvent)
	conn.WriteMessage(websocket.TextMessage, jsonData)

	// Keep-alive ticker
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	// Read messages in a goroutine (to detect disconnection)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				fmt.Printf("[WS] Read error (client disconnected): %v\n", err)
				return
			}
		}
	}()

	// Main loop
	for {
		select {
		case <-ticker.C:
			// Send keep-alive ping
			pingEvent := &models.AIEvent{
				Type: "ping",
				Data: map[string]interface{}{
					"timestamp": time.Now(),
				},
				Timestamp: time.Now(),
			}
			jsonData, _ := json.Marshal(pingEvent)
			if err := conn.WriteMessage(websocket.TextMessage, jsonData); err != nil {
				fmt.Printf("[WS] Ping error: %v\n", err)
				return
			}

		case <-client.Done:
			// Session closed by server
			fmt.Printf("[WS] Session %s closed by server\n", id)
			return

		case <-done:
			// Client disconnected
			fmt.Printf("[WS] Client disconnected from session %s\n", id)
			return
		}
	}
}

// SaveSessionRequest holds the save request payload
type SaveSessionRequest struct {
	Name string `json:"name"`
}

// SaveSession publishes the draft as final
// @Summary Save AI session (publish draft)
// @Description Save the AI session by publishing the draft as a new final version
// @Tags ai
// @Accept json
// @Produce json
// @Param id path string true "Session ID"
// @Param request body SaveSessionRequest true "Chart name"
// @Success 200 {object} models.Component
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /ai/sessions/{id}/save [post]
func (h *AISessionHandler) SaveSession(c *gin.Context) {
	id := c.Param("id")

	var req SaveSessionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	chart, err := h.service.SaveSession(c.Request.Context(), id, req.Name)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "name") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, chart)
}

// CancelSession discards the draft and ends the session
// @Summary Cancel AI session
// @Description Cancel the AI session and discard the draft
// @Tags ai
// @Param id path string true "Session ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /ai/sessions/{id} [delete]
func (h *AISessionHandler) CancelSession(c *gin.Context) {
	id := c.Param("id")

	err := h.service.CancelSession(c.Request.Context(), id)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}
