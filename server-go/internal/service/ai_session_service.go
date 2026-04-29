// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// WSClient represents a connected WebSocket client
type WSClient struct {
	ID        string
	SessionID string
	Conn      *websocket.Conn
	Done      chan struct{}
	mu        sync.Mutex // protects Conn writes
}

// AISessionService handles AI session business logic
type AISessionService struct {
	sessionRepo   *repository.AISessionRepository
	chartRepo     *repository.ComponentRepository
	dashboardRepo *repository.DashboardRepository

	// WebSocket client management
	clients   map[string]map[string]*WSClient // sessionID -> clientID -> client
	clientsMu sync.RWMutex
}

// NewAISessionService creates a new AI session service
func NewAISessionService(sessionRepo *repository.AISessionRepository, chartRepo *repository.ComponentRepository, dashboardRepo *repository.DashboardRepository) *AISessionService {
	return &AISessionService{
		sessionRepo:   sessionRepo,
		chartRepo:     chartRepo,
		dashboardRepo: dashboardRepo,
		clients:       make(map[string]map[string]*WSClient),
	}
}

// CreateSession creates a new AI session and chart draft
func (s *AISessionService) CreateSession(ctx context.Context, req *models.CreateAISessionRequest) (*models.AISessionResponse, error) {
	var chart *models.Component
	var chartVersion int

	if req.ChartID != "" {
		// Editing existing chart - check for existing draft
		existingDraft, err := s.chartRepo.FindDraft(ctx, req.ChartID)
		if err != nil {
			return nil, fmt.Errorf("error checking for existing draft: %w", err)
		}
		if existingDraft != nil {
			// Check if there's already an active session for this chart
			existingSession, err := s.sessionRepo.FindByChartID(ctx, req.ChartID)
			if err != nil {
				return nil, fmt.Errorf("error checking for existing session: %w", err)
			}
			if existingSession != nil && existingSession.Status == models.AISessionStatusActive {
				return nil, fmt.Errorf("chart already has an active AI session - delete the draft first")
			}
			// Draft exists but no active session - delete the orphaned draft
			if err := s.chartRepo.DeleteVersion(ctx, req.ChartID, existingDraft.Version); err != nil {
				return nil, fmt.Errorf("error deleting orphaned draft: %w", err)
			}
		}

		// Get the latest final version
		latestFinal, err := s.chartRepo.FindLatestFinal(ctx, req.ChartID)
		if err != nil {
			return nil, fmt.Errorf("error finding latest final version: %w", err)
		}
		if latestFinal == nil {
			return nil, fmt.Errorf("chart not found")
		}

		// Create new draft version based on latest final
		maxVersion, err := s.chartRepo.GetMaxVersion(ctx, req.ChartID)
		if err != nil {
			return nil, fmt.Errorf("error getting max version: %w", err)
		}

		chartVersion = maxVersion + 1
		chart = &models.Component{
			ID:            latestFinal.ID,
			Version:       chartVersion,
			Status:        models.ComponentStatusDraft,
			Name:          latestFinal.Name,
			Description:   latestFinal.Description,
			ChartType:     latestFinal.ChartType,
			DatasourceID:  latestFinal.DatasourceID,
			QueryConfig:   latestFinal.QueryConfig,
			DataMapping:   latestFinal.DataMapping,
			ComponentCode: latestFinal.ComponentCode,
			UseCustomCode: latestFinal.UseCustomCode,
			Options:       latestFinal.Options,
			Tags:          latestFinal.Tags,
		}
	} else {
		// Creating new chart - create v1 draft with temporary unique name
		// Users must rename the chart before saving (names starting with "Untitled" are rejected)
		chartID := uuid.New().String()
		chart = &models.Component{
			ID:      chartID,
			Version: 1,
			Status:  models.ComponentStatusDraft,
			Name:    fmt.Sprintf("Untitled Chart %s", chartID[:8]),
		}
		chartVersion = 1

		// Apply pre-flight context to the draft
		if req.ComponentType != "" {
			chart.ComponentType = req.ComponentType
		}
		if req.ChartType != "" {
			chart.ChartType = req.ChartType
		}
		if req.ConnectionID != "" {
			chart.DatasourceID = req.ConnectionID
		}
		if req.ControlType != "" {
			if chart.ControlConfig == nil {
				chart.ControlConfig = &models.ControlConfig{}
			}
			chart.ControlConfig.ControlType = req.ControlType
		}
	}

	// Create the session
	session := &models.AISession{
		ID:           uuid.New().String(),
		ChartID:      chart.ID,
		ChartVersion: chartVersion,
		Messages:     []models.AIMessage{},
		Status:       models.AISessionStatusActive,
		DashboardID:  req.DashboardID,
		PanelID:      req.PanelID,
	}

	// Link chart to session
	chart.AISessionID = session.ID

	// Create chart draft
	if err := s.chartRepo.CreateVersion(ctx, chart); err != nil {
		return nil, fmt.Errorf("error creating chart draft: %w", err)
	}

	// Create session
	if err := s.sessionRepo.Create(ctx, session); err != nil {
		// Rollback chart draft
		s.chartRepo.DeleteVersion(ctx, chart.ID, chart.Version)
		return nil, fmt.Errorf("error creating session: %w", err)
	}

	// Add initial message if provided
	if req.InitialMessage != "" {
		message := &models.AIMessage{
			ID:        uuid.New().String(),
			Role:      models.AIMessageRoleUser,
			Content:   req.InitialMessage,
			Timestamp: time.Now(),
		}
		if err := s.sessionRepo.AddMessage(ctx, session.ID, message); err != nil {
			return nil, fmt.Errorf("error adding initial message: %w", err)
		}
		session.Messages = append(session.Messages, *message)
	}

	return &models.AISessionResponse{
		Session: session,
		Component: chart,
	}, nil
}

