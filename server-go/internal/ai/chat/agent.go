// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package chat implements the Dashboard Assistant agent — a chat-
// driven builder that operates on the whole deployment (connections,
// components, dashboards, namespaces) via in-process tool dispatch.
//
// It is a sibling of the existing Component AI agent in `internal/ai/`
// and shares the AISession model, SSE plumbing, and Anthropic SDK
// usage. It does NOT share the system prompt, tool registry, tool
// dispatcher, or message-loop entry point — those are forked here so
// the two agents can have completely different shapes without
// cross-talk.
//
// Architecture overview (see docs/design-notes/dashboard-chat-agent.md):
//   - layers/   — per-turn prompt assembly (system, caller, tools,
//                 history, workspace). Each layer queries the budget
//                 tracker so we can grow the agent's tool surface
//                 without bloating per-turn cost.
//   - tools/    — tool registry split into Tier A (always loaded) and
//                 Tier B (loaded on demand via describe_tool meta-tool).
//
// Step 2 (this commit) ships the absolute minimum: one Tier-A tool,
// `get_current_user`, dispatched end-to-end. Every subsequent step
// fleshes out the layers and tools.
package chat

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Anthropic model IDs the Dashboard Assistant supports. Tied to
// the assistant.model admin setting's allowed values: pass "sonnet"
// or "opus" to ResolveModelID, get the concrete Anthropic ID back.
//
// These are concrete model IDs rather than the latest-aliases so
// the assistant's behavior is stable across Anthropic releases —
// admins can opt into newer models by bumping the constant.
const (
	ModelSonnet = "claude-sonnet-4-20250514"
	ModelOpus   = "claude-opus-4-20250514"
)

// Default model. Sonnet by design — broader scope means lower bar
// per turn. Opus opt-in via the assistant.model admin setting.
const defaultChatModel = ModelSonnet

// ResolveModelID maps the admin setting's short value to the full
// Anthropic model ID. Empty / unknown inputs fall back to Sonnet
// so a typo in the admin setting can't break the agent.
func ResolveModelID(adminValue string) string {
	switch adminValue {
	case "opus":
		return ModelOpus
	case "sonnet":
		return ModelSonnet
	}
	return defaultChatModel
}

// CallerCtx carries per-message context the chat agent needs from
// the HTTP request layer: who the user is (for caps + greeting),
// which namespace they're operating in (for create_* tools), and
// "now" for the date in the system prompt.
//
// The caller plumbs this into ProcessMessage; the agent doesn't
// resolve any of these itself because they all derive from the
// authenticated request rather than the persisted session.
//
// User may be nil (e.g. an unauthenticated test invocation); the
// prompt-builder falls back to a generic preamble in that case.
// Namespace defaults to "default" when empty. Now defaults to
// time.Now() when zero.
//
// Surface is the per-turn view-state payload sent by the client
// (sidecard's SendMessage body). When present, the prompt builder
// renders a "## Current view" block so the agent can resolve
// "this dashboard" / "this chart" without a tool round trip and
// refuse writes that would clobber the user's active edit. Nil
// for non-HTTP invocations or older client builds.
type CallerCtx struct {
	User      *models.User
	Namespace string
	Now       time.Time
	Surface   *models.SurfaceContext
}

// Default max turns per ProcessMessage call. Lower than the Component
// AI agent's because chat sessions can run indefinitely; we don't
// want one user message to chew through 50 tool calls.
const defaultChatMaxTurns = 8

// SessionService is the subset of the existing AISessionService that
// the chat agent needs. Same interface shape the Component AI agent
// uses, so we can reuse the same implementation by composition.
type SessionService interface {
	AddAssistantMessage(ctx context.Context, sessionID string, content string, toolCalls []models.ToolCall) (*models.AIMessage, error)
	SendThinkingEvent(sessionID string, thinking bool)
	SendStreamingEvent(sessionID string, content string, done bool)
	SendErrorEvent(sessionID string, err error, code string)
	BroadcastEvent(sessionID string, event *models.AIEvent)
}

