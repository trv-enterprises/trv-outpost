// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"time"
)

// AI Session status constants
const (
	AISessionStatusActive    = "active"    // Session is ongoing
	AISessionStatusCompleted = "completed" // User saved the chart
	AISessionStatusCancelled = "cancelled" // User discarded changes
)

// AI Message role constants
const (
	AIMessageRoleUser      = "user"
	AIMessageRoleAssistant = "assistant"
	AIMessageRoleSystem    = "system"
)

// AISession represents an active AI chart editing session
// @Description AI session for chart creation/editing
type AISession struct {
	ID           string      `json:"id" bson:"_id"`                            // UUID
	ChartID      string      `json:"chart_id" bson:"chart_id"`                 // Chart UUID being edited
	ChartVersion int         `json:"chart_version" bson:"chart_version"`       // Version being edited (always a draft)
	Messages     []AIMessage `json:"messages" bson:"messages"`                 // Conversation history
	Status       string      `json:"status" bson:"status"`                     // "active" | "completed" | "cancelled"
	DashboardID  string      `json:"dashboard_id,omitempty" bson:"dashboard_id,omitempty"` // Auto-attach to this dashboard on save
	PanelID      string      `json:"panel_id,omitempty" bson:"panel_id,omitempty"`         // Auto-attach to this panel on save
	Created      time.Time   `json:"created" bson:"created"`
	Updated      time.Time   `json:"updated" bson:"updated"`
	ExpiresAt    time.Time   `json:"expires_at" bson:"expires_at"`
}

// AIMessage represents a single message in the AI conversation
// @Description A message in the AI conversation
type AIMessage struct {
	ID        string     `json:"id" bson:"id"`
	Role      string     `json:"role" bson:"role"`                             // "user" | "assistant" | "system"
	Content   string     `json:"content" bson:"content"`
	ToolCalls []ToolCall `json:"tool_calls,omitempty" bson:"tool_calls,omitempty"`
	Timestamp time.Time  `json:"timestamp" bson:"timestamp"`
}

// ToolCall represents an AI tool invocation
// @Description A tool call made by the AI
type ToolCall struct {
	ID     string `json:"id" bson:"id"`
	Name   string `json:"name" bson:"name"`
	Input  string `json:"input" bson:"input"`   // JSON string of tool input
	Output string `json:"output" bson:"output"` // JSON string of tool output
}

// CreateAISessionRequest represents a request to create a new AI session
// @Description Request body for creating a new AI session
type CreateAISessionRequest struct {
	ChartID        string `json:"chart_id"`        // Existing chart ID to edit (optional, omit for new chart)
	InitialMessage string `json:"initial_message"` // First user message (optional)

	// Pre-flight context (optional) - sets fields on the draft directly
	ComponentType  string `json:"component_type,omitempty"`  // "chart", "control", or "display"
	ChartType      string `json:"chart_type,omitempty"`      // For charts: bar, line, pie, etc.
	ControlType    string `json:"control_type,omitempty"`    // For controls: button, toggle, slider, etc.
	ConnectionID   string `json:"connection_id,omitempty"`   // Pre-selected connection ID

	// Dashboard panel context (optional) - if set, saved component is auto-attached to this panel
	DashboardID    string `json:"dashboard_id,omitempty"`    // Dashboard to attach to on save
	PanelID        string `json:"panel_id,omitempty"`        // Panel within the dashboard
}

// SendMessageRequest represents a request to send a message in an AI session
// @Description Request body for sending a user message
type SendMessageRequest struct {
	Content string `json:"content" binding:"required"` // User message content
}

// AISessionResponse represents the API response for session operations
// @Description Response containing AI session state
type AISessionResponse struct {
	Session   *AISession `json:"session"`
	Component *Component `json:"component,omitempty"` // Current component state (draft)
}

// AIEventType constants for SSE events
const (
	AIEventTypeMessage         = "message"           // New message added
	AIEventTypeToolCall        = "tool_call"         // Tool was called
	AIEventTypeComponentUpdate = "component_update"  // Component was modified
	AIEventTypeStatus          = "status"            // Session status changed
	AIEventTypeError           = "error"             // Error occurred
	AIEventTypeThinking        = "thinking"          // AI is processing
	AIEventTypeStreaming       = "streaming"         // Streaming text content
)

// AIEvent represents an SSE event sent to the client
// @Description Server-sent event for AI session updates
type AIEvent struct {
	Type      string      `json:"type"`                 // Event type
	Data      interface{} `json:"data"`                 // Event data
	Timestamp time.Time   `json:"timestamp"`
}

// AIMessageEvent is the data for a "message" event
type AIMessageEvent struct {
	Message AIMessage `json:"message"`
}

// AIToolCallEvent is the data for a "tool_call" event
type AIToolCallEvent struct {
	ToolCall ToolCall `json:"tool_call"`
}

// AIComponentUpdateEvent is the data for a "component_update" event
type AIComponentUpdateEvent struct {
	Component *Component `json:"component"`
}

// AIStatusEvent is the data for a "status" event
type AIStatusEvent struct {
	Status string `json:"status"`
}

// AIErrorEvent is the data for an "error" event
type AIErrorEvent struct {
	Error   string `json:"error"`
	Code    string `json:"code,omitempty"`
	Details string `json:"details,omitempty"`
}

// AIThinkingEvent is the data for a "thinking" event
type AIThinkingEvent struct {
	Thinking bool `json:"thinking"`
}

// AIStreamingEvent is the data for a "streaming" event (partial text)
type AIStreamingEvent struct {
	Content string `json:"content"` // Partial text content
	Done    bool   `json:"done"`    // Whether streaming is complete
}
