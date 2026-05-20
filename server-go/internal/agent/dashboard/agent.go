// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package dashboard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Config tells the Agent how to reach the services it needs.
type Config struct {
	// AnthropicAPIKey authorizes calls to the Claude API. Required.
	AnthropicAPIKey string

	// Model is the Claude model ID. Defaults to claude-sonnet-4-6 if
	// empty.
	Model string

	// MessageURL is the MCP POST endpoint, e.g.
	// http://localhost:3001/mcp/message
	MessageURL string

	// CatalogURL is the fallback URL for /api/registry/catalog.md.
	// Used only when MCP initialize's instructions field is empty.
	CatalogURL string

	// MaxTurns caps the agentic loop. Default 25.
	MaxTurns int

	// TranscriptWriter, if non-nil, receives a human-readable trace
	// of the run (prompts, tool calls, results, final answer). CLI
	// wiring typically passes os.Stderr.
	TranscriptWriter io.Writer
}

// Agent runs one dashboard-build session.
type Agent struct {
	cfg      Config
	claude   anthropic.Client
	mcp      *MCPClient
	resolver ClarificationResolver
}

// Result is what a successful run returns.
type Result struct {
	DashboardID string
	Summary     string
	Turns       int
}

// NewAgent constructs an agent. The resolver is invoked whenever the
// model calls request_clarification; the CLI harness wires stdin
// prompting here.
func NewAgent(cfg Config, resolver ClarificationResolver) (*Agent, error) {
	if cfg.AnthropicAPIKey == "" {
		return nil, fmt.Errorf("anthropic API key is required")
	}
	if cfg.MessageURL == "" {
		return nil, fmt.Errorf("MCP message URL is required")
	}
	if cfg.Model == "" {
		cfg.Model = "claude-sonnet-4-6"
	}
	if cfg.MaxTurns <= 0 {
		// ~3 tool calls per chart (create + get_template + update) plus
		// schema discovery and the final dashboard create/yield — 50
		// turns fits a ~12-panel build with headroom.
		cfg.MaxTurns = 50
	}
	if resolver == nil {
		return nil, fmt.Errorf("clarification resolver is required")
	}

	client := anthropic.NewClient(option.WithAPIKey(cfg.AnthropicAPIKey))

	return &Agent{
		cfg:      cfg,
		claude:   client,
		resolver: resolver,
	}, nil
}

