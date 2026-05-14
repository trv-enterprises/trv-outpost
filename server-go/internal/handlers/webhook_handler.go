// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// WebhookHandler is the inbound surface for external integrations
// that POST alert events to the dashboard. Today it only handles
// the ts-store webhook shape; new integrations get sibling routes
// (e.g. /api/webhooks/prometheus/:connection_id) and share the
// event hub.
//
// Auth: every webhook route is mounted inside /api/*, so the
// existing API-key middleware fires. ts-store rules are configured
// with `Authorization: Bearer trve_<system-user-key>`; the
// middleware resolves that to a system user; we don't do any
// additional auth here.
type WebhookHandler struct {
	connections *service.ConnectionService
	hub         *service.EventHub
	alerts      *service.AlertService
}

// NewWebhookHandler wires the inbound webhook receiver to:
//   - the connection lookup (routing validation + namespace recovery),
//   - the alert service (persistence — so the bell can hydrate on
//     reload even if nobody was logged in when the alert fired),
//   - the event hub (live fan-out to currently-connected clients).
func NewWebhookHandler(connections *service.ConnectionService, hub *service.EventHub, alerts *service.AlertService) *WebhookHandler {
	return &WebhookHandler{connections: connections, hub: hub, alerts: alerts}
}

// tsstoreAlertPayload mirrors ts-store's outbound webhook JSON shape
// (internal/notify/webhook.go::Alert in ts-store). Fields are kept
// loose where ts-store is loose — the dashboard cares about
// store_name, rule_name, condition, and timestamp; `data` is opaque
// for now and rendered raw if a user expands the notification.
//
// ExternalRef arrived in ts-store v0.6.3 — an opaque pass-through
// string the rule author attaches to a rule. The dashboard convention
// is `{"dashboard_id":"<uuid>"}` (JSON-encoded compound key), but the
// field is treated as free-form: we keep the raw string and ALSO try
// to JSON-decode it for the bell-row deep-link case. Anything we
// don't understand is silently kept as-is.
type tsstoreAlertPayload struct {
	RuleName    string                 `json:"rule_name"`
	Condition   string                 `json:"condition"`
	Timestamp   int64                  `json:"timestamp"` // nanoseconds since unix epoch
	Data        map[string]interface{} `json:"data"`
	StoreName   string                 `json:"store_name"`
	ExternalRef string                 `json:"external_ref,omitempty"`
}

// decodeExternalRef opportunistically parses the dashboard
// convention `{"dashboard_id":"<uuid>"}` out of the rule's
// external_ref. Returns the dashboard id when found; empty string
// for anything else (empty input, non-JSON, JSON without a
// dashboard_id field, dashboard_id not a string). Never returns an
// error — a bad external_ref is a soft failure, not a webhook
// failure.
func decodeExternalRef(ref string) string {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return ""
	}
	var parsed struct {
		DashboardID string `json:"dashboard_id"`
	}
	if err := json.Unmarshal([]byte(ref), &parsed); err != nil {
		return ""
	}
	return parsed.DashboardID
}