// GetSession retrieves a session by ID
func (s *AISessionService) GetSession(ctx context.Context, id string) (*models.AISessionResponse, error) {
	session, err := s.sessionRepo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving session: %w", err)
	}
	if session == nil {
		return nil, fmt.Errorf("session not found")
	}

	// Get the associated chart draft
	chart, err := s.chartRepo.FindByIDAndVersion(ctx, session.ChartID, session.ChartVersion)
	if err != nil {
		return nil, fmt.Errorf("error retrieving chart draft: %w", err)
	}

	return &models.AISessionResponse{
		Session: session,
		Component: chart,
	}, nil
}

// AddMessage adds a user message to the session
func (s *AISessionService) AddMessage(ctx context.Context, sessionID string, content string) (*models.AIMessage, error) {
	session, err := s.sessionRepo.FindByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("error retrieving session: %w", err)
	}
	if session == nil {
		return nil, fmt.Errorf("session not found")
	}
	if session.Status != models.AISessionStatusActive {
		return nil, fmt.Errorf("session is not active")
	}

	message := &models.AIMessage{
		ID:        uuid.New().String(),
		Role:      models.AIMessageRoleUser,
		Content:   content,
		Timestamp: time.Now(),
	}

	if err := s.sessionRepo.AddMessage(ctx, sessionID, message); err != nil {
		return nil, fmt.Errorf("error adding message: %w", err)
	}

	// Broadcast message event to SSE clients
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeMessage,
		Data: models.AIMessageEvent{
			Message: *message,
		},
		Timestamp: time.Now(),
	})

	return message, nil
}

// AddAssistantMessage adds an assistant message (from AI)
func (s *AISessionService) AddAssistantMessage(ctx context.Context, sessionID string, content string, toolCalls []models.ToolCall) (*models.AIMessage, error) {
	message := &models.AIMessage{
		ID:        uuid.New().String(),
		Role:      models.AIMessageRoleAssistant,
		Content:   content,
		ToolCalls: toolCalls,
		Timestamp: time.Now(),
	}

	if err := s.sessionRepo.AddMessage(ctx, sessionID, message); err != nil {
		return nil, fmt.Errorf("error adding assistant message: %w", err)
	}

	// Broadcast message event
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeMessage,
		Data: models.AIMessageEvent{
			Message: *message,
		},
		Timestamp: time.Now(),
	})

	return message, nil
}