// Run performs one build. Opens the MCP session, assembles the
// prompt, drives the tool-use loop until yield_final_answer fires
// or MaxTurns is reached.
func (a *Agent) Run(ctx context.Context, rc *RequestContext) (*Result, error) {
	if err := rc.Validate(); err != nil {
		return nil, err
	}

	// Connect to MCP and initialize. The client prefers Bearer auth
	// when rc.APIKey is set; otherwise it falls back to X-User-ID.
	a.mcp = NewMCPClient(a.cfg.MessageURL, rc.UserGUID, rc.APIKey)
	init, err := a.mcp.Initialize(ctx)
	if err != nil {
		return nil, fmt.Errorf("MCP initialize: %w", err)
	}
	defer a.mcp.Close()

	a.traceln("== MCP initialized (protocol %s)", init.ProtocolVersion)

	// Build the system prompt. Prefer the server's instructions
	// preamble if present; fall back to fetching catalog.md.
	pb := &PromptBuilder{
		CatalogURL: a.cfg.CatalogURL,
		UserGUID:   rc.UserGUID,
		APIKey:     rc.APIKey,
	}
	systemPrompt, err := pb.Build(ctx, rc, init.Instructions)
	if err != nil {
		return nil, fmt.Errorf("build system prompt: %w", err)
	}

	a.traceln("== System prompt assembled (%d chars)", len(systemPrompt))

	// Fetch the MCP tool list and build the Anthropic tool schema.
	mcpTools, err := a.mcp.ListTools(ctx)
	if err != nil {
		return nil, fmt.Errorf("MCP tools/list: %w", err)
	}
	anthropicTools := buildAnthropicTools(mcpTools)

	a.traceln("== %d MCP tools + %d runtime tools available", len(mcpTools), len(RuntimeTools()))

	// Seed the conversation with the user prompt.
	messages := []anthropic.MessageParam{
		anthropic.NewUserMessage(anthropic.NewTextBlock(rc.Prompt)),
	}

	for turn := 0; turn < a.cfg.MaxTurns; turn++ {
		a.traceln("-- turn %d --", turn+1)

		params := anthropic.MessageNewParams{
			Model:     anthropic.Model(a.cfg.Model),
			MaxTokens: 4096,
			System: []anthropic.TextBlockParam{
				{Text: systemPrompt},
			},
			Messages: messages,
			Tools:    anthropicTools,
		}

		resp, err := a.sendWithRetry(ctx, params)
		if err != nil {
			return nil, fmt.Errorf("Anthropic API: %w", err)
		}

		// Partition the response into text + tool_use blocks.
		var textOut string
		var toolCalls []anthropic.ToolUseBlock
		for _, block := range resp.Content {
			switch v := block.AsAny().(type) {
			case anthropic.TextBlock:
				textOut += v.Text
			case anthropic.ToolUseBlock:
				toolCalls = append(toolCalls, v)
			}
		}

		if textOut != "" {
			a.traceln("model: %s", trimForTrace(textOut, 400))
		}

		// No tool calls? The model decided it's done talking without
		// yielding. Treat as an incomplete session.
		if len(toolCalls) == 0 {
			return nil, fmt.Errorf("model returned no tool calls (stopped at turn %d without yielding)", turn+1)
		}

		// Record the assistant's message so the conversation stays
		// coherent when we feed back tool results.
		messages = append(messages, resp.ToParam())

		// Process every tool call. One of them may be yield_final_answer,
		// in which case we stop immediately. Otherwise we build a
		// user message with tool_result blocks for each.
		toolResults := make([]anthropic.ContentBlockParamUnion, 0, len(toolCalls))
		for _, tc := range toolCalls {
			a.traceln("tool_use: %s(%s)", tc.Name, trimForTrace(string(tc.Input), 200))

			// Check runtime tools first — they don't round-trip to MCP.
			switch tc.Name {
			case ToolYieldFinalAnswer:
				var args YieldArgs
				if err := parseToolInput(tc.Input, &args); err != nil {
					return nil, err
				}
				a.traceln("== yield_final_answer: dashboard_id=%s", args.DashboardID)
				return &Result{
					DashboardID: args.DashboardID,
					Summary:     args.Summary,
					Turns:       turn + 1,
				}, nil

			case ToolRequestClarification:
				var args ClarificationArgs
				if err := parseToolInput(tc.Input, &args); err != nil {
					return nil, err
				}
				answer, err := a.resolver.Resolve(ctx, args)
				if err != nil {
					return nil, fmt.Errorf("clarification resolver: %w", err)
				}
				a.traceln("clarification answer: %s", trimForTrace(answer, 200))
				toolResults = append(toolResults, anthropic.NewToolResultBlock(
					tc.ID, answer, false,
				))
				continue
			}

			// MCP tool. Pass the args through.
			var args map[string]interface{}
			if len(tc.Input) > 0 {
				if err := json.Unmarshal(tc.Input, &args); err != nil {
					return nil, fmt.Errorf("decode tool_use input for %s: %w", tc.Name, err)
				}
			}
			// Stamp the runtime namespace on create_* calls. The
			// runtime context is the source of truth — the agent has
			// historically forgotten to pass it, landing every record
			// in "default" regardless of --namespace. Force it here so
			// even a forgetful model still produces records in the
			// requested namespace.
			if rc.Namespace != "" && isNamespaceStampedTool(tc.Name) {
				if args == nil {
					args = map[string]interface{}{}
				}
				if existing, _ := args["namespace"].(string); existing == "" {
					args["namespace"] = rc.Namespace
				}
			}
			result, err := a.mcp.CallTool(ctx, tc.Name, args)
			if err != nil {
				// Feed the error back to the model as a tool result
				// so it can react — don't abort the run on one
				// tool failure.
				a.traceln("tool_result[error]: %s", err.Error())
				toolResults = append(toolResults, anthropic.NewToolResultBlock(
					tc.ID, err.Error(), true,
				))
				continue
			}
			a.traceln("tool_result: %s", trimForTrace(string(result), 400))
			toolResults = append(toolResults, anthropic.NewToolResultBlock(
				tc.ID, string(result), false,
			))
		}

		messages = append(messages, anthropic.NewUserMessage(toolResults...))
	}

	return nil, fmt.Errorf("exceeded max turns (%d) without yielding a final answer", a.cfg.MaxTurns)
}

