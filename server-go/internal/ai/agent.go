// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package ai

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// CatalogProvider returns the current type catalog (filtered by enabled_types
// settings). The agent calls this once per message so admin toggles take
// effect on the next user turn.
type CatalogProvider interface {
	GetCatalog(ctx context.Context) (*registry.Catalog, error)
}

// Agent handles AI conversations with tool execution
type Agent struct {
	client          anthropic.Client
	toolExecutor    *ToolExecutor
	sessionSvc      SessionService
	maxTurns        int
	modelName       string
	catalogProvider CatalogProvider
}

// SessionService interface for session operations and SSE broadcasting
type SessionService interface {
	AddAssistantMessage(ctx context.Context, sessionID string, content string, toolCalls []models.ToolCall) (*models.AIMessage, error)
	UpdateChartDraft(ctx context.Context, sessionID string, chart *models.Component) error
	SendThinkingEvent(sessionID string, thinking bool)
	SendStreamingEvent(sessionID string, content string, done bool)
	SendErrorEvent(sessionID string, err error, code string)
	BroadcastEvent(sessionID string, event *models.AIEvent)
}

// AgentConfig holds configuration for the AI agent
type AgentConfig struct {
	Provider string // "anthropic"
	Model    string // model name (e.g., "claude-sonnet-4-20250514")
	MaxTurns int
	APIKey   string
	BaseURL  string // for custom endpoints
}

// NewAgent creates a new AI agent with the Anthropic SDK. catalogProvider
// may be nil — when nil the agent ships the historical full enum lists and
// fully-populated system prompt (no filtering applied).
func NewAgent(toolExecutor *ToolExecutor, sessionSvc SessionService, catalogProvider CatalogProvider, config *AgentConfig) (*Agent, error) {
	if config == nil {
		config = &AgentConfig{
			Provider: "anthropic",
			Model:    "claude-sonnet-4-20250514",
			MaxTurns: 10,
		}
	}

	apiKey := config.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY environment variable is required")
	}

	// Create Anthropic client
	client := anthropic.NewClient(option.WithAPIKey(apiKey))

	maxTurns := config.MaxTurns
	if maxTurns == 0 {
		maxTurns = 10
	}

	return &Agent{
		client:          client,
		toolExecutor:    toolExecutor,
		sessionSvc:      sessionSvc,
		maxTurns:        maxTurns,
		modelName:       config.Model,
		catalogProvider: catalogProvider,
	}, nil
}