// UpdateChartDraft updates the chart draft and broadcasts the change
func (s *AISessionService) UpdateChartDraft(ctx context.Context, sessionID string, chart *models.Component) error {
	session, err := s.sessionRepo.FindByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("error retrieving session: %w", err)
	}
	if session == nil {
		return fmt.Errorf("session not found")
	}

	// Update the chart
	if err := s.chartRepo.Update(ctx, chart.ID, chart.Version, chart); err != nil {
		return fmt.Errorf("error updating chart draft: %w", err)
	}

	// Broadcast chart update event
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeComponentUpdate,
		Data: models.AIComponentUpdateEvent{
			Component: chart,
		},
		Timestamp: time.Now(),
	})

	return nil
}

// SaveSession publishes the draft as a new final version
func (s *AISessionService) SaveSession(ctx context.Context, sessionID string, chartName string) (*models.Component, error) {
	session, err := s.sessionRepo.FindByID(ctx, sessionID)
	if err != nil {
		return nil, fmt.Errorf("error retrieving session: %w", err)
	}
	if session == nil {
		return nil, fmt.Errorf("session not found")
	}

	// Get the draft
	draft, err := s.chartRepo.FindByIDAndVersion(ctx, session.ChartID, session.ChartVersion)
	if err != nil {
		return nil, fmt.Errorf("error retrieving draft: %w", err)
	}
	if draft == nil {
		return nil, fmt.Errorf("draft not found")
	}

	// Update the chart name if provided
	if chartName != "" {
		draft.Name = chartName
	}

	// Validate that the chart has been given a proper name
	if strings.HasPrefix(draft.Name, "Untitled") {
		return nil, fmt.Errorf("please provide a name for your chart before saving")
	}

	// Validate name uniqueness across different chart IDs, scoped to the
	// draft's namespace (uniqueness is (namespace, name) end-to-end).
	existingChart, err := s.chartRepo.FindByName(ctx, draft.Namespace, draft.Name)
	if err != nil {
		return nil, fmt.Errorf("error checking name uniqueness: %w", err)
	}
	if existingChart != nil && existingChart.ID != draft.ID {
		return nil, fmt.Errorf("a chart with name '%s' already exists in namespace '%s'", draft.Name, draft.Namespace)
	}

	// Update draft to final
	draft.Status = models.ComponentStatusFinal
	draft.AISessionID = ""
	if err := s.chartRepo.Update(ctx, draft.ID, draft.Version, draft); err != nil {
		return nil, fmt.Errorf("error publishing draft: %w", err)
	}

	// Mark session as completed
	if err := s.sessionRepo.UpdateStatus(ctx, sessionID, models.AISessionStatusCompleted); err != nil {
		return nil, fmt.Errorf("error updating session status: %w", err)
	}

	// Broadcast status change
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeStatus,
		Data: models.AIStatusEvent{
			Status: models.AISessionStatusCompleted,
		},
		Timestamp: time.Now(),
	})

	// Close all SSE connections for this session
	s.CloseSessionClients(sessionID)

	return draft, nil
}

// CancelSession discards the draft and cancels the session
func (s *AISessionService) CancelSession(ctx context.Context, sessionID string) error {
	session, err := s.sessionRepo.FindByID(ctx, sessionID)
	if err != nil {
		return fmt.Errorf("error retrieving session: %w", err)
	}
	if session == nil {
		return fmt.Errorf("session not found")
	}

	// Delete the draft - ignore errors if draft was already deleted
	// This can happen if the frontend deleted it first via /api/charts/:id/draft
	_ = s.chartRepo.DeleteVersion(ctx, session.ChartID, session.ChartVersion)

	// Mark session as cancelled
	if err := s.sessionRepo.UpdateStatus(ctx, sessionID, models.AISessionStatusCancelled); err != nil {
		return fmt.Errorf("error updating session status: %w", err)
	}

	// Broadcast status change
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeStatus,
		Data: models.AIStatusEvent{
			Status: models.AISessionStatusCancelled,
		},
		Timestamp: time.Now(),
	})

	// Close all SSE connections
	s.CloseSessionClients(sessionID)

	// Delete session from database
	if err := s.sessionRepo.Delete(ctx, sessionID); err != nil {
		return fmt.Errorf("error deleting session: %w", err)
	}

	return nil
}