// Agent is the Dashboard Assistant's message-loop driver. It mirrors
// the shape of `internal/ai.Agent` but uses its own tool registry
// and system prompt. A separate instance constructed from this type
// runs alongside the Component AI agent's instance with no shared
// state.
type Agent struct {
	client      anthropic.Client
	sessionSvc  SessionService
	tools       *ToolRegistry
	resultStore *ResultStore
	budget      *Budget
	modelName   string
	maxTurns    int
}

// Config holds optional overrides for the chat agent. nil → defaults.
type Config struct {
	APIKey      string
	Model       string
	MaxTurns    int
	ResultStore *ResultStore // optional; when nil, no result-store summarization
	Budget      *Budget      // optional; when nil, no cost guardrails
}

// NewAgent constructs a Dashboard Assistant agent. Returns an error
// if ANTHROPIC_API_KEY is not set (or APIKey is not explicitly
// provided in the config). main.go wraps this in its two-switch gate
// (env key + admin setting) before constructing.
func NewAgent(sessionSvc SessionService, tools *ToolRegistry, config *Config) (*Agent, error) {
	if config == nil {
		config = &Config{}
	}
	apiKey := config.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("ANTHROPIC_API_KEY not set")
	}

	model := config.Model
	if model == "" {
		model = defaultChatModel
	}
	maxTurns := config.MaxTurns
	if maxTurns == 0 {
		maxTurns = defaultChatMaxTurns
	}

	return &Agent{
		client:      anthropic.NewClient(option.WithAPIKey(apiKey)),
		sessionSvc:  sessionSvc,
		tools:       tools,
		resultStore: config.ResultStore,
		budget:      config.Budget,
		modelName:   model,
		maxTurns:    maxTurns,
	}, nil
}

// ResultStore exposes the result store for callers that need to
// dispatch the get_full_result meta-tool. The result store is a
// per-Agent dependency; the meta-tool handler retrieves it through
// this accessor rather than getting a parallel reference.
func (a *Agent) ResultStore() *ResultStore {
	if a == nil {
		return nil
	}
	return a.resultStore
}

