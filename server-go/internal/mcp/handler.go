// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math/rand"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// Handler handles MCP SSE connections and messages
type Handler struct {
	registry *ToolRegistry
	clients  sync.Map // map[string]*sseClient
}

type sseClient struct {
	id       string
	response gin.ResponseWriter
	done     chan struct{}
}

// NewHandler creates a new MCP handler
func NewHandler(registry *ToolRegistry) *Handler {
	return &Handler{
		registry: registry,
	}
}

// SSEConnect handles the SSE connection endpoint
// @Summary MCP SSE Connection
// @Description Establish an SSE connection for MCP protocol
// @Tags MCP
// @Produce text/event-stream
// @Success 200 {string} string "SSE stream"
// @Router /mcp/sse [get]
func (h *Handler) SSEConnect(c *gin.Context) {
	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("Access-Control-Allow-Origin", "*")
	c.Header("X-Accel-Buffering", "no") // Disable nginx buffering

	// Generate client ID
	clientID := fmt.Sprintf("client_%d_%s", time.Now().UnixNano(), randomString(9))

	// Create client
	client := &sseClient{
		id:       clientID,
		response: c.Writer,
		done:     make(chan struct{}),
	}

	// Store client
	h.clients.Store(clientID, client)
	defer func() {
		h.clients.Delete(clientID)
		close(client.done)
		log.Printf("[MCP] SSE client disconnected: %s", clientID)
	}()

	log.Printf("[MCP] SSE client connected: %s", clientID)

	// Send initial connection message
	h.sendSSEMessage(c.Writer, SSEMessage{
		JSONRPC: "2.0",
		Method:  "connection.established",
		Params: map[string]interface{}{
			"clientId": clientID,
			"serverInfo": map[string]interface{}{
				"name":    "trve-dashboard-mcp",
				"version": "1.0.0",
				"capabilities": map[string]interface{}{
					"tools":       true,
					"connections": true,
					"dashboards":  true,
				},
			},
		},
	})

	// Flush to ensure message is sent
	c.Writer.Flush()

	// Keep connection alive until client disconnects
	<-c.Request.Context().Done()
}

// HandleMessage handles JSON-RPC messages from clients
// @Summary Handle MCP Message
// @Description Process a JSON-RPC message for MCP protocol
// @Tags MCP
// @Accept json
// @Produce json
// @Param message body JSONRPCRequest true "JSON-RPC request"
// @Success 200 {object} JSONRPCResponse
// @Failure 400 {object} JSONRPCResponse
// @Failure 500 {object} JSONRPCResponse
// @Router /mcp/message [post]
func (h *Handler) HandleMessage(c *gin.Context) {
	var req JSONRPCRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      nil,
			Error: &JSONRPCError{
				Code:    ParseError,
				Message: fmt.Sprintf("Failed to parse request: %v", err),
			},
		})
		return
	}

	log.Printf("[MCP] Received request: method=%s, id=%v", req.Method, req.ID)

	if req.JSONRPC != "2.0" {
		c.JSON(http.StatusBadRequest, JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &JSONRPCError{
				Code:    InvalidRequest,
				Message: "Invalid JSON-RPC version",
			},
		})
		return
	}

	var result interface{}
	var err error

	switch req.Method {
	case "initialize":
		result = h.handleInitialize(req.Params)
	case "tools/list":
		result = h.handleToolsList()
	case "tools/call":
		result, err = h.handleToolsCall(req.Params)
	case "prompts/list":
		result = h.handlePromptsList()
	case "prompts/get":
		result, err = h.handlePromptsGet(req.Params)
	default:
		c.JSON(http.StatusBadRequest, JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &JSONRPCError{
				Code:    MethodNotFound,
				Message: fmt.Sprintf("Method not found: %s", req.Method),
			},
		})
		return
	}

	if err != nil {
		log.Printf("[MCP] Error handling %s: %v", req.Method, err)
		c.JSON(http.StatusInternalServerError, JSONRPCResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error: &JSONRPCError{
				Code:    InternalError,
				Message: err.Error(),
			},
		})
		return
	}

	log.Printf("[MCP] Sending success response for %s", req.Method)
	c.JSON(http.StatusOK, JSONRPCResponse{
		JSONRPC: "2.0",
		ID:      req.ID,
		Result:  result,
	})
}

