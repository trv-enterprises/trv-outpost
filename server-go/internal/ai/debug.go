// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// DebugEventType represents types of debug events
type DebugEventType string

const (
	DebugEventLLMRequest    DebugEventType = "llm_request"
	DebugEventLLMResponse   DebugEventType = "llm_response"
	DebugEventToolCall      DebugEventType = "tool_call"
	DebugEventToolResult    DebugEventType = "tool_result"
	DebugEventThinking      DebugEventType = "thinking"
	DebugEventError         DebugEventType = "error"
	DebugEventChartUpdate   DebugEventType = "chart_update"
	DebugEventSessionStart  DebugEventType = "session_start"
	DebugEventTurnStart     DebugEventType = "turn_start"
	DebugEventTurnEnd       DebugEventType = "turn_end"
)

// DebugEvent represents a debug event to be sent to clients
type DebugEvent struct {
	Type      DebugEventType `json:"type"`
	SessionID string         `json:"session_id,omitempty"`
	Turn      int            `json:"turn,omitempty"`
	Timestamp time.Time      `json:"timestamp"`
	Data      interface{}    `json:"data,omitempty"`
}

// DebugHub manages WebSocket debug connections
type DebugHub struct {
	clients   map[*websocket.Conn]bool
	broadcast chan *DebugEvent
	register  chan *websocket.Conn
	unregister chan *websocket.Conn
	mu        sync.RWMutex
	enabled   bool
}

// Global debug hub instance
var debugHub *DebugHub
var debugHubOnce sync.Once

// GetDebugHub returns the singleton debug hub instance
func GetDebugHub() *DebugHub {
	debugHubOnce.Do(func() {
		debugHub = &DebugHub{
			clients:    make(map[*websocket.Conn]bool),
			broadcast:  make(chan *DebugEvent, 256),
			register:   make(chan *websocket.Conn),
			unregister: make(chan *websocket.Conn),
			enabled:    true,
		}
		go debugHub.run()
	})
	return debugHub
}

// run starts the debug hub's main loop
func (h *DebugHub) run() {
	for {
		select {
		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = true
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				client.Close()
			}
			h.mu.Unlock()

		case event := <-h.broadcast:
			h.mu.RLock()
			for client := range h.clients {
				data, err := json.Marshal(event)
				if err != nil {
					continue
				}
				err = client.WriteMessage(websocket.TextMessage, data)
				if err != nil {
					client.Close()
					h.mu.RUnlock()
					h.mu.Lock()
					delete(h.clients, client)
					h.mu.Unlock()
					h.mu.RLock()
				}
			}
			h.mu.RUnlock()
		}
	}
}

// Register adds a new WebSocket client to the hub
func (h *DebugHub) Register(conn *websocket.Conn) {
	h.register <- conn
}

// Unregister removes a WebSocket client from the hub
func (h *DebugHub) Unregister(conn *websocket.Conn) {
	h.unregister <- conn
}

// Send broadcasts a debug event to all connected clients
func (h *DebugHub) Send(event *DebugEvent) {
	if !h.enabled {
		return
	}
	if event.Timestamp.IsZero() {
		event.Timestamp = time.Now()
	}

	// Non-blocking send
	select {
	case h.broadcast <- event:
	default:
		// Drop event if buffer is full
	}
}

// ClientCount returns the number of connected clients
func (h *DebugHub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Helper functions for sending specific event types

// SendLLMRequest sends an LLM request debug event
func (h *DebugHub) SendLLMRequest(sessionID string, turn int, messages interface{}, tools interface{}) {
	h.Send(&DebugEvent{
		Type:      DebugEventLLMRequest,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"messages": messages,
			"tools":    tools,
		},
	})
}

// SendLLMResponse sends an LLM response debug event
func (h *DebugHub) SendLLMResponse(sessionID string, turn int, content string, toolCalls interface{}) {
	h.Send(&DebugEvent{
		Type:      DebugEventLLMResponse,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"content":    content,
			"tool_calls": toolCalls,
		},
	})
}

// SendToolCall sends a tool call debug event
func (h *DebugHub) SendToolCall(sessionID string, turn int, toolName string, toolID string, args interface{}) {
	h.Send(&DebugEvent{
		Type:      DebugEventToolCall,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"tool_name": toolName,
			"tool_id":   toolID,
			"arguments": args,
		},
	})
}

// SendToolResult sends a tool result debug event
func (h *DebugHub) SendToolResult(sessionID string, turn int, toolName string, toolID string, result interface{}) {
	h.Send(&DebugEvent{
		Type:      DebugEventToolResult,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"tool_name": toolName,
			"tool_id":   toolID,
			"result":    result,
		},
	})
}

// SendError sends an error debug event
func (h *DebugHub) SendError(sessionID string, turn int, err error, code string) {
	h.Send(&DebugEvent{
		Type:      DebugEventError,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"error": err.Error(),
			"code":  code,
		},
	})
}

// SendTurnStart sends a turn start debug event
func (h *DebugHub) SendTurnStart(sessionID string, turn int, maxTurns int) {
	h.Send(&DebugEvent{
		Type:      DebugEventTurnStart,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"max_turns": maxTurns,
		},
	})
}

// SendTurnEnd sends a turn end debug event
func (h *DebugHub) SendTurnEnd(sessionID string, turn int, completed bool) {
	h.Send(&DebugEvent{
		Type:      DebugEventTurnEnd,
		SessionID: sessionID,
		Turn:      turn,
		Data: map[string]interface{}{
			"completed": completed,
		},
	})
}
