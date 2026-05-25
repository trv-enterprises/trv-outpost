// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

// JSON-RPC 2.0 types for MCP protocol

// JSONRPCRequest represents an incoming JSON-RPC request
type JSONRPCRequest struct {
	JSONRPC string                 `json:"jsonrpc"`
	ID      interface{}            `json:"id"`
	Method  string                 `json:"method"`
	Params  map[string]interface{} `json:"params,omitempty"`
}

// JSONRPCResponse represents an outgoing JSON-RPC response
type JSONRPCResponse struct {
	JSONRPC string       `json:"jsonrpc"`
	ID      interface{}  `json:"id,omitempty"`
	Result  interface{}  `json:"result,omitempty"`
	Error   *JSONRPCError `json:"error,omitempty"`
}

// JSONRPCError represents a JSON-RPC error
type JSONRPCError struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

// SSEMessage represents an SSE message for MCP
type SSEMessage struct {
	JSONRPC string                 `json:"jsonrpc"`
	Method  string                 `json:"method,omitempty"`
	Params  map[string]interface{} `json:"params,omitempty"`
}

// Tool represents an MCP tool definition
type Tool struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema InputSchema `json:"inputSchema"`
}

// InputSchema represents JSON Schema for tool input
type InputSchema struct {
	Type       string                    `json:"type"`
	Properties map[string]PropertySchema `json:"properties,omitempty"`
	Required   []string                  `json:"required,omitempty"`
}

// PropertySchema represents a property in JSON Schema
type PropertySchema struct {
	Type        string   `json:"type"`
	Description string   `json:"description,omitempty"`
	Enum        []string `json:"enum,omitempty"`
	Default     interface{} `json:"default,omitempty"`
}

// ToolHandler is a function type for handling tool calls
type ToolHandler func(args map[string]interface{}) (interface{}, error)

// ServerInfo represents MCP server information
type ServerInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

// Capabilities represents MCP server capabilities
type Capabilities struct {
	Tools   map[string]interface{} `json:"tools,omitempty"`
	Prompts map[string]interface{} `json:"prompts,omitempty"`
}

// Prompt represents an MCP prompt definition. Prompts are pre-baked
// templates the client (Claude Desktop, etc.) surfaces to the user as
// opt-in slash commands. Picking a prompt injects its content as the
// system/role framing for the conversation. We use this for the
// `dashboard-builder` persona — Claude Desktop users who want the
// in-app dashboard-agent behavior can opt into it explicitly without
// the framing polluting other MCP consumers' base experience.
type Prompt struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Arguments   []PromptArgument `json:"arguments,omitempty"`
}

// PromptArgument is a per-prompt placeholder the client can fill in
// before injecting. We don't use arguments today — the dashboard-
// builder prompt is parameterless.
type PromptArgument struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Required    bool   `json:"required,omitempty"`
}

// PromptMessage is a single message inside a prompt's content. Per
// the MCP spec, prompts return an array of messages; the simplest
// useful shape is a single user-role message containing the prompt
// text. Claude Desktop renders this as system/role framing.
type PromptMessage struct {
	Role    string         `json:"role"`
	Content PromptContent  `json:"content"`
}

// PromptContent wraps the actual prompt text in a typed envelope per
// the MCP spec. Only "text" content is implemented today.
type PromptContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// PromptsListResult is the response shape for `prompts/list`.
type PromptsListResult struct {
	Prompts []Prompt `json:"prompts"`
}

// PromptsGetResult is the response shape for `prompts/get`.
type PromptsGetResult struct {
	Description string          `json:"description,omitempty"`
	Messages    []PromptMessage `json:"messages"`
}

// InitializeResult represents the result of initialize method. The
// Instructions field is an MCP spec feature that clients (notably Claude
// Desktop) surface to the model before the first turn — we use it to
// preload the unified type catalog so agents don't have to discover
// chart/control/connection types via tool calls on every session.
type InitializeResult struct {
	ProtocolVersion string       `json:"protocolVersion"`
	ServerInfo      ServerInfo   `json:"serverInfo"`
	Capabilities    Capabilities `json:"capabilities"`
	Instructions    string       `json:"instructions,omitempty"`
}

// ToolsListResult represents the result of tools/list method
type ToolsListResult struct {
	Tools []Tool `json:"tools"`
}

// Standard JSON-RPC error codes
const (
	ParseError     = -32700
	InvalidRequest = -32600
	MethodNotFound = -32601
	InvalidParams  = -32602
	InternalError  = -32603
)