// ProcessMessage runs one round of the Dashboard Assistant's
// message loop: build prompt, call Anthropic, dispatch any tool
// calls, repeat until the assistant returns plain text or we hit
// maxTurns. This is the chat-side equivalent of
// `internal/ai.Agent.ProcessMessage`.
//
// `caller` carries the per-message context the handler must
// resolve: who the user is, which namespace they're in, what
// "now" is. May be nil for non-HTTP test invocations; the prompt
// builder degrades gracefully.
func (a *Agent) ProcessMessage(ctx context.Context, session *models.AISession, userContent string, caller *CallerCtx) error {
	if a == nil {
		return fmt.Errorf("chat agent not initialized")
	}

	a.sessionSvc.SendThinkingEvent(session.ID, true)
	defer a.sessionSvc.SendThinkingEvent(session.ID, false)

	// Build conversation history. We just walk the persisted turns
	// and append the new user content; history compaction is a v1.1
	// concern (see design doc, Phase 3).
	messages := buildMessages(session.Messages, userContent)

	// System prompt is assembled per-turn from layers (role text +
	// caller context + Tier-B catalog). Tier-A schemas land in the
	// API request's Tools field via AnthropicToolParams.
	systemPrompt := buildSystemPrompt(a.tools, caller)

	// revealedTierB tracks which Tier-B tools the model has asked
	// describe_tool to load this conversation. Once a Tier-B tool's
	// schema is in here, AnthropicToolParams includes it on every
	// subsequent turn so the model can invoke it directly without
	// describe_tool round-trips.
	revealedTierB := map[string]bool{}

	// callerGUID is used by the per-user daily budget. Empty for
	// anonymous/test invocations — the budget skips the per-user
	// check in that case but still applies the conversation cap.
	callerGUID := ""
	if caller != nil && caller.User != nil {
		callerGUID = caller.User.GUID
	}

	// softWarnedThisCall avoids spamming the client with the same
	// "conversation is getting long" banner on every turn of a
	// multi-turn cycle.
	softWarnedThisCall := false

	for turn := 0; turn < a.maxTurns; turn++ {
		anthropicTools := a.tools.AnthropicToolParams(revealedTierB)

		// Budget check before each API call. Refuses the call
		// entirely past the hard limit; warns the client past the
		// soft limit.
		if a.budget != nil {
			approx := EstimateContextTokens(systemPrompt, anthropicMessageTextContent(messages))
			verdict, _ := a.budget.CheckBeforeCall(ctx, callerGUID, approx)
			if !verdict.Allowed {
				err := fmt.Errorf("%s", verdict.Reason)
				a.sessionSvc.SendErrorEvent(session.ID, err, "budget_exceeded")
				return err
			}
			if verdict.SoftWarn && !softWarnedThisCall {
				softWarnedThisCall = true
				a.sessionSvc.BroadcastEvent(session.ID, &models.AIEvent{
					Type:      "budget_warn",
					Data:      map[string]interface{}{"reason": verdict.Reason},
					Timestamp: time.Now(),
				})
			}
		}

		params := anthropic.MessageNewParams{
			Model:     anthropic.Model(a.modelName),
			MaxTokens: 4096,
			System: []anthropic.TextBlockParam{
				{Text: systemPrompt},
			},
			Messages: messages,
			Tools:    anthropicTools,
		}

		response, err := a.client.Messages.New(ctx, params)
		if err != nil {
			a.sessionSvc.SendErrorEvent(session.ID, err, "api_error")
			return fmt.Errorf("Anthropic API error: %w", err)
		}

		// Record exact token usage from the response so the
		// per-user daily budget converges on truth, not heuristics.
		if a.budget != nil && callerGUID != "" {
			_ = a.budget.RecordUsage(ctx, callerGUID,
				int64(response.Usage.InputTokens),
				int64(response.Usage.OutputTokens),
			)
		}

		textContent := ""
		var toolUseBlocks []anthropic.ToolUseBlock
		for _, block := range response.Content {
			switch v := block.AsAny().(type) {
			case anthropic.TextBlock:
				textContent += v.Text
			case anthropic.ToolUseBlock:
				toolUseBlocks = append(toolUseBlocks, v)
			}
		}

		if textContent != "" {
			a.sessionSvc.SendStreamingEvent(session.ID, textContent, len(toolUseBlocks) == 0)
		}

		// No tool calls → done.
		if len(toolUseBlocks) == 0 {
			if _, err := a.sessionSvc.AddAssistantMessage(ctx, session.ID, textContent, nil); err != nil {
				return fmt.Errorf("save assistant message: %w", err)
			}
			return nil
		}

		// Dispatch tool calls and append the assistant turn + tool
		// results to the conversation so the next API call sees them.
		assistantBlocks := []anthropic.ContentBlockParamUnion{}
		if textContent != "" {
			assistantBlocks = append(assistantBlocks, anthropic.NewTextBlock(textContent))
		}
		toolResults := []anthropic.ContentBlockParamUnion{}
		modelToolCalls := []models.ToolCall{}

		for _, tu := range toolUseBlocks {
			assistantBlocks = append(assistantBlocks, anthropic.NewToolUseBlock(tu.ID, tu.Input, tu.Name))

			// Build the per-call dispatch env. The result store
			// gives get_full_result something to fetch from; the
			// RevealTierB callback lets describe_tool flip a flag
			// in our local revealedTierB map so the next turn's
			// AnthropicToolParams will include the schema.
			result, dispatchErr := a.tools.Dispatch(ctx, &DispatchEnv{
				Session:     session,
				ResultStore: a.resultStore,
				RevealTierB: func(name string) {
					revealedTierB[name] = true
				},
			}, tu.Name, tu.Input)

			var rawResultStr string
			var isError bool
			if dispatchErr != nil {
				rawResultStr = fmt.Sprintf("error: %v", dispatchErr)
				isError = true
			} else {
				rawResultStr = result
			}

			// Route through the result store: large results are
			// persisted server-side and replaced with a one-line
			// summary + result_id; small results pass through
			// unchanged. The get_full_result meta-tool can fetch
			// the full content if the model decides it needs it.
			modelFacing := rawResultStr
			if !isError && a.resultStore != nil {
				if summarized, err := a.resultStore.Summarize(ctx, session.ID, tu.Name, rawResultStr); err == nil {
					modelFacing = summarized
				}
				// Summarize() returning err already produced a
				// graceful "store failed" string; modelFacing keeps
				// the raw value as fallback if Summarize is nil.
			}

			toolResults = append(toolResults, anthropic.NewToolResultBlock(tu.ID, modelFacing, isError))
			modelToolCalls = append(modelToolCalls, models.ToolCall{
				ID:    tu.ID,
				Name:  tu.Name,
				Input: string(tu.Input),
				// Persist the raw output to Mongo, NOT the
				// summary. The transcript export should show what
				// the tool actually returned; the summary is only
				// what the model saw.
				Output: rawResultStr,
			})
		}

		messages = append(messages, anthropic.NewAssistantMessage(assistantBlocks...))
		messages = append(messages, anthropic.NewUserMessage(toolResults...))

		// Persist the assistant turn (including tool calls) so the
		// conversation transcript stays in Mongo even if we don't
		// reach a final text turn.
		if _, err := a.sessionSvc.AddAssistantMessage(ctx, session.ID, textContent, modelToolCalls); err != nil {
			return fmt.Errorf("save assistant message: %w", err)
		}
	}

	a.sessionSvc.SendErrorEvent(session.ID, fmt.Errorf("max turns reached"), "max_turns")
	return fmt.Errorf("max turns (%d) reached without completion", a.maxTurns)
}

