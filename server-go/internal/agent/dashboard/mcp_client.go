// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package dashboard

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync/atomic"
	"time"
)

// MCPClient is a minimal client for this dashboard's MCP surface. The
// server's dialect is simpler than full MCP: every JSON-RPC request
// is a POST to /mcp/message that returns the response synchronously
// as the HTTP response body. /mcp/sse is an optional notification
// channel we do not need to consume for the agent's workflow — we
// open it only if the session requires server-initiated events
// (which today, the agent does not).
//
// Lifecycle:
//
//	c := NewMCPClient(messageURL, userGUID)
//	init, err := c.Initialize(ctx)      // returns InitializeResult
//	tools, err := c.ListTools(ctx)
//	out, err := c.CallTool(ctx, "list_connections", args)
type MCPClient struct {
	messageURL string
	userGUID   string
	httpClient *http.Client
	nextID     atomic.Int64
}

// Tool describes one tool the server exposes.
type Tool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description"`
	InputSchema map[string]interface{} `json:"inputSchema"`
}

// InitializeResult mirrors the server-side InitializeResult. The
// Instructions field carries the prebuilt session preamble (role
// hints + rendered type catalog) assembled by the server. An agent
// that consumes this does not need to separately fetch
// /api/registry/catalog.md.
type InitializeResult struct {
	ProtocolVersion string                 `json:"protocolVersion"`
	ServerInfo      map[string]interface{} `json:"serverInfo"`
	Capabilities    map[string]interface{} `json:"capabilities"`
	Instructions    string                 `json:"instructions,omitempty"`
}

// NewMCPClient builds a client. messageURL is the JSON-RPC POST
// endpoint (e.g. http://localhost:3001/mcp/message).
func NewMCPClient(messageURL, userGUID string) *MCPClient {
	return &MCPClient{
		messageURL: messageURL,
		userGUID:   userGUID,
		httpClient: &http.Client{Timeout: 60 * time.Second},
	}
}

// Initialize performs the MCP handshake and returns the server's
// InitializeResult (including the Instructions preamble).
func (c *MCPClient) Initialize(ctx context.Context) (*InitializeResult, error) {
	raw, err := c.request(ctx, "initialize", map[string]interface{}{
		"protocolVersion": "2024-11-05",
		"capabilities": map[string]interface{}{
			"tools": map[string]interface{}{},
		},
		"clientInfo": map[string]interface{}{
			"name":    "trve-dashboard-agent",
			"version": "0.1.0",
		},
	})
	if err != nil {
		return nil, err
	}
	var out InitializeResult
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decode initialize result: %w", err)
	}
	return &out, nil
}

// ListTools fetches the full tool registry from the server.
func (c *MCPClient) ListTools(ctx context.Context) ([]Tool, error) {
	raw, err := c.request(ctx, "tools/list", map[string]interface{}{})
	if err != nil {
		return nil, err
	}
	var parsed struct {
		Tools []Tool `json:"tools"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("decode tools/list result: %w", err)
	}
	return parsed.Tools, nil
}

// CallTool invokes a tool and returns the server's raw result bytes.
// The caller unmarshals into whatever shape the tool returns.
func (c *MCPClient) CallTool(ctx context.Context, name string, args map[string]interface{}) ([]byte, error) {
	if args == nil {
		args = map[string]interface{}{}
	}
	return c.request(ctx, "tools/call", map[string]interface{}{
		"name":      name,
		"arguments": args,
	})
}

// Close is a no-op for the POST-based client; kept for symmetry so
// callers can `defer c.Close()` regardless of transport.
func (c *MCPClient) Close() error { return nil }

// --- internals ---

type jsonRPCRequest struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      int64       `json:"id"`
	Method  string      `json:"method"`
	Params  interface{} `json:"params,omitempty"`
}

type jsonRPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *jsonRPCError   `json:"error,omitempty"`
}

type jsonRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *MCPClient) request(ctx context.Context, method string, params interface{}) (json.RawMessage, error) {
	id := c.nextID.Add(1)
	body, err := json.Marshal(jsonRPCRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  params,
	})
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.messageURL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.userGUID != "" {
		req.Header.Set("X-User-ID", c.userGUID)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	// The server returns 400 / 500 for JSON-RPC errors but the body is
	// still a well-formed JSON-RPC response envelope — parse first,
	// then let the error field drive the outcome.
	var parsed jsonRPCResponse
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("POST %s (%d): %s", c.messageURL, resp.StatusCode, string(respBody))
	}
	if parsed.Error != nil {
		return nil, fmt.Errorf("%s: %s (code %d)", method, parsed.Error.Message, parsed.Error.Code)
	}
	return parsed.Result, nil
}