// ProcessMessage processes a user message and generates a response
func (a *Agent) ProcessMessage(ctx context.Context, session *models.AISession, userContent string) error {
	// Get debug hub for broadcasting debug events
	debug := GetDebugHub()

	// Notify clients that AI is thinking
	a.sessionSvc.SendThinkingEvent(session.ID, true)
	defer a.sessionSvc.SendThinkingEvent(session.ID, false)

	// Build conversation history
	messages := a.buildMessages(session.Messages, userContent)

	// Build the catalog (if a provider is wired) so tools and system prompt
	// reflect the admin's current enabled_types selection. On error we fall
	// back to the unfiltered prompt/enum lists.
	var cat *registry.Catalog
	if a.catalogProvider != nil {
		c, err := a.catalogProvider.GetCatalog(ctx)
		if err == nil {
			cat = c
		} else {
			debug.SendError(session.ID, 0, err, "catalog_error")
		}
	}

	// Get tool definitions (filtered by catalog when available)
	tools := GetAnthropicTools(cat)
	systemPromptText := BuildSystemPrompt(cat)

	// Debug: Log session start
	debug.Send(&DebugEvent{
		Type:      DebugEventSessionStart,
		SessionID: session.ID,
		Data: map[string]interface{}{
			"component_id":  session.ComponentID,
			"chart_version": session.ChartVersion,
			"user_message":  userContent,
			"model":         a.modelName,
		},
	})

	// Start conversation loop
	for turn := 0; turn < a.maxTurns; turn++ {
		// Debug: Log turn start
		debug.SendTurnStart(session.ID, turn, a.maxTurns)

		// Debug: Log LLM request
		debug.SendLLMRequest(session.ID, turn, summarizeAnthropicMessages(messages), summarizeAnthropicTools(tools))

		// Build request params
		params := anthropic.MessageNewParams{
			Model:     anthropic.Model(a.modelName),
			MaxTokens: 4096,
			System: []anthropic.TextBlockParam{
				{Text: systemPromptText},
			},
			Messages: messages,
			Tools:    tools,
		}

		// Force tool use on the first turn
		if turn == 0 {
			params.ToolChoice = anthropic.ToolChoiceUnionParam{
				OfAny: &anthropic.ToolChoiceAnyParam{},
			}
		}

		// Call Anthropic API
		response, err := a.client.Messages.New(ctx, params)
		if err != nil {
			debug.SendError(session.ID, turn, err, "api_error")
			a.sessionSvc.SendErrorEvent(session.ID, err, "api_error")
			return fmt.Errorf("Anthropic API error: %w", err)
		}

		// Process the response
		textContent := ""
		var toolUseBlocks []anthropic.ToolUseBlock

		for _, block := range response.Content {
			switch variant := block.AsAny().(type) {
			case anthropic.TextBlock:
				textContent += variant.Text
			case anthropic.ToolUseBlock:
				toolUseBlocks = append(toolUseBlocks, variant)
			}
		}

		// Debug: Log LLM response
		debug.SendLLMResponse(session.ID, turn, textContent, summarizeAnthropicToolCalls(toolUseBlocks))

		// If there's text content, stream it
		if textContent != "" {
			a.sessionSvc.SendStreamingEvent(session.ID, textContent, len(toolUseBlocks) == 0)
		}

		// If no tool calls, we're done
		if len(toolUseBlocks) == 0 {
			debug.SendTurnEnd(session.ID, turn, true)
			// Save assistant message
			_, err := a.sessionSvc.AddAssistantMessage(ctx, session.ID, textContent, nil)
			if err != nil {
				return fmt.Errorf("failed to save assistant message: %w", err)
			}
			return nil
		}

		// Process tool calls
		modelToolCalls := make([]models.ToolCall, 0, len(toolUseBlocks))
		toolResultContent := make([]anthropic.ContentBlockParamUnion, 0, len(toolUseBlocks))

		for _, tc := range toolUseBlocks {
			// Convert input to JSON
			inputJSON, _ := json.Marshal(tc.Input)

			// Debug: Log tool call
			debug.SendToolCall(session.ID, turn, tc.Name, tc.ID, string(inputJSON))

			// Execute the tool
			result, err := a.toolExecutor.ExecuteTool(
				ctx,
				session.ComponentID,
				session.ChartVersion,
				tc.Name,
				inputJSON,
			)

			if err != nil {
				result = &ToolResult{
					Success: false,
					Error:   err.Error(),
				}
			}

			// Debug: Log tool result
			debug.SendToolResult(session.ID, turn, tc.Name, tc.ID, result)

			// Build tool result
			resultJSON, _ := json.Marshal(result)
			toolResultContent = append(toolResultContent, anthropic.NewToolResultBlock(
				tc.ID,
				string(resultJSON),
				false, // not an error
			))

			// Record tool call for storage
			modelToolCalls = append(modelToolCalls, models.ToolCall{
				ID:     tc.ID,
				Name:   tc.Name,
				Input:  string(inputJSON),
				Output: string(resultJSON),
			})
		}

		// Note: Chart updates are now broadcast via the ChartHub directly from ToolExecutor
		// This ensures that ALL subscribers (including dashboard viewers) get updates,
		// not just the current session

		// Save assistant message with tool calls
		_, err = a.sessionSvc.AddAssistantMessage(ctx, session.ID, textContent, modelToolCalls)
		if err != nil {
			return fmt.Errorf("failed to save assistant message: %w", err)
		}

		// Add assistant response to messages
		messages = append(messages, response.ToParam())

		// Add tool results as user message
		messages = append(messages, anthropic.NewUserMessage(toolResultContent...))

		debug.SendTurnEnd(session.ID, turn, false)
	}

	// Exceeded max turns
	a.sessionSvc.SendErrorEvent(session.ID, fmt.Errorf("exceeded maximum tool call rounds"), "max_turns_exceeded")
	return nil
}

