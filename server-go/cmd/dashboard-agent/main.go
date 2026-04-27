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
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"regexp"
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
		dashboardKey  string
		model         string
		maxTurns      int
		logDir        string
		noLog         bool
	)

	flag.StringVar(&serverURL, "server", "http://localhost:3001", "Base URL of the dashboard server")
	flag.StringVar(&connectionID, "connection-id", "", "Connection ID to use as the data source")
	flag.StringVar(&namespace, "namespace", "default", "Target namespace for created components + dashboard")
	flag.StringVar(&dashboardName, "dashboard-name", "", "Explicit dashboard name (optional — agent picks if empty)")
	flag.StringVar(&dimensions, "dimensions", "", "Canvas dimensions as WxH, e.g. 2560x1440")
	flag.StringVar(&prompt, "prompt", "", "User request text (required)")
	flag.StringVar(&userGUID, "user", "", "Acting user GUID (legacy — prefer --api-key). Defaults to the DASHBOARD_USER_GUID env var when unset.")
	flag.StringVar(&dashboardKey, "api-key", "", "Dashboard API key (trve_…). Sent as Authorization: Bearer. Defaults to the DASHBOARD_API_KEY env var when unset.")
	flag.StringVar(&model, "model", "claude-sonnet-4-6", "Claude model ID")
	flag.IntVar(&maxTurns, "max-turns", 50, "Cap on agentic loop iterations")
	flag.StringVar(&logDir, "log-dir", "docs/agent-runs", "Directory where each run's transcript is saved as a markdown file (relative to the working directory). Use --no-log to disable.")
	flag.BoolVar(&noLog, "no-log", false, "Disable per-run transcript logging")

	flag.Parse()

	// Env-var fallbacks so a user can keep credentials out of shell
	// history. Explicit flags always win.
	if dashboardKey == "" {
		dashboardKey = os.Getenv("DASHBOARD_API_KEY")
	}
	if userGUID == "" {
		userGUID = os.Getenv("DASHBOARD_USER_GUID")
	}

	if prompt == "" {
		die("--prompt is required")
	}
	if dashboardKey == "" && userGUID == "" {
		die("either --api-key (preferred) or --user is required")
	}
	if dashboardKey == "" {
		fmt.Fprintln(os.Stderr,
			"warning: --user is the legacy identity-assertion path; create an API key under Manage Mode → API Keys and pass --api-key (or DASHBOARD_API_KEY env var) instead.")
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

	// Transcript target: stderr always; optionally tee'd to a dated
	// markdown file under logDir. Name is YYYY-MM-DD-HHMMSS-<slug>.md
	// so runs with the same dashboard name don't clobber each other.
	transcriptWriter := io.Writer(os.Stderr)
	var logPath string
	if !noLog {
		var logFile *os.File
		logFile, logPath, err = openRunLog(logDir, dashboardName, prompt)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not open run log (%v); continuing without file transcript\n", err)
		} else {
			defer logFile.Close()
			authMode := "X-User-ID (legacy)"
			if dashboardKey != "" {
				authMode = "Bearer (API key)"
			}
			writeLogHeader(logFile, serverURL, connectionID, userGUID, namespace, dashboardName, width, height, prompt, model, authMode)
			transcriptWriter = io.MultiWriter(os.Stderr, logFile)
		}
	}

	cfg := dashboard.Config{
		AnthropicAPIKey:  apiKey,
		Model:            model,
		MessageURL:       serverURL + "/mcp/message",
		CatalogURL:       serverURL + "/api/registry/catalog.md",
		MaxTurns:         maxTurns,
		TranscriptWriter: transcriptWriter,
	}

	rc := &dashboard.RequestContext{
		Prompt:           prompt,
		ConnectionID:     connectionID,
		Namespace:        namespace,
		DashboardName:    dashboardName,
		DimensionsWidth:  width,
		DimensionsHeight: height,
		UserGUID:         userGUID,
		APIKey:           dashboardKey,
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	ctx, timeoutCancel := context.WithTimeout(ctx, 15*time.Minute)
	defer timeoutCancel()

	agent, err := dashboard.NewAgent(cfg, newStdinResolver())
	if err != nil {
		die("agent setup: %v", err)
	}

	fmt.Fprintf(transcriptWriter, "== dashboard-agent starting (server=%s, connection=%s, canvas=%dx%d)\n",
		serverURL, connectionID, width, height)
	if logPath != "" {
		fmt.Fprintf(os.Stderr, "== transcript: %s\n", logPath)
	}

	result, err := agent.Run(ctx, rc)
	if err != nil {
		fmt.Fprintf(transcriptWriter, "\n== RUN FAILED: %v\n```\n", err)
		die("run failed: %v", err)
	}

	fmt.Fprintf(transcriptWriter, "\n== DONE in %d turns\n", result.Turns)
	fmt.Fprintf(transcriptWriter, "dashboard_id: %s\n", result.DashboardID)
	fmt.Fprintf(transcriptWriter, "summary:      %s\n", result.Summary)
	fmt.Fprintln(transcriptWriter, "```")

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

// openRunLog creates (or mkdir -p's) logDir and opens a new markdown
// file for this run. Filename is YYYY-MM-DD-HHMMSS-<slug>.md so two
// runs in the same session don't collide. The slug is derived from
// the dashboard name if set, else from the prompt's first few words.
func openRunLog(logDir, dashboardName, prompt string) (*os.File, string, error) {
	if err := os.MkdirAll(logDir, 0o755); err != nil {
		return nil, "", fmt.Errorf("mkdir %s: %w", logDir, err)
	}
	slugSrc := dashboardName
	if slugSrc == "" {
		slugSrc = prompt
	}
	name := fmt.Sprintf("%s-%s.md", time.Now().Format("2006-01-02-150405"), slug(slugSrc))
	path := filepath.Join(logDir, name)
	f, err := os.Create(path)
	if err != nil {
		return nil, "", err
	}
	return f, path, nil
}

// writeLogHeader stamps the run's metadata at the top of the
// transcript file so someone reading it later has context without
// having to cross-reference shell history.
func writeLogHeader(w io.Writer, serverURL, connectionID, userGUID, namespace, dashboardName string, width, height int, prompt, model, authMode string) {
	fmt.Fprintf(w, "# Dashboard-agent run — %s\n\n", time.Now().Format(time.RFC3339))
	fmt.Fprintf(w, "- server: %s\n", serverURL)
	fmt.Fprintf(w, "- connection_id: %s\n", connectionID)
	fmt.Fprintf(w, "- auth: %s\n", authMode)
	if userGUID != "" {
		fmt.Fprintf(w, "- user_guid: %s\n", userGUID)
	}
	fmt.Fprintf(w, "- namespace: %s\n", namespace)
	if dashboardName != "" {
		fmt.Fprintf(w, "- dashboard_name: %q\n", dashboardName)
	}
	if width > 0 {
		fmt.Fprintf(w, "- canvas: %dx%d\n", width, height)
	}
	fmt.Fprintf(w, "- model: %s\n\n", model)
	fmt.Fprintf(w, "## Prompt\n\n```\n%s\n```\n\n", prompt)
	fmt.Fprintf(w, "## Transcript\n\n```\n")
}

// slug converts an arbitrary string to a filesystem-safe, lowercase,
// dash-separated fragment. Truncated so the full filename stays
// comfortably under most filesystems' length limits.
var slugNonAlnum = regexp.MustCompile(`[^a-z0-9]+`)

func slug(s string) string {
	s = strings.ToLower(s)
	s = slugNonAlnum.ReplaceAllString(s, "-")
	s = strings.Trim(s, "-")
	if s == "" {
		s = "run"
	}
	if len(s) > 48 {
		s = strings.TrimRight(s[:48], "-")
	}
	return s
}

func die(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "error: "+format+"\n", args...)
	os.Exit(1)
}
