// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/ai"
)

// AIAvailabilityHandler answers "is the AI agent available in this
// deployment?" — a single boolean derived from whether the agent
// constructor succeeded at boot (i.e. ANTHROPIC_API_KEY was set).
//
// Exposed unauthenticated so the app shell can decide whether to
// render AI menu items before the user has signed in. It leaks no
// secrets, only the binary fact of "AI on/off."
type AIAvailabilityHandler struct {
	agent *ai.Agent
}

// NewAIAvailabilityHandler returns a handler that reports whether
// the passed-in agent is non-nil. Pass the same *ai.Agent that
// AISessionHandler receives — nil means "no API key, no AI."
func NewAIAvailabilityHandler(agent *ai.Agent) *AIAvailabilityHandler {
	return &AIAvailabilityHandler{agent: agent}
}

// GetAvailability godoc
// @Summary      AI availability
// @Description  Returns whether the AI agent is enabled in this deployment. Enabled iff ANTHROPIC_API_KEY was set at server start.
// @Tags         ai
// @Produce      json
// @Success      200  {object}  map[string]bool
// @Router       /api/ai/availability [get]
func (h *AIAvailabilityHandler) GetAvailability(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"enabled": h.agent != nil})
}
