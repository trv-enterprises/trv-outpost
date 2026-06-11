// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/ai"
	"github.com/trv-enterprises/trve-dashboard/internal/ai/chat"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// AIAvailabilityHandler answers "which AI surfaces are available in
// this deployment?" — currently two flags:
//
//   - `component_agent_enabled`: derived from whether the Component
//     AI agent constructor succeeded at boot — which now requires BOTH
//     the unified `ai.enabled` admin setting AND an Anthropic key.
//   - `chat_agent_enabled`: same `ai.enabled` + key gate AND a
//     successful Dashboard Assistant construction. Restart is required
//     for changes to take effect.
//
// Both surfaces share the single `ai.enabled` master switch by design,
// so in practice these two flags move together (modulo a constructor
// error on one surface).
//
// Exposed unauthenticated so the app shell can decide whether to
// render AI menu items / the assistant header icon before the user
// has signed in. It leaks no secrets, only the binary fact of
// "available / not available" per surface.
//
// Legacy callers consume the `enabled` field, which we keep as an
// alias for `component_agent_enabled` so existing clients don't
// break.
type AIAvailabilityHandler struct {
	agent           *ai.Agent
	chatAgentReady  bool
	settingsService *service.SettingsService
}

// NewAIAvailabilityHandler returns a handler that reports the
// availability of both AI surfaces. `agent` is the Component AI
// agent (nil means "no Component AI"). `chatAgentReady` reflects
// whether the Dashboard Assistant constructor succeeded at boot
// (which already accounts for both the env key and the admin
// setting — so it's a single bool here). `settingsService` is
// retained for future hot-toggle support; for v1 the bool we were
// constructed with is authoritative.
func NewAIAvailabilityHandler(agent *ai.Agent, chatAgentReady bool, settingsService *service.SettingsService) *AIAvailabilityHandler {
	return &AIAvailabilityHandler{
		agent:           agent,
		chatAgentReady:  chatAgentReady,
		settingsService: settingsService,
	}
}

// AIAvailabilityResponse is the shape returned by GetAvailability.
// `Enabled` is the legacy field, retained as an alias for
// `ComponentAgentEnabled` so SPA bootstraps written before the
// chat agent landed don't break.
// @Description Per-surface AI availability flags for the SPA bootstrap.
type AIAvailabilityResponse struct {
	Enabled               bool `json:"enabled"`
	ComponentAgentEnabled bool `json:"component_agent_enabled"`
	ChatAgentEnabled      bool `json:"chat_agent_enabled"`
	// AssistantModel is the Dashboard Assistant's resolved model for display,
	// with the "claude-" prefix stripped (e.g. "opus-4-8", "sonnet-4-6", or a
	// pinned ID like "opus-4-20250514"). Lets the UI show the real model
	// instead of a hardcoded guess. Empty when AI is off / unreadable.
	AssistantModel string `json:"assistant_model,omitempty"`
}

// GetAvailability godoc
// @Summary      AI availability
// @Description  Returns per-surface availability flags. `enabled` is a legacy alias for `component_agent_enabled`. Both AI surfaces require the unified `ai.enabled` admin setting AND an Anthropic key at server start; they share that single gate.
// @Tags         ai
// @Produce      json
// @Success      200  {object}  AIAvailabilityResponse
// @Router       /ai/availability [get]
func (h *AIAvailabilityHandler) GetAvailability(c *gin.Context) {
	componentAgentEnabled := h.agent != nil

	// Resolve the Dashboard Assistant's model for display. Read the live
	// admin setting, resolve aliases (sonnet/opus → concrete ID) the same way
	// the agent does at boot, and strip the "claude-" prefix so the UI shows
	// e.g. "opus-4-8" rather than "claude-opus-4-8". Only meaningful when the
	// chat agent is up; empty otherwise.
	var assistantModel string
	if h.chatAgentReady && h.settingsService != nil {
		adminValue := ""
		if s, err := h.settingsService.GetSetting(c.Request.Context(), "assistant.model"); err == nil && s != nil {
			if v, ok := s.Value.(string); ok {
				adminValue = v
			}
		}
		assistantModel = strings.TrimPrefix(chat.ResolveModelID(adminValue), "claude-")
	}

	c.JSON(http.StatusOK, AIAvailabilityResponse{
		Enabled:               componentAgentEnabled,
		ComponentAgentEnabled: componentAgentEnabled,
		ChatAgentEnabled:      h.chatAgentReady,
		AssistantModel:        assistantModel,
	})
}