// RegisterWSClient registers a WebSocket client for a session
func (s *AISessionService) RegisterWSClient(sessionID string, conn *websocket.Conn) *WSClient {
	client := &WSClient{
		ID:        uuid.New().String(),
		SessionID: sessionID,
		Conn:      conn,
		Done:      make(chan struct{}),
	}

	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	if s.clients[sessionID] == nil {
		s.clients[sessionID] = make(map[string]*WSClient)
	}
	s.clients[sessionID][client.ID] = client

	fmt.Printf("[WS] Client %s registered for session %s (total: %d)\n",
		client.ID, sessionID, len(s.clients[sessionID]))

	return client
}

// UnregisterWSClient removes a WebSocket client
func (s *AISessionService) UnregisterWSClient(client *WSClient) {
	s.clientsMu.Lock()
	defer s.clientsMu.Unlock()

	if sessionClients, ok := s.clients[client.SessionID]; ok {
		delete(sessionClients, client.ID)
		if len(sessionClients) == 0 {
			delete(s.clients, client.SessionID)
		}
		fmt.Printf("[WS] Client %s unregistered from session %s\n", client.ID, client.SessionID)
	}
	// Check if channel is already closed to prevent panic
	select {
	case <-client.Done:
		// Already closed
	default:
		close(client.Done)
	}
}

// BroadcastEvent sends an event to all WebSocket clients of a session
func (s *AISessionService) BroadcastEvent(sessionID string, event *models.AIEvent) {
	s.clientsMu.RLock()
	sessionClients := s.clients[sessionID]
	s.clientsMu.RUnlock()

	if len(sessionClients) == 0 {
		fmt.Printf("[WS Broadcast] No clients registered for session %s\n", sessionID)
		return
	}

	// Serialize event once
	jsonData, err := json.Marshal(event)
	if err != nil {
		fmt.Printf("[WS Broadcast] Error marshaling event: %v\n", err)
		return
	}

	fmt.Printf("[WS Broadcast] Session %s has %d clients, broadcasting event type: %s\n",
		sessionID, len(sessionClients), event.Type)

	for _, client := range sessionClients {
		client.mu.Lock()
		err := client.Conn.WriteMessage(websocket.TextMessage, jsonData)
		client.mu.Unlock()

		if err != nil {
			fmt.Printf("[WS Broadcast] Error sending to client %s: %v\n", client.ID, err)
		} else {
			fmt.Printf("[WS Broadcast] Sent event to client %s\n", client.ID)
		}
	}
}

// CloseSessionClients closes all WebSocket connections for a session
func (s *AISessionService) CloseSessionClients(sessionID string) {
	s.clientsMu.Lock()
	clients := s.clients[sessionID]
	delete(s.clients, sessionID)
	s.clientsMu.Unlock()

	for _, client := range clients {
		client.Conn.Close()
		select {
		case <-client.Done:
			// Already closed
		default:
			close(client.Done)
		}
	}
}

// SendThinkingEvent notifies clients that AI is processing
func (s *AISessionService) SendThinkingEvent(sessionID string, thinking bool) {
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeThinking,
		Data: models.AIThinkingEvent{
			Thinking: thinking,
		},
		Timestamp: time.Now(),
	})
}

// SendStreamingEvent sends partial text content during streaming
func (s *AISessionService) SendStreamingEvent(sessionID string, content string, done bool) {
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeStreaming,
		Data: models.AIStreamingEvent{
			Content: content,
			Done:    done,
		},
		Timestamp: time.Now(),
	})
}

// SendErrorEvent notifies clients of an error
func (s *AISessionService) SendErrorEvent(sessionID string, err error, code string) {
	s.BroadcastEvent(sessionID, &models.AIEvent{
		Type: models.AIEventTypeError,
		Data: models.AIErrorEvent{
			Error: err.Error(),
			Code:  code,
		},
		Timestamp: time.Now(),
	})
}
