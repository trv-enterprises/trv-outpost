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

// AI Session kind constants — discriminates the two agent surfaces
// that share this collection:
//
//   - "component": the Component AI agent, scoped to one chart by ID
//   - "chat": the Dashboard Assistant, unscoped builder
//
// Empty string is treated as "component" for backwards compatibility
// with records written before the discriminator existed. See
// AISession.KindOrDefault().
const (
	AISessionKindComponent = "component"
	AISessionKindChat      = "chat"
)

// AI Message role constants
const (
	AIMessageRoleUser      = "user"
	AIMessageRoleAssistant = "assistant"
	AIMessageRoleSystem    = "system"
)

// AISession represents an active AI agent conversation. Two agent
// surfaces share this collection, discriminated by Kind:
//
//   - Kind="component" — the Component AI agent, scoped to a chart
//     by ComponentID. ChartVersion, DashboardID, PanelID are populated.
//   - Kind="chat" — the Dashboard Assistant, unscoped. ComponentID
//     and the chart/dashboard/panel fields are empty.
//
// Records written before the Kind field existed have an empty Kind;
// KindOrDefault() returns "component" for those so the existing
// dispatch logic keeps working.
// @Description AI session for component editing (kind=component) or general chat (kind=chat)
type AISession struct {
	ID           string      `json:"id" bson:"_id"`                            // UUID
	Kind         string      `json:"kind,omitempty" bson:"kind,omitempty"`     // "component" (default) | "chat"
	ComponentID  string      `json:"component_id,omitempty" bson:"component_id,omitempty"` // Component UUID being edited (component sessions only)
	ChartVersion int         `json:"chart_version,omitempty" bson:"chart_version,omitempty"` // Version being edited (component sessions only)
	Messages     []AIMessage `json:"messages" bson:"messages"`                 // Conversation history
	Status       string      `json:"status" bson:"status"`                     // "active" | "completed" | "cancelled"
	DashboardID  string      `json:"dashboard_id,omitempty" bson:"dashboard_id,omitempty"` // Auto-attach to this dashboard on save (component sessions only)
	PanelID      string      `json:"panel_id,omitempty" bson:"panel_id,omitempty"`         // Auto-attach to this panel on save (component sessions only)
	Created      time.Time   `json:"created" bson:"created"`
	Updated      time.Time   `json:"updated" bson:"updated"`
	ExpiresAt    time.Time   `json:"expires_at" bson:"expires_at"`
}

// KindOrDefault returns the session's Kind, defaulting to
// AISessionKindComponent when the field is empty. Records persisted
// before the Kind discriminator existed don't carry the field; this
// helper keeps existing dispatch paths working without a migration.
func (s *AISession) KindOrDefault() string {
	if s == nil || s.Kind == "" {
		return AISessionKindComponent
	}
	return s.Kind
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
	// Kind selects which agent surface owns the session. "component"
	// (or empty) targets the Component AI agent and requires a
	// ComponentID; "chat" targets the Dashboard Assistant and
	// ignores the component-scoped fields.
	Kind           string `json:"kind,omitempty"`
	ComponentID    string `json:"component_id"`    // Existing component ID to edit (optional, omit for new component)
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

	// SurfaceContext describes what the user is currently looking at
	// in the UI. Used by the Dashboard Assistant to resolve
	// "this dashboard" / "this chart" without a tool round trip and
	// to refuse writes that would collide with the user's active
	// edit. Optional; the Component AI agent ignores it.
	SurfaceContext *SurfaceContext `json:"surface_context,omitempty"`
}

// SurfaceContext is the per-message view-state payload the client
// attaches to every Dashboard Assistant send. Mirrors the React
// AssistantSurfaceContext shape on the client.
//
// `Mode` is "VIEW" or "EDIT" — same string-uppercase the client
// sends. `Surface` is "DASHBOARD" / "COMPONENT" / "CONNECTION".
// `Panels` is only populated for DASHBOARD surfaces.
//
// All fields are optional; the prompt builder degrades gracefully
// when fields are missing.
type SurfaceContext struct {
	Mode        string                 `json:"mode,omitempty"`
	Surface     string                 `json:"surface,omitempty"`
	SurfaceID   string                 `json:"surfaceId,omitempty"`
	SurfaceName string                 `json:"surfaceName,omitempty"`
	Panels      []SurfaceContextPanel  `json:"panels,omitempty"`
}

// SurfaceContextPanel describes a single panel in a dashboard
// surface, with just enough metadata for the agent to resolve
// "panel 3" / "the line chart" without listing components.
type SurfaceContextPanel struct {
	ID            string `json:"id,omitempty"`
	Title         string `json:"title,omitempty"`
	ComponentID   string `json:"componentId,omitempty"`
	ComponentType string `json:"componentType,omitempty"`
	ChartType     string `json:"chartType,omitempty"`
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
	AIEventTypeUsage           = "usage"             // Per-turn token usage
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

// AIUsageEvent is the data for a "usage" event: token counts for the API call
// just completed (Input/Output) plus the running cumulative total for THIS
// session so far. The agent makes multiple API calls per user turn (one per
// tool round-trip), so each call emits one usage event and the client
// accumulates / displays the session totals. The server-side per-user DAILY
// buckets (chat_usage) are separate and cumulative across sessions; this event
// is the live in-session counter only.
type AIUsageEvent struct {
	InputTokens         int `json:"input_tokens"`          // this API call
	OutputTokens        int `json:"output_tokens"`         // this API call
	SessionInputTokens  int `json:"session_input_tokens"`  // running total this session
	SessionOutputTokens int `json:"session_output_tokens"` // running total this session
}