// HandleTSStoreAlert receives an alert from a ts-store webhook rule
// and fans it out to logged-in clients via the event hub.
//
// Auth: the caller must be a system user (the API-key middleware
// resolves the bearer token). We don't enforce a specific user-ID
// match here — the connection_id in the path is the routing key.
// A misconfigured webhook still gets rejected because the payload's
// `store_name` must match the connection's configured store_name.
//
// Response policy: always return 202 on accept (ts-store fires and
// forgets — it logs non-2xx but does not retry). 4xx only for
// genuinely malformed bodies or routing mismatches.
// @Summary Receive a ts-store webhook alert
// @Description Endpoint configured as a webhook URL on a ts-store alert rule. Fans the alert out to logged-in clients via SSE.
// @Tags Webhooks
// @Accept json
// @Produce json
// @Param connection_id path string true "Dashboard connection ID (type=tsstore) the rule belongs to"
// @Param body body tsstoreAlertPayload true "ts-store Alert payload"
// @Success 202 {object} map[string]string
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /webhooks/tsstore/{connection_id} [post]
func (h *WebhookHandler) HandleTSStoreAlert(c *gin.Context) {
	connectionID := c.Param("connection_id")
	if connectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "connection_id is required"})
		return
	}

	// Defense-in-depth: the route is inside /api/*, so the auth
	// middleware should have already attached a user. Refuse if not.
	caller := middleware.GetUser(c)
	if caller == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}

	conn, err := h.connections.GetConnection(c.Request.Context(), connectionID)
	if err != nil || conn == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "connection not found"})
		return
	}
	if conn.Type != models.ConnectionTypeTSStore {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("connection is type %q, not tsstore", conn.Type)})
		return
	}

	var payload tsstoreAlertPayload
	if err := c.ShouldBindJSON(&payload); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": fmt.Sprintf("invalid payload: %v", err)})
		return
	}

	// Routing validation: the ts-store store_name in the payload
	// must match the dashboard connection's configured store_name.
	// Mismatch usually means the rule was configured against the
	// wrong connection_id — refuse rather than surface an alert
	// against the wrong connection in the UI.
	configuredStore := ""
	if conn.Config.TSStore != nil {
		configuredStore = conn.Config.TSStore.StoreName
	}
	if payload.StoreName != "" && configuredStore != "" && payload.StoreName != configuredStore {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":            "store_name mismatch",
			"payload_store":    payload.StoreName,
			"connection_store": configuredStore,
		})
		return
	}

	// Build the user-facing notification. Title = "<rule> on <conn.name>";
	// subtitle = the condition string ts-store evaluated. Severity is
	// hard-coded "warning" today — ts-store rules don't carry a
	// severity field, so we always surface alerts as warnings.
	title := payload.RuleName
	if conn.Name != "" {
		title = fmt.Sprintf("%s on %s", payload.RuleName, conn.Name)
	}
	firedAt := time.Unix(0, payload.Timestamp)
	if payload.Timestamp <= 0 {
		firedAt = time.Now()
	}

	// Decode the dashboard convention out of external_ref. Soft
	// failure — anything we don't understand is kept on ExternalRef
	// so future producers / future schema can still see the raw
	// value, but DashboardID stays empty and the bell row just
	// doesn't render an "Open dashboard" link.
	dashboardID := decodeExternalRef(payload.ExternalRef)

	// Persist first, fan-out second. Persistence is the
	// "doesn't get lost if nobody is watching" guarantee; the SSE
	// publish is only useful for currently-connected clients. If
	// persistence fails we still want to publish (better to deliver
	// to active users than to drop the alert entirely), but we log
	// the failure prominently — a persistence outage means the
	// bell-on-load story is silently broken.
	recorded, err := h.alerts.Record(c.Request.Context(), &models.Alert{
		FiredAt:      firedAt,
		Severity:     "warning",
		Title:        title,
		Subtitle:     payload.Condition,
		Source:       payload.StoreName,
		RuleName:     payload.RuleName,
		Namespace:    conn.Namespace,
		ConnectionID: connectionID,
		Payload:      payload.Data,
		ExternalRef:  payload.ExternalRef,
		DashboardID:  dashboardID,
	})
	if err != nil {
		log.Printf("webhook: ALERT PERSIST FAILED connection=%s rule=%s err=%v (continuing to publish)",
			connectionID, payload.RuleName, err)
		recorded = nil
	}

	alertID := ""
	if recorded != nil {
		alertID = recorded.ID
	}
	ev := service.Event{
		Kind:      "alert",
		Namespace: conn.Namespace,
		Payload: service.AlertPayload{
			ID:          alertID,
			Severity:    "warning",
			Title:       title,
			Subtitle:    payload.Condition,
			Source:      payload.StoreName,
			RuleName:    payload.RuleName,
			FiredAt:     firedAt,
			DashboardID: dashboardID,
		},
	}
	h.hub.Publish(ev)

	log.Printf("webhook: ts-store alert connection=%s rule=%s store=%s alert_id=%s subscribers=%d",
		connectionID, payload.RuleName, payload.StoreName, alertID, h.hub.SubscriberCount())

	c.JSON(http.StatusAccepted, gin.H{"status": "accepted", "alert_id": alertID})
}