// buildMessages converts persisted history + the new user content
// into the Anthropic SDK's MessageParam slice. Step 5 replaces this
// with the layered prompt assembly; this is the smoke-test shape.
func buildMessages(history []models.AIMessage, newUserContent string) []anthropic.MessageParam {
	messages := make([]anthropic.MessageParam, 0, len(history)+1)
	for _, m := range history {
		switch m.Role {
		case models.AIMessageRoleUser:
			messages = append(messages, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Content)))
		case models.AIMessageRoleAssistant:
			messages = append(messages, anthropic.NewAssistantMessage(anthropic.NewTextBlock(m.Content)))
		}
	}
	if newUserContent != "" {
		messages = append(messages, anthropic.NewUserMessage(anthropic.NewTextBlock(newUserContent)))
	}
	return messages
}

// (defaultSystemPrompt removed in step 6 — see prompt.go's
// rolePreamble() and callerContextSection() for the templated
// replacement.)

// anthropicMessageTextContent returns the rendered text of every
// content block in every message, for the budget estimator. The
// Anthropic SDK's MessageParam is a tagged union of content blocks
// (TextBlockParam, ToolUseBlockParam, ToolResultBlockParam); we
// extract whatever's serializable to a string and ignore the rest.
//
// This is intentionally lossy — we just need a length proxy for
// the conversation-context cap. Tool inputs / outputs that are
// JSON-stringified strings contribute their full length; binary
// blobs we don't have wouldn't anyway.
func anthropicMessageTextContent(messages []anthropic.MessageParam) []string {
	out := make([]string, 0, len(messages))
	for _, m := range messages {
		for _, block := range m.Content {
			if block.OfText != nil {
				out = append(out, block.OfText.Text)
			}
			if block.OfToolUse != nil {
				// Tool inputs are arbitrary JSON values; serialize
				// for the estimator. Length of args is usually
				// small compared to result text so a JSON dump is
				// fine.
				if raw, err := json.Marshal(block.OfToolUse.Input); err == nil {
					out = append(out, string(raw))
				}
			}
			if block.OfToolResult != nil {
				for _, sub := range block.OfToolResult.Content {
					if sub.OfText != nil {
						out = append(out, sub.OfText.Text)
					}
				}
			}
		}
	}
	return out
}
