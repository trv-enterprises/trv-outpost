// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package dashboard implements the dashboard-builder agent. The agent
// takes a free-form user request plus a typed context envelope, runs
// an agentic loop against Claude using the MCP server as its tool
// surface, and emits a dashboard.
//
// The envelope is the critical design piece: the harness (CLI today,
// chat UI later) fills in whatever slots it has, and the agent asks
// for any required slots that are missing via the
// request_clarification runtime tool. This keeps the agent oblivious
// to its host — the same code works from CLI, chat, or API.
package dashboard

import (
	"fmt"
	"strconv"
	"strings"
)

// RequestContext is the envelope the harness passes to the agent. Any
// slot may be empty — the agent will ask for required missing values.
type RequestContext struct {
	// Prompt is the user's free-form build request. Required for a
	// build run to make sense; the agent will surface an error if
	// empty.
	Prompt string

	// ConnectionID identifies the connection the built dashboard will
	// read from. Required for this build mode. If empty, the agent
	// will either ask or list available connections for the user to
	// pick from.
	ConnectionID string

	// Namespace is the target namespace for any components and the
	// dashboard the agent creates. Defaults to "default" if empty —
	// this is a reasonable default for most deployments.
	Namespace string

	// DashboardName is an optional explicit name. If empty, the agent
	// will pick a name based on the prompt. The agent must ensure
	// uniqueness within the namespace.
	DashboardName string

	// DimensionsWidth and DimensionsHeight describe the target
	// dashboard canvas in pixels. With the 32px / 12-col grid this
	// maps to a specific row-count × column-count grid. Both must be
	// set or both empty; mixed is an error.
	DimensionsWidth  int
	DimensionsHeight int

	// UserGUID is the acting user for any records the agent creates.
	// Required — the service layer uses this for audit fields.
	UserGUID string
}

// Validate checks the envelope for *internal* consistency (not
// completeness). Completeness is the agent's job to decide — some
// builds can proceed without a target connection if the agent plans
// to create one, for example.
func (c *RequestContext) Validate() error {
	if strings.TrimSpace(c.Prompt) == "" {
		return fmt.Errorf("prompt is required")
	}
	if c.UserGUID == "" {
		return fmt.Errorf("user GUID is required")
	}
	if (c.DimensionsWidth == 0) != (c.DimensionsHeight == 0) {
		return fmt.Errorf("dimensions width and height must both be set or both empty")
	}
	if c.DimensionsWidth < 0 || c.DimensionsHeight < 0 {
		return fmt.Errorf("dimensions cannot be negative")
	}
	return nil
}

// GridRowsCols returns the 12-column × N-row grid footprint for the
// configured dimensions. Returns (0, 0) when dimensions are unset.
// Row height is hard-coded to 32px (Carbon $spacing-08) per the
// project's grid contract.
func (c *RequestContext) GridRowsCols() (rows, cols int) {
	if c.DimensionsHeight == 0 {
		return 0, 0
	}
	return c.DimensionsHeight / 32, 12
}

// ParseDimensions accepts "2560x1440" / "2560X1440" / "2560,1440" and
// returns width, height. Used by the CLI flag parser so dimensions
// can be specified as a single string.
func ParseDimensions(s string) (int, int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, 0, nil
	}
	for _, sep := range []string{"x", "X", ","} {
		if i := strings.Index(s, sep); i > 0 {
			w, errW := strconv.Atoi(strings.TrimSpace(s[:i]))
			h, errH := strconv.Atoi(strings.TrimSpace(s[i+1:]))
			if errW != nil || errH != nil {
				return 0, 0, fmt.Errorf("invalid dimensions %q", s)
			}
			if w <= 0 || h <= 0 {
				return 0, 0, fmt.Errorf("dimensions must be positive: %q", s)
			}
			return w, h, nil
		}
	}
	return 0, 0, fmt.Errorf("dimensions must use WxH format (e.g. 2560x1440), got %q", s)
}