// handleInitialize handles the initialize method. We preload the unified
// type catalog into the `instructions` field so every agent session starts
// with full knowledge of connection types, chart/control/display subtypes,
// and user-defined device types without having to burn a tool round-trip.
// The catalog is a snapshot taken at initialize time — the preamble tells
// the agent to re-fetch via get_type_catalog if it suspects staleness.
func (h *Handler) handleInitialize(params map[string]interface{}) InitializeResult {
	return InitializeResult{
		ProtocolVersion: "2024-11-05",
		ServerInfo: ServerInfo{
			Name:    "trve-dashboard-mcp",
			Version: "1.0.0",
		},
		Capabilities: Capabilities{
			Tools:   map[string]interface{}{},
			Prompts: map[string]interface{}{},
		},
		Instructions: h.buildInstructions(),
	}
}

// buildInstructions assembles the session preamble + rendered type catalog.
// Runs once per MCP session at initialize time. Safe to call even if the
// catalog can't be built (device-type service unavailable) — we degrade to
// a catalog without device types rather than failing the handshake.
func (h *Handler) buildInstructions() string {
	var sb strings.Builder

	sb.WriteString(`You are connected to a trve-dashboard backend via MCP. This server
exposes tools for managing **connections** (external data sources like SQL,
MQTT, EdgeLake, Prometheus, REST APIs), **components** (charts, controls,
and displays — all stored in one collection, discriminated by component_type),
and **dashboards** (a name plus a 32x32-px cell panel grid where each panel
references a component or carries inline text).

# Terminology

The system's umbrella term for an external data source is **connection**.
Older code and docs occasionally say "datasource" — that's a retired name;
the BSON field is ` + "`connection_id`" + ` and the route family is
` + "`/api/connections`" + `. Don't introduce ` + "`datasource_id`" + `.

# Conventions

- Every component, connection, and dashboard belongs to exactly one
  **namespace**. Names are unique within a namespace, not globally — two
  namespaces can each have a dashboard called "Home." When creating a
  record, pass ` + "`namespace`" + ` explicitly. Don't cross namespaces.
- **Versioning**: ` + "`update_component`" + ` creates a new version; older
  versions remain queryable. Names must stay consistent across versions of
  the same component, so collisions on update are usually intent
  (renaming) rather than mistake.
- **Component sub-types**: charts (ECharts visualizations), controls
  (buttons/toggles/sliders that send commands), displays (cameras, weather,
  alerts). The ` + "`chart.custom`" + ` subtype is the escape hatch — pass
  ` + "`use_custom_code=true`" + ` plus ` + "`component_code`" + ` (React source) for
  anything outside the canonical chart types.
- **Streaming vs polling**: a chart's ` + "`query_config.type`" + ` decides this.
  ` + "`stream_filter`" + ` subscribes to a live stream (MQTT, ts-store push, etc.)
  and re-renders on each record. Other types poll at the component's
  ` + "`refresh_interval`" + ` (milliseconds). Pick stream for true real-time
  sources, polling for SQL/Prometheus/REST.

# Discovery flow (call these AFTER picking a connection)

When you've identified which connection a component should read from but
haven't built ` + "`query_config`" + ` yet:

1. ` + "`get_connection_type_guidance(type)`" + ` — TRVE-dashboard-specific
   ` + "`query_config`" + ` envelope shape for that adapter type (Prometheus's
   ` + "`query_type`" + `/` + "`start`" + `/` + "`step`" + `, SQL's positional binding,
   EdgeLake's ` + "`database`" + ` param, MQTT's ` + "`data_path`" + `, …). Skip if
   you've already worked with that type this session.
2. The discovery tool for that connection type:
   - SQL / Prometheus → ` + "`get_connection_schema`" + `
   - MQTT → ` + "`list_mqtt_topics`" + `, ` + "`sample_mqtt_topic`" + `
   - EdgeLake → ` + "`list_edgelake_databases`" + ` → ` + "`list_edgelake_tables`" + ` →
     ` + "`get_edgelake_table_schema`" + `
3. (Optional) ` + "`query_connection`" + ` with ` + "`limit: 1`" + ` to verify the
   real return-column shape before committing — cheap probe.
4. ` + "`get_component_template(chart_type)`" + ` for the ECharts skeleton.
5. ` + "`create_component`" + ` with the resolved ` + "`query_config`" + ` + ` + "`data_mapping`" + `.

Which chart_type fits which data is your own judgment call — that's
general visualization knowledge, not TRVE-dashboard knowledge.

# Grid contract

Dashboards are a flat matrix of 32 x 32 pixel cells with 4 px gaps
between cells. Panel positions and sizes are expressed in cells via
` + "`x`" + `, ` + "`y`" + `, ` + "`w`" + `, ` + "`h`" + `.

Available cols/rows depend on the canvas AND on a fixed viewer-chrome
budget (the app header + toolbar + 4-px padding). The viewer computes:

    cols = floor( canvas_width_px               / 36 )
    rows = floor( (canvas_height_px - 105)      / 36 )

Worked examples (canvas -> grid):

    2560 x 1440  ->  71 cols x 37 rows
    1920 x 1080  ->  53 cols x 27 rows
    1280 x  720  ->  35 cols x 17 rows

Panels must not overlap, and every panel must satisfy
` + "`x + w <= cols`" + ` and ` + "`y + h <= rows`" + `. When packing N equal panels into
an A x B grid, compute panel_w = floor(cols / A) and
panel_h = floor(rows / B).

Don't hardcode "12 columns" — that's a Carbon responsive-breakpoint
convention, not this app's runtime grid. If the user hasn't stated a
canvas size, call ` + "`list_dashboard_dimensions`" + ` to see the deployment's
presets and the configured default.

# Staleness

The catalog below is a snapshot taken when this MCP session was established.
It covers stable type metadata — chart subtypes, control subtypes, connection
adapter capabilities, registered device types. If you add a new device type
mid-session or suspect something has changed, call ` + "`get_type_catalog`" + ` to
refetch.

Connection *instances* (the actual configured SQL/MQTT/API connections) and
component *instances* (the actual charts, controls, dashboards) are NOT in
this preamble — call the list tools for those, they change constantly.

# Type catalog (snapshot)

`)

	cat, err := registry.BuildCatalog(context.Background(), h.registry.deviceTypeLister(), h.registry.typeFilter)
	if err != nil {
		log.Printf("[MCP] Failed to build catalog for initialize instructions: %v", err)
		sb.WriteString("_(catalog render failed — call get_type_catalog for fresh data)_\n")
		return sb.String()
	}
	sb.WriteString(cat.RenderMarkdown())
	return sb.String()
}