// sendWithRetry wraps Messages.New with backoff. Two retry classes:
//   - HTTP 429 (rate limit) — honor retry-after header when provided,
//     otherwise exponential backoff starting at 15s.
//   - Transient network errors (DNS lookup failure, connection
//     refused, connection reset) — short fixed backoff at 5s, since
//     these usually resolve in seconds.
// Other errors fail fast. Both retry classes share a single attempt
// budget so a degraded environment doesn't loop forever.
func (a *Agent) sendWithRetry(ctx context.Context, params anthropic.MessageNewParams) (*anthropic.Message, error) {
	const maxRetries = 4
	const rateLimitBaseBackoff = 15 * time.Second
	const rateLimitMaxBackoff = 90 * time.Second
	const networkBackoff = 5 * time.Second

	rateLimitBackoff := rateLimitBaseBackoff
	for attempt := 0; ; attempt++ {
		resp, err := a.claude.Messages.New(ctx, params)
		if err == nil {
			return resp, nil
		}
		if attempt >= maxRetries {
			return nil, err
		}

		var wait time.Duration
		switch {
		case isRateLimit(err):
			wait = retryAfterFrom(err)
			if wait <= 0 {
				wait = rateLimitBackoff
				rateLimitBackoff *= 2
				if rateLimitBackoff > rateLimitMaxBackoff {
					rateLimitBackoff = rateLimitMaxBackoff
				}
			}
			a.traceln("== 429 from Anthropic; sleeping %s before retry %d/%d", wait, attempt+1, maxRetries)
		case isTransientNetworkError(err):
			wait = networkBackoff
			a.traceln("== transient network error (%v); sleeping %s before retry %d/%d", err, wait, attempt+1, maxRetries)
		default:
			// Not retryable — fail fast.
			return nil, err
		}

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(wait):
		}
	}
}

// isRateLimit returns true if err is an Anthropic 429.
func isRateLimit(err error) bool {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		return apiErr.StatusCode == 429
	}
	return false
}

// isTransientNetworkError returns true if err looks like something
// that'll probably work if we wait a few seconds and try again — DNS
// resolution failure, connection refused, connection reset, TLS
// handshake timeout. All are common on home networks and warrant a
// short automatic retry before surfacing to the user.
func isTransientNetworkError(err error) bool {
	if err == nil {
		return false
	}
	// net.OpError wraps the underlying cause (dial, read, write).
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		// DNS failures wrap a net.DNSError.
		var dnsErr *net.DNSError
		if errors.As(opErr.Err, &dnsErr) {
			return true
		}
		// "connection refused" / "connection reset" / "broken pipe" /
		// "network is unreachable" all show up as SyscallError or bare
		// string errors on the OpErr. Match by message as a fallback.
		msg := opErr.Err.Error()
		for _, frag := range []string{
			"connection refused",
			"connection reset",
			"no route to host",
			"network is unreachable",
			"broken pipe",
			"i/o timeout",
		} {
			if strings.Contains(msg, frag) {
				return true
			}
		}
		return false
	}
	// url.Error wraps most net/http client errors. Unwrap and recurse.
	var urlErr *url.Error
	if errors.As(err, &urlErr) {
		// url.Error has a Temporary() method but it's unreliable.
		// Check the wrapped error directly.
		if urlErr.Err != nil && isTransientNetworkError(urlErr.Err) {
			return true
		}
	}
	return false
}

