// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/connection"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// Per-call timeout bounds for the EdgeLake Terminal. The lower bound
// stops a typo'd zero from creating an effectively-infinite request;
// the upper bound stops a single page from wedging server resources
// on a misbehaving node. 5 minutes is roomy enough for `test network`
// against a dozen-peer cluster.
const (
	edgeLakeTerminalMinTimeout = 1 * time.Second
	edgeLakeTerminalMaxTimeout = 5 * time.Minute
)

// EdgeLakeTerminalHandler implements the EdgeLake Terminal extension —
// a thin pass-through that sends raw AnyLog/EdgeLake commands to a
// chosen EdgeLake connection and returns the response body verbatim.
//
// The terminal page renders responses as-is (json, text, columnar
// command output); response shaping happens client-side. The handler
// only enforces: the connection exists, it's the EdgeLake adapter type,
// and the command is non-empty.
type EdgeLakeTerminalHandler struct {
	connections *service.ConnectionService
}

// NewEdgeLakeTerminalHandler wires the handler.
func NewEdgeLakeTerminalHandler(connections *service.ConnectionService) *EdgeLakeTerminalHandler {
	return &EdgeLakeTerminalHandler{connections: connections}
}

// EdgeLakeTerminalExecuteRequest is the request body for /execute.
//
// Destination maps to the AnyLog REST `destination` header. Empty
// string runs the command on the connected node; "network" fans out
// across the cluster; "<ip>:<port>" (or a comma-separated list)
// redirects to specific peer node(s).
//
// Method selects the HTTP verb:
//   - ""     → auto-detect from the command's leading verb (GET for
//              reads, POST for run/set/create/drop/… and SQL writes)
//   - "GET"  → force GET
//   - "POST" → force POST (use when auto-detect misses a write verb)
//
// TimeoutSeconds is the per-call timeout for the whole roundtrip.
// Zero means "use the connection's configured timeout" (default 20s).
// Clamped server-side to [1, 300] so a typo can't create an
// effectively-infinite request and a single page can't wedge the
// server on a misbehaving node.
type EdgeLakeTerminalExecuteRequest struct {
	ConnectionID   string `json:"connection_id" binding:"required"`
	Command        string `json:"command" binding:"required"`
	Destination    string `json:"destination"`
	Method         string `json:"method"`
	TimeoutSeconds int    `json:"timeout_seconds"`
}

// EdgeLakeTerminalExecuteResponse is the response body. Response is the
// raw EdgeLake response as a string — the page renders it verbatim so
// the user sees exactly what EdgeLake returned. Destination and Method
// are echoed back so the transcript can label the row (the client may
// have sent method="" for auto-detect and wants to know what the
// server actually used).
type EdgeLakeTerminalExecuteResponse struct {
	Command     string `json:"command"`
	Response    string `json:"response"`
	DurationMs  int64  `json:"duration_ms"`
	Destination string `json:"destination"`
	Method      string `json:"method"`
}

// Execute godoc
// @Summary Send a raw AnyLog/EdgeLake command to an EdgeLake connection
// @Description Optional extension endpoint — only mounted when the admin setting `extensions.edgelake_terminal.enabled` is true. Returns 403 when the extension is disabled. The command is forwarded verbatim to the EdgeLake node via the `command` HTTP header (AnyLog REST contract); the response body is returned as a UTF-8 string for the terminal page to render. Per-call `timeout_seconds` (clamped to [1, 300]) overrides the connection's default; on deadline expiry the handler returns 504 with a clarified message.
// @Tags EdgeLakeTerminal
// @Accept json
// @Produce json
// @Param body body EdgeLakeTerminalExecuteRequest true "Command payload"
// @Success 200 {object} EdgeLakeTerminalExecuteResponse
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string "Extension disabled"
// @Failure 404 {object} map[string]string "Connection not found"
// @Failure 502 {object} map[string]string "EdgeLake node returned an error"
// @Failure 504 {object} map[string]string "Per-call timeout exceeded"
// @Router /edgelake-terminal/execute [post]
func (h *EdgeLakeTerminalHandler) Execute(c *gin.Context) {
	var req EdgeLakeTerminalExecuteRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	conn, err := h.connections.GetConnection(c.Request.Context(), req.ConnectionID)
	if err != nil || conn == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "connection not found"})
		return
	}

	// Accept either the legacy Type or new TypeID shape.
	if conn.Type != models.ConnectionTypeEdgeLake && conn.GetEffectiveTypeID() != "api.edgelake" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection is not an EdgeLake connection"})
		return
	}

	adapter, err := h.connections.CreateAdapter(c.Request.Context(), conn)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to instantiate adapter: " + err.Error()})
		return
	}
	defer adapter.Close()

	elAdapter, ok := adapter.(*connection.EdgeLakeAdapter)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "adapter is not an EdgeLake adapter"})
		return
	}

	// Clamp timeout. Zero = use the adapter default (no override).
	var timeout time.Duration
	if req.TimeoutSeconds > 0 {
		timeout = time.Duration(req.TimeoutSeconds) * time.Second
		if timeout < edgeLakeTerminalMinTimeout {
			timeout = edgeLakeTerminalMinTimeout
		}
		if timeout > edgeLakeTerminalMaxTimeout {
			timeout = edgeLakeTerminalMaxTimeout
		}
	}

	// Validate method up front so a bad value 400s instead of getting
	// forwarded through. Empty = auto-detect (adapter does the work).
	methodUpper := strings.ToUpper(strings.TrimSpace(req.Method))
	if methodUpper != "" && methodUpper != "GET" && methodUpper != "POST" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "method must be empty, GET, or POST"})
		return
	}

	started := time.Now()
	body, resolvedMethod, err := elAdapter.ExecuteCommand(c.Request.Context(), req.Command, req.Destination, methodUpper, timeout)
	duration := time.Since(started)

	if err != nil {
		// Distinguish deadline-exceeded from other upstream failures
		// so the transcript can render a clearer message. context.Canceled
		// usually means the browser hit the Cancel button.
		status := http.StatusBadGateway
		message := err.Error()
		switch {
		case errors.Is(err, context.DeadlineExceeded):
			status = http.StatusGatewayTimeout
			limit := timeout
			if limit == 0 {
				// Adapter default applied; surface it as best we can.
				limit = elAdapter.HTTPTimeout()
			}
			message = fmt.Sprintf("EdgeLake node didn't respond within %s. Try increasing the timeout, narrowing the destination, or checking the node's health.", limit)
		case errors.Is(err, context.Canceled):
			status = 499 // nginx-style "client closed request"
			message = "Request cancelled by user."
		}
		c.JSON(status, gin.H{
			"error":       message,
			"duration_ms": duration.Milliseconds(),
		})
		return
	}

	c.JSON(http.StatusOK, EdgeLakeTerminalExecuteResponse{
		Command:     req.Command,
		Response:    string(body),
		DurationMs:  duration.Milliseconds(),
		Destination: req.Destination,
		Method:      resolvedMethod,
	})
}