// handleToolsList handles the tools/list method
func (h *Handler) handleToolsList() ToolsListResult {
	return ToolsListResult{
		Tools: h.registry.GetTools(),
	}
}

// handleToolsCall handles the tools/call method
func (h *Handler) handleToolsCall(params map[string]interface{}) (interface{}, error) {
	name, ok := params["name"].(string)
	if !ok {
		return nil, fmt.Errorf("tool name is required")
	}

	args, _ := params["arguments"].(map[string]interface{})
	if args == nil {
		args = make(map[string]interface{})
	}

	log.Printf("[MCP] Calling tool: %s with args: %v", name, args)
	result, err := h.registry.CallTool(name, args)
	if err != nil {
		return nil, err
	}

	// Format result as content array per MCP spec
	return map[string]interface{}{
		"content": []map[string]interface{}{
			{
				"type": "text",
				"text": toJSON(result),
			},
		},
	}, nil
}

// sendSSEMessage sends an SSE message to the client
func (h *Handler) sendSSEMessage(w gin.ResponseWriter, msg SSEMessage) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("[MCP] Error marshaling SSE message: %v", err)
		return
	}

	fmt.Fprintf(w, "data: %s\n\n", data)
}

// Broadcast sends a message to all connected clients
func (h *Handler) Broadcast(msg SSEMessage) {
	h.clients.Range(func(key, value interface{}) bool {
		client := value.(*sseClient)
		h.sendSSEMessage(client.response, msg)
		client.response.Flush()
		return true
	})
}

// Helper functions

func randomString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func toJSON(v interface{}) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v", v)
	}
	return string(data)
}

// SetupRoutes configures MCP routes on the given router group
func (h *Handler) SetupRoutes(router *gin.RouterGroup) {
	mcp := router.Group("/mcp")
	{
		mcp.GET("/sse", h.SSEConnect)
		mcp.POST("/message", h.HandleMessage)
	}
}
