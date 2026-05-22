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

// TSStoreAlertRulesHandler exposes the dashboard's aggregated view
// over every ts-store alert rule in the deployment. Distinct from
// AlertHandler (which manages the persisted bell-panel alert
// records); this one talks live to the tsstore connections.
type TSStoreAlertRulesHandler struct {
	rules *service.TSStoreAlertRulesService
}

// NewTSStoreAlertRulesHandler wires the handler to its service.
func NewTSStoreAlertRulesHandler(rules *service.TSStoreAlertRulesService) *TSStoreAlertRulesHandler {
	return &TSStoreAlertRulesHandler{rules: rules}
}

// ProbeAuth issues a cheap authenticated probe against the chosen
// tsstore connection so the rule-create wizard can disable the
// submit button when the connection's stored API key won't pass
// ts-store's auth middleware. Same target as the aggregator
// (/api/stores/<store>/alerts); a 200 here is a strong signal that
// the subsequent rule-create POST will succeed too.
// @Summary Probe a tsstore connection's auth before submitting a new rule
// @Tags TSStoreAlerts
// @Produce json
// @Param connection_id query string true "Connection ID"
// @Success 200 {object} service.ProbeConnectionResult
// @Failure 400 {object} map[string]string
// @Router /tsstore-alerts/probe [get]
func (h *TSStoreAlertRulesHandler) ProbeAuth(c *gin.Context) {
	connectionID := c.Query("connection_id")
	if connectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection_id query param is required"})
		return
	}
	c.JSON(http.StatusOK, h.rules.ProbeConnectionAuth(c.Request.Context(), connectionID))
}

// Create accepts a rule-wizard payload (type=webhook|mqtt) and
// registers the rule on the underlying tsstore. For webhook, mints a
// secret + receiver URL via the dashboard's own public webhook path;
// for mqtt, harvests broker creds from the chosen MQTT connection.
// @Summary Create an alert rule on a tsstore connection
// @Tags TSStoreAlerts
// @Accept json
// @Produce json
// @Param body body service.CreateAlertRequest true "Rule"
// @Success 201 {object} service.CreateAlertResponse
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /tsstore-alerts/rules [post]
func (h *TSStoreAlertRulesHandler) Create(c *gin.Context) {
	var req service.CreateAlertRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user := middleware.GetUser(c)
	callerGUID := ""
	if user != nil {
		callerGUID = user.GUID
	}
	resp, err := h.rules.CreateAlert(c.Request.Context(), &req, callerGUID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, resp)
}

// ListAll walks every tsstore connection, fetches the union of
// every alert's rule list, annotates with connection + decoded
// dashboard_id, and returns one flat list. Partial failures land
// in the response's `errors` array; the rest of the payload still
// renders so a single unreachable host doesn't blank the page.
// @Summary Aggregated list of every ts-store alert rule across every tsstore connection
// @Tags TSStoreAlerts
// @Produce json
// @Success 200 {object} service.TSStoreAggregatedRulesResponse
// @Failure 500 {object} map[string]string
// @Router /tsstore-alerts/rules [get]
func (h *TSStoreAlertRulesHandler) ListAll(c *gin.Context) {
	resp, err := h.rules.ListAll(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// GetAlertDetail proxies a GET of the full alert record from the
// owning tsstore. Used by the read-only rule-details page.
// @Summary Get the full detail of a single ts-store alert on a tsstore connection
// @Tags TSStoreAlerts
// @Produce json
// @Param connection_id query string true "TSStore connection ID"
// @Param alert_id path string true "Alert ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /tsstore-alerts/rules/{alert_id} [get]
func (h *TSStoreAlertRulesHandler) GetAlertDetail(c *gin.Context) {
	connectionID := c.Query("connection_id")
	if connectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection_id query param is required"})
		return
	}
	body, err := h.rules.GetAlertDetail(c.Request.Context(), connectionID, c.Param("alert_id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Data(http.StatusOK, "application/json", body)
}

// DeleteAlert removes an entire alert resource on the tsstore that
// owns it. ts-store has no per-rule delete — rules live as a list
// on an alert, so the smallest deletable unit is the whole alert.
// The UI should call this out when the deleted alert had more than
// one rule.
// @Summary Delete a ts-store alert (and all its rules) on a tsstore connection
// @Tags TSStoreAlerts
// @Param connection_id query string true "TSStore connection ID"
// @Param alert_id path string true "Alert ID"
// @Success 204 "No Content"
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /tsstore-alerts/rules/{alert_id} [delete]
func (h *TSStoreAlertRulesHandler) DeleteAlert(c *gin.Context) {
	connectionID := c.Query("connection_id")
	if connectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection_id query param is required"})
		return
	}
	if err := h.rules.DeleteAlert(c.Request.Context(), connectionID, c.Param("alert_id")); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}
