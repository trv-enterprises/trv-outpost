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
// Aliases resolve to the current latest of each family — bump these on
// each Anthropic release and every deployment using the alias moves
// forward. Admins who need a pinned snapshot pass a concrete model ID
// instead (see ResolveModelID), which is passed through untouched.
const (
	ModelSonnet = "claude-sonnet-4-6" // alias "sonnet" → latest Sonnet
	ModelOpus   = "claude-opus-4-8"   // alias "opus"   → latest Opus
)

// Default model. Sonnet by design — broader scope means lower bar
// per turn. Opus opt-in via the assistant.model admin setting.
const defaultChatModel = ModelSonnet

// ResolveModelID maps the assistant.model admin setting to a concrete
// Anthropic model ID. Two input shapes:
//   - the aliases "sonnet" / "opus" → the current latest of that family
//     (the constants above; bumped per release).
//   - any other non-empty value is treated as an explicit model ID and
//     passed through verbatim (e.g. "claude-sonnet-4-20250514" to pin an
//     older snapshot for A/B testing, or a future ID before an alias bump).
// Empty falls back to the Sonnet default so a blank setting can't break
// the agent.
func ResolveModelID(adminValue string) string {
	switch adminValue {
	case "":
		return defaultChatModel
	case "sonnet":
		return ModelSonnet
	case "opus":
		return ModelOpus
	default:
		return adminValue // explicit, pinned model ID — pass through
	}
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

// Default max turns per ProcessMessage call. Matches the Component
// AI agent's ceiling — builder workflows for non-trivial dashboards
// routinely need 10-15 turns (one create_component per chart + one
// create_dashboard + a few read/probe calls). The earlier ceiling of
// 8 cut off real builds halfway through.
//
// The loop-detection guard in ProcessMessage catches degenerate
// patterns (repeated identical tool calls) so this ceiling isn't the
// only thing standing between a stuck agent and runaway cost.
const defaultChatMaxTurns = 50

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
	// Key resolution: explicit config (prod sets this from
	// DASHBOARD_LLM_API_KEY) → ASSISTANT_ANTHROPIC_API_KEY → ANTHROPIC_API_KEY.
	// ASSISTANT_ANTHROPIC_API_KEY is preferred for LOCAL DEV so the
	// dashboard server uses a dedicated key, NOT the developer's
	// ANTHROPIC_API_KEY (which Claude Code / other tooling also consumes).
	apiKey := config.APIKey
	if apiKey == "" {
		apiKey = os.Getenv("ASSISTANT_ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		return nil, fmt.Errorf("no Anthropic API key: set ASSISTANT_ANTHROPIC_API_KEY (preferred for local dev) or ANTHROPIC_API_KEY")
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

	// recentToolCalls tracks the last loopDetectorWindow tool-call
	// fingerprints in this ProcessMessage cycle. If the model
	// invokes the same tool with the same args twice within the
	// window we synthesize an is_error result instead of executing
	// — cheaper than burning a turn and gives the model a clear
	// signal to change approach. See toolCallFingerprint below.
	recentToolCalls := make([]string, 0, loopDetectorWindow)

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

			// Loop detection: if this exact (tool, args) pair was just
			// invoked, short-circuit with an is_error result instead of
			// re-executing. The model usually pivots on the first
			// "you already did this" signal — much cheaper than the
			// next-undiscovered-cycle eating all 50 turns.
			fingerprint := toolCallFingerprint(tu.Name, tu.Input)
			if isDuplicateRecent(recentToolCalls, fingerprint) {
				dupMsg := fmt.Sprintf(
					"loop_detected: you just called %s with these same arguments. The previous result is in the conversation above. Try a different tool or change your arguments — repeating the same call won't produce different output.",
					tu.Name,
				)
				toolResults = append(toolResults, anthropic.NewToolResultBlock(tu.ID, dupMsg, true))
				modelToolCalls = append(modelToolCalls, models.ToolCall{
					ID:     tu.ID,
					Name:   tu.Name,
					Input:  string(tu.Input),
					Output: dupMsg,
				})
				// Don't push fingerprint again — same call shouldn't
				// keep extending the window.
				continue
			}
			recentToolCalls = appendBounded(recentToolCalls, fingerprint, loopDetectorWindow)

			// Build the per-call dispatch env. The result store
			// gives get_full_result something to fetch from; the
			// RevealTierB callback lets describe_tool flip a flag
			// in our local revealedTierB map so the next turn's
			// AnthropicToolParams will include the schema.
			result, dispatchErr := a.tools.Dispatch(ctx, &DispatchEnv{
				Session:     session,
				Caller:      caller,
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
			//
			// CRITICAL EXCLUSION: get_full_result itself bypasses
			// the summarizer. Its whole purpose is to give the model
			// the full payload it asked for — re-summarizing here
			// creates an infinite cycle (fetch → summarize → fetch
			// the new summary's result_id → summarize → ...), and
			// the model never actually sees the data it requested.
			// This was the failure mode in the 2026-05-26 export.
			modelFacing := rawResultStr
			if !isError && a.resultStore != nil && tu.Name != "get_full_result" {
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

// loopDetectorWindow is the number of recent tool-call fingerprints
// we hold per ProcessMessage call. A larger window catches looser
// cycles but at the cost of falsely flagging legitimate retries with
// the same args (e.g. polling a query). 8 is enough to spot tight
// fetch→fetch and get→get patterns while leaving room for the model
// to redo a call after one or two intervening different ones.
const loopDetectorWindow = 8

// toolCallFingerprint returns a stable string identifying a single
// tool invocation, used by the in-cycle duplicate detector. We rely
// on encoding/json producing deterministic output for our own
// JSON.RawMessage inputs from Anthropic — they arrive already
// canonicalized by the SDK.
func toolCallFingerprint(name string, args []byte) string {
	return name + ":" + string(args)
}

// isDuplicateRecent reports whether `fp` is already in the recent
// fingerprint window.
func isDuplicateRecent(window []string, fp string) bool {
	for _, prev := range window {
		if prev == fp {
			return true
		}
	}
	return false
}

// appendBounded appends `fp` to the recent-fingerprint window,
// dropping the oldest entry once we exceed `cap`. Returns the
// new slice (potentially the same backing array, potentially a
// resliced view).
func appendBounded(window []string, fp string, cap int) []string {
	if len(window) < cap {
		return append(window, fp)
	}
	// Slide: drop the oldest entry.
	copy(window, window[1:])
	window[len(window)-1] = fp
	return window
}

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