// retryAfterFrom extracts the retry-after header from an Anthropic
// error's underlying HTTP response, if present. Supports both the
// integer-seconds form and the HTTP-date form. Returns 0 if absent
// or unparseable (caller falls back to its own backoff).
func retryAfterFrom(err error) time.Duration {
	var apiErr *anthropic.Error
	if !errors.As(err, &apiErr) || apiErr.Response == nil {
		return 0
	}
	h := apiErr.Response.Header.Get("Retry-After")
	if h == "" {
		// Anthropic also publishes per-bucket reset headers — use the
		// longest if present.
		for _, name := range []string{
			"anthropic-ratelimit-requests-reset",
			"anthropic-ratelimit-tokens-reset",
			"anthropic-ratelimit-input-tokens-reset",
			"anthropic-ratelimit-output-tokens-reset",
		} {
			v := apiErr.Response.Header.Get(name)
			if v == "" {
				continue
			}
			if t, perr := time.Parse(time.RFC3339, v); perr == nil {
				d := time.Until(t)
				if d > 0 && d < 5*time.Minute {
					// Add a small fixed buffer so we don't race the
					// reset boundary.
					return d + 2*time.Second
				}
			}
		}
		return 0
	}
	if secs, perr := strconv.Atoi(h); perr == nil && secs >= 0 && secs < 300 {
		return time.Duration(secs)*time.Second + 2*time.Second
	}
	if t, perr := time.Parse(time.RFC1123, h); perr == nil {
		d := time.Until(t)
		if d > 0 && d < 5*time.Minute {
			return d + 2*time.Second
		}
	}
	return 0
}

// buildAnthropicTools converts MCP tool specs + runtime tool specs
// into the Anthropic SDK's tool schema.
func buildAnthropicTools(mcp []Tool) []anthropic.ToolUnionParam {
	runtime := RuntimeTools()
	out := make([]anthropic.ToolUnionParam, 0, len(mcp)+len(runtime))

	for _, t := range mcp {
		props, req := propsAndRequired(t.InputSchema)
		tool := anthropic.ToolParam{
			Name:        t.Name,
			Description: anthropic.String(t.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: props,
				Required:   req,
			},
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tool})
	}

	for _, rt := range runtime {
		props, req := propsAndRequired(rt.InputSchema)
		tool := anthropic.ToolParam{
			Name:        rt.Name,
			Description: anthropic.String(rt.Description),
			InputSchema: anthropic.ToolInputSchemaParam{
				Properties: props,
				Required:   req,
			},
		}
		out = append(out, anthropic.ToolUnionParam{OfTool: &tool})
	}

	return out
}

// propsAndRequired pulls `properties` and `required` out of a JSON
// schema object in the shape MCP + our runtime tools use.
func propsAndRequired(schema map[string]interface{}) (map[string]interface{}, []string) {
	props := map[string]interface{}{}
	if p, ok := schema["properties"].(map[string]interface{}); ok {
		props = p
	}
	var req []string
	if r, ok := schema["required"].([]interface{}); ok {
		for _, v := range r {
			if s, ok := v.(string); ok {
				req = append(req, s)
			}
		}
	} else if r, ok := schema["required"].([]string); ok {
		req = r
	}
	return props, req
}

func (a *Agent) traceln(format string, args ...interface{}) {
	if a.cfg.TranscriptWriter == nil {
		return
	}
	fmt.Fprintf(a.cfg.TranscriptWriter, format+"\n", args...)
}

// isNamespaceStampedTool returns true for MCP create tools where the
// runtime context's namespace should be auto-injected when the model
// didn't supply one. Update tools deliberately are NOT stamped — moving
// a record across namespaces is a separate, explicit operation the
// model must request.
func isNamespaceStampedTool(name string) bool {
	switch name {
	case "create_component", "create_dashboard", "create_connection":
		return true
	}
	return false
}

func trimForTrace(s string, max int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
