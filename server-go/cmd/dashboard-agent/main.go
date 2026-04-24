// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Command dashboard-agent runs a one-shot dashboard build by
// delegating to Claude via the project's MCP server. See
// internal/agent/dashboard for the agent implementation.
package main

import (
	"bufio"
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/agent/dashboard"
)

func main() {
	var (
		serverURL     string
		connectionID  string
		namespace     string
		dashboardName string
		dimensions    string
		prompt        string
		userGUID      string
		model         string
		maxTurns      int
	)

	flag.StringVar(&serverURL, "server", "http://localhost:3001", "Base URL of the dashboard server")
	flag.StringVar(&connectionID, "connection-id", "", "Connection ID to use as the data source")
	flag.StringVar(&namespace, "namespace", "default", "Target namespace for created components + dashboard")
	flag.StringVar(&dashboardName, "dashboard-name", "", "Explicit dashboard name (optional — agent picks if empty)")
	flag.StringVar(&dimensions, "dimensions", "", "Canvas dimensions as WxH, e.g. 2560x1440")
	flag.StringVar(&prompt, "prompt", "", "User request text (required)")
	flag.StringVar(&userGUID, "user", "", "Acting user GUID (required)")
	flag.StringVar(&model, "model", "claude-sonnet-4-6", "Claude model ID")
	flag.IntVar(&maxTurns, "max-turns", 50, "Cap on agentic loop iterations")

	flag.Parse()

	if prompt == "" {
		die("--prompt is required")
	}
	if userGUID == "" {
		die("--user is required")
	}

	apiKey := os.Getenv("DASHBOARD_ANTHROPIC_API_KEY")
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		die("DASHBOARD_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY must be set in the environment")
	}

	width, height, err := dashboard.ParseDimensions(dimensions)
	if err != nil {
		die("%v", err)
	}

	serverURL = strings.TrimRight(serverURL, "/")
	cfg := dashboard.Config{
		AnthropicAPIKey:  apiKey,
		Model:            model,
		MessageURL:       serverURL + "/mcp/message",
		CatalogURL:       serverURL + "/api/registry/catalog.md",
		MaxTurns:         maxTurns,
		TranscriptWriter: os.Stderr,
	}

	rc := &dashboard.RequestContext{
		Prompt:           prompt,
		ConnectionID:     connectionID,
		Namespace:        namespace,
		DashboardName:    dashboardName,
		DimensionsWidth:  width,
		DimensionsHeight: height,
		UserGUID:         userGUID,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	ctx, timeoutCancel := context.WithTimeout(ctx, 15*time.Minute)
	defer timeoutCancel()

	agent, err := dashboard.NewAgent(cfg, newStdinResolver())
	if err != nil {
		die("agent setup: %v", err)
	}

	fmt.Fprintf(os.Stderr, "== dashboard-agent starting (server=%s, connection=%s, canvas=%dx%d)\n",
		serverURL, connectionID, width, height)

	result, err := agent.Run(ctx, rc)
	if err != nil {
		die("run failed: %v", err)
	}

	fmt.Fprintf(os.Stderr, "\n== DONE in %d turns\n", result.Turns)
	fmt.Fprintf(os.Stderr, "dashboard_id: %s\n", result.DashboardID)
	fmt.Fprintf(os.Stderr, "summary:      %s\n", result.Summary)

	// Also print the dashboard ID to stdout so scripts can pipe it.
	fmt.Println(result.DashboardID)
}

// stdinResolver is a ClarificationResolver that prompts on stdin.
// Used only in CLI mode; a chat UI would supply its own resolver.
type stdinResolver struct {
	reader *bufio.Reader
}

func newStdinResolver() *stdinResolver {
	return &stdinResolver{reader: bufio.NewReader(os.Stdin)}
}

func (s *stdinResolver) Resolve(ctx context.Context, args dashboard.ClarificationArgs) (string, error) {
	fmt.Fprintln(os.Stderr, "\n== Agent needs clarification ==")
	fmt.Fprintln(os.Stderr, "Q:", args.Question)
	if args.Reason != "" {
		fmt.Fprintln(os.Stderr, "(", args.Reason, ")")
	}
	fmt.Fprint(os.Stderr, "A> ")
	line, err := s.reader.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("read clarification: %w", err)
	}
	return strings.TrimRight(line, "\r\n"), nil
}

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
