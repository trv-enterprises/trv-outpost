// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// AlertHandler exposes the persisted-alert collection as a small
// REST surface: list the visible alerts, mark one seen, pin/unpin.
// Live alert push is still via SSE (the /api/events/stream surface);
// this endpoint is for hydrating the bell on app load and for the
// per-row dismiss / pin actions.
type AlertHandler struct {
	alerts *service.AlertService
}

// NewAlertHandler wires the handler to the service.
func NewAlertHandler(alerts *service.AlertService) *AlertHandler {
	return &AlertHandler{alerts: alerts}
}

// ListAlerts returns every currently-visible alert (Seen=false OR
// Pinned=true), most-recent first. Capped at 200 records — well
// past the practical bell-rendering ceiling.
// @Summary List visible alerts
// @Tags Alerts
// @Produce json
// @Success 200 {object} models.AlertListResponse
// @Failure 401 {object} map[string]string
// @Router /alerts [get]
func (h *AlertHandler) ListAlerts(c *gin.Context) {
	resp, err := h.alerts.ListVisible(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// MarkSeen flips an alert's Seen flag to true. Used when the user
// clicks "dismiss" on a bell entry. Idempotent — a 200 either way.
// @Summary Mark an alert seen (dismiss)
// @Tags Alerts
// @Param id path string true "Alert ID"
// @Success 204 "No Content"
// @Failure 401 {object} map[string]string
// @Router /alerts/{id}/seen [post]
func (h *AlertHandler) MarkSeen(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	if err := h.alerts.MarkSeen(c.Request.Context(), c.Param("id"), user.GUID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// Pin marks the alert pinned and unseen. Used when the user wants
// to keep an alert visible so another user can see it.
// @Summary Pin an alert (keep visible)
// @Tags Alerts
// @Param id path string true "Alert ID"
// @Success 204 "No Content"
// @Failure 401 {object} map[string]string
// @Router /alerts/{id}/pin [post]
func (h *AlertHandler) Pin(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	if err := h.alerts.Pin(c.Request.Context(), c.Param("id"), user.GUID); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// Unpin clears the pin. Doesn't touch Seen — if the user wants
// the alert to drop off all bells, they should also mark it seen
// (or use the UI "Dismiss" affordance, which does both).
// @Summary Unpin an alert
// @Tags Alerts
// @Param id path string true "Alert ID"
// @Success 204 "No Content"
// @Failure 401 {object} map[string]string
// @Router /alerts/{id}/pin [delete]
func (h *AlertHandler) Unpin(c *gin.Context) {
	if err := h.alerts.Unpin(c.Request.Context(), c.Param("id")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}
