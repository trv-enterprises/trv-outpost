// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// AIUsageHandler backs the "AI API Usage" admin page. It reports
// per-user Dashboard Assistant token consumption (today + a 30-day
// history) against each user's effective daily cap, and lets an admin
// raise/lower or clear a user's budget override.
//
// SCOPE NOTE: only the Dashboard Assistant is metered. The Component AI
// agent ("Create/Edit with AI") and the MCP bridge do NOT record usage
// here — the page labels this so the numbers aren't read as total AI
// spend.
type AIUsageHandler struct {
	usageRepo      *repository.ChatUsageRepository
	userRepo       *repository.UserRepository
	globalInputCap int64
	globalOutputCap int64
}

func NewAIUsageHandler(usageRepo *repository.ChatUsageRepository, userRepo *repository.UserRepository, globalInputCap, globalOutputCap int64) *AIUsageHandler {
	return &AIUsageHandler{
		usageRepo:       usageRepo,
		userRepo:        userRepo,
		globalInputCap:  globalInputCap,
		globalOutputCap: globalOutputCap,
	}
}

const aiUsageHistoryDays = 30

// usageDay is one day's row in a user's history.
type usageDay struct {
	DateUTC      string `json:"date_utc"`
	InputTokens  int64  `json:"input_tokens"`
	OutputTokens int64  `json:"output_tokens"`
}

// userUsage is the per-user block the page renders.
type userUsage struct {
	GUID            string                          `json:"guid"`
	Name            string                          `json:"name"`
	TodayInput      int64                           `json:"today_input"`
	TodayOutput     int64                           `json:"today_output"`
	EffectiveInput  int64                           `json:"effective_input_cap"`
	EffectiveOutput int64                           `json:"effective_output_cap"`
	GlobalInput     int64                           `json:"global_input_cap"`
	GlobalOutput    int64                           `json:"global_output_cap"`
	Override        *models.AssistantBudgetOverride `json:"override,omitempty"`
	History         []usageDay                      `json:"history"`
}

// AIUsageResponse is the shape GET /api/ai/usage returns.
type AIUsageResponse struct {
	GlobalInputCap  int64       `json:"global_input_cap"`
	GlobalOutputCap int64       `json:"global_output_cap"`
	HistoryDays     int         `json:"history_days"`
	// MeteredNote spells out that only the Assistant is counted, so the
	// frontend can surface it verbatim without hardcoding the caveat.
	MeteredNote string      `json:"metered_note"`
	Users       []userUsage `json:"users"`
}

// effectiveCaps applies a user's override (if in force today) over the
// global caps, per axis. Mirrors chat.Budget.effectiveCaps so the page
// shows the same numbers the budget check enforces.
func (h *AIUsageHandler) effectiveCaps(u *models.User, todayUTC string) (inCap, outCap int64) {
	inCap, outCap = h.globalInputCap, h.globalOutputCap
	ov := u.AssistantBudgetOverride
	if ov != nil && ov.AppliesOn(todayUTC) {
		if ov.Input > 0 {
			inCap = ov.Input
		}
		if ov.Output > 0 {
			outCap = ov.Output
		}
	}
	return
}