// buildMessages converts session messages to Anthropic format
func (a *Agent) buildMessages(history []models.AIMessage, newUserContent string) []anthropic.MessageParam {
	messages := make([]anthropic.MessageParam, 0, len(history)+1)

	for _, msg := range history {
		switch msg.Role {
		case models.AIMessageRoleUser:
			messages = append(messages, anthropic.NewUserMessage(
				anthropic.NewTextBlock(msg.Content),
			))
		case models.AIMessageRoleAssistant:
			content := []anthropic.ContentBlockParamUnion{}
			if msg.Content != "" {
				content = append(content, anthropic.NewTextBlock(msg.Content))
			}
			// Add tool calls if present
			for _, tc := range msg.ToolCalls {
				var input interface{}
				json.Unmarshal([]byte(tc.Input), &input)
				content = append(content, anthropic.ContentBlockParamUnion{
					OfToolUse: &anthropic.ToolUseBlockParam{
						ID:    tc.ID,
						Name:  tc.Name,
						Input: input,
					},
				})
			}
			if len(content) > 0 {
				messages = append(messages, anthropic.NewAssistantMessage(content...))
			}

			// If assistant message had tool calls, add the tool results as the next user message
			// This is required by the Anthropic API - every tool_use must have a corresponding tool_result
			if len(msg.ToolCalls) > 0 {
				toolResults := make([]anthropic.ContentBlockParamUnion, 0, len(msg.ToolCalls))
				for _, tc := range msg.ToolCalls {
					// Summarize read-only tool results to save tokens in history
					output := summarizeToolResultForHistory(tc.Name, tc.Output)
					toolResults = append(toolResults, anthropic.NewToolResultBlock(
						tc.ID,
						output,
						false, // not an error
					))
				}
				messages = append(messages, anthropic.NewUserMessage(toolResults...))
			}
		}
	}

	// Add the new user message
	messages = append(messages, anthropic.NewUserMessage(
		anthropic.NewTextBlock(newUserContent),
	))

	return messages
}

// summarizeToolResultForHistory compresses verbose tool results in message history
// to reduce token usage on subsequent API calls. The full result is preserved in
// storage for debugging - this only affects what's sent to the LLM.
func summarizeToolResultForHistory(toolName, output string) string {
	// Tools whose results should be summarized (read-only discovery tools)
	summarizableTools := map[string]bool{
		ToolListConnections:     true,
		ToolListDeviceTypes:     true,
		ToolGetSchema:           true,
		ToolGetConnectionSchema: true,
		ToolGetPrometheusSchema: true,
		ToolGetEdgeLakeSchema:   true,
		ToolQueryConnection:     true,
		ToolPreviewData:         true,
		ToolGetComponentState:   true,
	}

	if !summarizableTools[toolName] {
		return output
	}

	// Parse the result
	var result ToolResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		return output // Can't parse, return as-is
	}

	// If it failed, keep the error message
	if !result.Success {
		return output
	}

	// Create a summary based on the tool type
	summary := ToolResult{
		Success: true,
		Message: result.Message,
	}

	// For tools with data arrays, just note the count
	switch toolName {
	case ToolListConnections:
		if data, ok := result.Data.([]interface{}); ok {
			summary.Message = fmt.Sprintf("Returned %d connection(s) - use get_schema to explore", len(data))
		}
	case ToolGetSchema, ToolGetConnectionSchema, ToolGetPrometheusSchema, ToolGetEdgeLakeSchema:
		summary.Message = result.Message + " (schema already retrieved)"
	case ToolQueryConnection, ToolPreviewData:
		summary.Message = result.Message + " (data already retrieved)"
	case ToolGetComponentState:
		summary.Message = "Component state retrieved (see previous response)"
	}

	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		return output
	}
	return string(summaryJSON)
}

// GenerateToolCallID generates a unique ID for tool calls
func GenerateToolCallID() string {
	return "toolu_" + uuid.New().String()[:8]
}

// summarizeAnthropicMessages creates a summary of messages for debug output
func summarizeAnthropicMessages(messages []anthropic.MessageParam) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(messages))
	for _, msg := range messages {
		summary := map[string]interface{}{
			"role": msg.Role,
		}

		// Count parts by type
		partCounts := map[string]int{}
		for range msg.Content {
			partCounts["content"]++
		}
		summary["parts"] = partCounts
		result = append(result, summary)
	}
	return result
}

// summarizeAnthropicTools creates a summary of available tools for debug output
func summarizeAnthropicTools(tools []anthropic.ToolUnionParam) []string {
	names := make([]string, 0, len(tools))
	for _, tool := range tools {
		if tool.OfTool != nil {
			names = append(names, tool.OfTool.Name)
		}
	}
	return names
}

// summarizeAnthropicToolCalls creates a summary of tool calls for debug output
func summarizeAnthropicToolCalls(toolCalls []anthropic.ToolUseBlock) []map[string]interface{} {
	result := make([]map[string]interface{}, 0, len(toolCalls))
	for _, tc := range toolCalls {
		summary := map[string]interface{}{
			"id":   tc.ID,
			"name": tc.Name,
		}
		result = append(result, summary)
	}
	return result
}