// GetUsage godoc
// @Summary      AI API usage (Dashboard Assistant)
// @Description  Per-user Assistant token usage: today vs effective cap + a 30-day history. Only the Dashboard Assistant is metered.
// @Tags         ai
// @Produce      json
// @Success      200  {object}  AIUsageResponse
// @Router       /api/ai/usage [get]
func (h *AIUsageHandler) GetUsage(c *gin.Context) {
	ctx := c.Request.Context()
	now := time.Now().UTC()
	todayUTC := now.Format("2006-01-02")
	sinceUTC := now.AddDate(0, 0, -(aiUsageHistoryDays - 1)).Format("2006-01-02")

	// All usage rows in the window, grouped per user.
	rows, err := h.usageRepo.ListSince(ctx, sinceUTC)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to read usage: " + err.Error()})
		return
	}
	historyByUser := make(map[string][]usageDay)
	todayByUser := make(map[string]usageDay)
	for _, r := range rows {
		historyByUser[r.UserGUID] = append(historyByUser[r.UserGUID], usageDay{
			DateUTC: r.DateUTC, InputTokens: r.InputTokens, OutputTokens: r.OutputTokens,
		})
		if r.DateUTC == todayUTC {
			todayByUser[r.UserGUID] = usageDay{InputTokens: r.InputTokens, OutputTokens: r.OutputTokens}
		}
	}

	// List human users (system users don't drive the Assistant). Page
	// size is generous for a single-tenant deployment.
	users, _, err := h.userRepo.List(ctx, 1, 1000)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list users: " + err.Error()})
		return
	}

	out := make([]userUsage, 0, len(users))
	for i := range users {
		u := &users[i]
		if u.IsSystem() {
			continue
		}
		inCap, outCap := h.effectiveCaps(u, todayUTC)
		today := todayByUser[u.GUID]
		uu := userUsage{
			GUID:            u.GUID,
			Name:            u.Name,
			TodayInput:      today.InputTokens,
			TodayOutput:     today.OutputTokens,
			EffectiveInput:  inCap,
			EffectiveOutput: outCap,
			GlobalInput:     h.globalInputCap,
			GlobalOutput:    h.globalOutputCap,
			Override:        u.AssistantBudgetOverride,
			History:         historyByUser[u.GUID],
		}
		if uu.History == nil {
			uu.History = []usageDay{}
		}
		out = append(out, uu)
	}

	c.JSON(http.StatusOK, AIUsageResponse{
		GlobalInputCap:  h.globalInputCap,
		GlobalOutputCap: h.globalOutputCap,
		HistoryDays:     aiUsageHistoryDays,
		MeteredNote:     "Only the Dashboard Assistant is metered here. The Component AI agent (Create/Edit with AI) and MCP are not counted.",
		Users:           out,
	})
}

// SetOverrideRequest is the body for PUT /api/ai/usage/:guid/override.
// Send override=null (omit the object) to CLEAR. input/output of 0 mean
// "no override for that axis" (fall back to the global cap).
type SetOverrideRequest struct {
	Input  int64  `json:"input"`
	Output int64  `json:"output"`
	Scope  string `json:"scope"`  // "today" | "ongoing"
	Clear  bool   `json:"clear"`  // true → remove any override
}

// SetOverride godoc
// @Summary      Set/clear a user's Assistant budget override
// @Description  Admin-only. Raises (or clears) a user's daily Assistant token caps. Scope "today" applies only for the current UTC day; "ongoing" persists.
// @Tags         ai
// @Accept       json
// @Produce      json
// @Param        guid  path  string  true  "User GUID"
// @Success      200  {object}  map[string]interface{}
// @Router       /api/ai/usage/{guid}/override [put]
func (h *AIUsageHandler) SetOverride(c *gin.Context) {
	ctx := c.Request.Context()
	guid := c.Param("guid")
	if guid == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "guid required"})
		return
	}

	var req SetOverrideRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid body: " + err.Error()})
		return
	}

	if req.Clear {
		if err := h.userRepo.SetAssistantBudgetOverride(ctx, guid, nil); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to clear override: " + err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"success": true, "cleared": true})
		return
	}

	if req.Scope != models.BudgetScopeToday && req.Scope != models.BudgetScopeOngoing {
		c.JSON(http.StatusBadRequest, gin.H{"error": "scope must be \"today\" or \"ongoing\""})
		return
	}
	if req.Input <= 0 && req.Output <= 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "set at least one of input/output to a positive value (0 = no override for that axis)"})
		return
	}

	ov := &models.AssistantBudgetOverride{
		Input:  req.Input,
		Output: req.Output,
		Scope:  req.Scope,
		SetBy:  callerGUIDFromGin(c),
	}
	if req.Scope == models.BudgetScopeToday {
		ov.EffectiveDate = time.Now().UTC().Format("2006-01-02")
	}
	if err := h.userRepo.SetAssistantBudgetOverride(ctx, guid, ov); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to set override: " + err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"success": true, "override": ov})
}

// callerGUIDFromGin pulls the authenticated caller's GUID off the gin
// context for audit (set_by). The auth middleware stores the resolved
// *models.User under "user" (middleware.UserContextKey). Best-effort;
// empty when unresolved.
func callerGUIDFromGin(c *gin.Context) string {
	if v, ok := c.Get("user"); ok {
		if u, ok := v.(*models.User); ok && u != nil {
			return u.GUID
		}
	}
	return ""
}
