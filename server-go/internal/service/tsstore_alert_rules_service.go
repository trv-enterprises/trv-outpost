// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/connection"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
)

// fanoutTimeoutSeconds caps each individual fan-out request so one
// slow tsstore can't blank the whole list. Lower than the per-conn
// config timeout would normally permit because the aggregator does
// N round-trips concurrently.
const fanoutTimeoutSeconds = 5

// TSStoreAlertRulesService is the dashboard-side view over the alert rules
// that live inside every tsstore connection. ts-store is the
// durable source of truth — this service walks every tsstore
// connection on the dashboard and unions their per-store rule lists
// into a single annotated stream, so the Design → Extensions →
// Alerts page can show "every rule, everywhere" without forcing the
// user to know which connections have alerts.
type TSStoreAlertRulesService struct {
	connections    *ConnectionService
	webhookSecrets *repository.WebhookSecretRepository
}

// NewTSStoreAlertRulesService wires the service. HTTP clients are
// built per-connection by clientFor() so each call can honor the
// owning connection's TLS posture (insecure_skip_verify) without
// every connection sharing one client's settings.
//
// webhookSecrets is the repo we use to mint and store the per-
// connection URL secret when creating a new alert rule. The receiver
// validates that secret on every inbound webhook, so the secret IS
// the auth for the public receiver path.
func NewTSStoreAlertRulesService(connections *ConnectionService, webhookSecrets *repository.WebhookSecretRepository) *TSStoreAlertRulesService {
	return &TSStoreAlertRulesService{
		connections:    connections,
		webhookSecrets: webhookSecrets,
	}
}

// clientFor builds an http.Client appropriate for one tsstore
// connection: same TLS-skip two-gate model as the api adapter, plus
// the fan-out timeout cap so one slow / hung host can't stall the
// whole list endpoint.
func clientFor(cfg *models.TSStoreConfig) *http.Client {
	c := connection.BuildAPIHTTPClient(fanoutTimeoutSeconds, cfg.InsecureSkipVerify)
	return c
}

// TSStoreConnectionRef is a {connection_id, connection_name, namespace}
// tuple identifying one dashboard connection that points at a given
// ts-store backend. A single ts-store store may be reachable via several
// dashboard connections (e.g. a WS connection and an API connection on
// the same host) — the aggregator collapses them into a single rule row
// and lists every connection that resolves to that backend here.
type TSStoreConnectionRef struct {
	ConnectionID   string `json:"connection_id"`
	ConnectionName string `json:"connection_name"`
	Namespace      string `json:"namespace,omitempty"`
}

// TSStoreAggregatedRule is the wire shape returned by ListAll. One row per
// rule on the underlying ts-store backend (not per dashboard connection).
type TSStoreAggregatedRule struct {
	// Identity within ts-store. ts-store owns IDs at the alert level
	// (one alert = one transport target = one rule list); rule names
	// are unique within a single alert.
	//
	// ConnectionID / ConnectionName identify the *primary* dashboard
	// connection that points at this backend — preserved for delete
	// (the DELETE handler needs a connection record to dial through)
	// and back-compat. The full set of dashboard connections that
	// resolve to the same backend is in Connections; the count is
	// duplicated to ConnectionCount for table sort/filter ergonomics.
	ConnectionID    string                 `json:"connection_id"`
	ConnectionName  string                 `json:"connection_name"`
	Connections     []TSStoreConnectionRef `json:"connections,omitempty"`
	ConnectionCount int                    `json:"connection_count"`
	Namespace       string                 `json:"namespace,omitempty"`
	StoreName       string                 `json:"store_name"`
	AlertID         string                 `json:"alert_id"`
	AlertType       string                 `json:"alert_type"` // webhook | ws | mqtt
	AlertTarget     string                 `json:"alert_target,omitempty"`

	// Rule-level fields straight from ts-store.
	RuleName    string `json:"rule_name"`
	Condition   string `json:"condition"`
	Cooldown    string `json:"cooldown,omitempty"`
	ExternalRef string `json:"external_ref,omitempty"`

	// DashboardID is decoded opportunistically from ExternalRef when
	// it parses as `{"dashboard_id":"<uuid>"}`. Empty otherwise —
	// rules created by non-dashboard tooling carry whatever the
	// producer chose to put in external_ref.
	DashboardID string `json:"dashboard_id,omitempty"`

	// Operational status. ts-store reports state + alerts_fired at
	// the alert level (not per rule); we mirror onto every rule row
	// for table readability. Last-fired-per-rule is not yet exposed
	// by ts-store; left empty until it lands.
	State       string `json:"state,omitempty"`
	AlertsFired int64  `json:"alerts_fired,omitempty"`
}

// TSStoreFetchError records a per-connection failure so the UI can surface
// partial results — one slow / unreachable tsstore must not blank
// the whole list.
type TSStoreFetchError struct {
	ConnectionID   string `json:"connection_id"`
	ConnectionName string `json:"connection_name"`
	Error          string `json:"error"`
}

// TSStoreAggregatedRulesResponse is the wire shape for the list endpoint.
type TSStoreAggregatedRulesResponse struct {
	Rules  []TSStoreAggregatedRule `json:"rules"`
	Errors []TSStoreFetchError     `json:"errors,omitempty"`
}

// ListAll walks every tsstore connection on the dashboard, groups them
// by underlying ts-store backend (base URL + store name) so each backend
// is queried once, fans out GET /api/stores/<store>/alerts in parallel,
// and returns one rule row per backend rule (not per connection). Each
// row carries the full list of dashboard connections that point at that
// backend in Connections; ConnectionID/ConnectionName is the primary.
// Per-backend failures land in Errors against the primary connection.
func (s *TSStoreAlertRulesService) ListAll(ctx context.Context) (*TSStoreAggregatedRulesResponse, error) {
	// Pull every tsstore connection. The pagination limit is high
	// because we want all of them in one call; the realistic upper
	// bound on tsstore connections per deployment is in the dozens.
	conns, _, err := s.connections.ListConnectionsByType(ctx, models.ConnectionTypeTSStore, 1000, 0)
	if err != nil {
		return nil, fmt.Errorf("list tsstore connections: %w", err)
	}

	// Group connections by ts-store backend identity. Two dashboard
	// connections that resolve to the same (base URL, store name) share
	// the same alert resources — they're different views of the same
	// data, and listing each separately produces phantom duplicates.
	type backendKey struct {
		BaseURL   string
		StoreName string
	}
	groups := map[backendKey][]*models.Connection{}
	groupOrder := []backendKey{}
	for _, conn := range conns {
		if conn.Config.TSStore == nil {
			continue
		}
		k := backendKey{BaseURL: conn.Config.TSStore.BaseURL(), StoreName: conn.Config.TSStore.StoreName}
		if _, seen := groups[k]; !seen {
			groupOrder = append(groupOrder, k)
		}
		groups[k] = append(groups[k], conn)
	}

	resp := &TSStoreAggregatedRulesResponse{
		Rules:  []TSStoreAggregatedRule{},
		Errors: []TSStoreFetchError{},
	}

	var mu sync.Mutex
	var wg sync.WaitGroup

	for _, k := range groupOrder {
		members := groups[k]
		wg.Add(1)
		go func() {
			defer wg.Done()
			primary := members[0]
			refs := make([]TSStoreConnectionRef, 0, len(members))
			for _, m := range members {
				refs = append(refs, TSStoreConnectionRef{
					ConnectionID:   m.ID,
					ConnectionName: m.Name,
					Namespace:      m.Namespace,
				})
			}

			rules, ferr := s.fetchRulesForConnection(ctx, primary)
			mu.Lock()
			defer mu.Unlock()
			if ferr != nil {
				// Annotate the error with the sibling connection names
				// so the user understands which connections were
				// affected by the failure of the shared backend.
				errMsg := ferr.Error()
				if len(members) > 1 {
					siblings := make([]string, 0, len(members)-1)
					for _, m := range members[1:] {
						siblings = append(siblings, m.Name)
					}
					errMsg = fmt.Sprintf("%s (also affects: %s)", errMsg, strings.Join(siblings, ", "))
				}
				resp.Errors = append(resp.Errors, TSStoreFetchError{
					ConnectionID:   primary.ID,
					ConnectionName: primary.Name,
					Error:          errMsg,
				})
				return
			}
			for i := range rules {
				rules[i].Connections = refs
				rules[i].ConnectionCount = len(refs)
			}
			resp.Rules = append(resp.Rules, rules...)
		}()
	}
	wg.Wait()

	return resp, nil
}

// tsStoreAlertStatus mirrors ts-store's GET /api/stores/:store/alerts
// response shape — only the fields the dashboard cares about.
type tsStoreAlertStatus struct {
	ID            string `json:"id"`
	Type          string `json:"type"`
	Target        string `json:"target"`
	AlertsFired   int64  `json:"alerts_fired"`
	State         string `json:"state"`
}

// tsStoreAlertDetail mirrors GET /api/stores/:store/alerts/:id under
// ts-store's v2 API: one rule per alert, with the rule fields living
// inside the transport block (webhook/ws/mqtt). The top-level
// `rule_name` is also exposed as a Status convenience but we read
// condition/cooldown/external_ref from the transport block since
// that's where they're authoritative.
type tsStoreAlertDetail struct {
	RuleName string             `json:"rule_name"`
	Webhook  *tsStoreRuleConfig `json:"webhook,omitempty"`
	WS       *tsStoreRuleConfig `json:"ws,omitempty"`
	MQTT     *tsStoreRuleConfig `json:"mqtt,omitempty"`
}

type tsStoreRuleConfig struct {
	Name        string `json:"name"`
	Condition   string `json:"condition"`
	Cooldown    string `json:"cooldown,omitempty"`
	ExternalRef string `json:"external_ref,omitempty"`
}

// fetchRulesForConnection lists alerts on one tsstore connection,
// then loads each alert's detail to extract its rules. Two round-
// trips per connection (list + N details). Acceptable for a Design-
// mode page; can be cached if it becomes a hot path.
func (s *TSStoreAlertRulesService) fetchRulesForConnection(ctx context.Context, conn *models.Connection) ([]TSStoreAggregatedRule, error) {
	cfg := conn.Config.TSStore
	client := clientFor(cfg)
	listURL := fmt.Sprintf("%s/api/stores/%s/alerts", cfg.BaseURL(), cfg.StoreName)

	var listResp struct {
		Alerts []tsStoreAlertStatus `json:"alerts"`
	}
	if err := getJSON(ctx, client, listURL, cfg.APIKey, &listResp); err != nil {
		return nil, err
	}

	out := []TSStoreAggregatedRule{}
	for _, st := range listResp.Alerts {
		detailURL := fmt.Sprintf("%s/api/stores/%s/alerts/%s", cfg.BaseURL(), cfg.StoreName, st.ID)
		var detail tsStoreAlertDetail
		if err := getJSON(ctx, client, detailURL, cfg.APIKey, &detail); err != nil {
			// Skip just this alert; the rest of the connection's
			// rules still surface. (The error doesn't propagate to
			// the connection-level TSStoreFetchError because we already
			// have some data — the parent list succeeded.)
			continue
		}

		var rule *tsStoreRuleConfig
		switch {
		case detail.Webhook != nil:
			rule = detail.Webhook
		case detail.WS != nil:
			rule = detail.WS
		case detail.MQTT != nil:
			rule = detail.MQTT
		}
		if rule == nil {
			// Alert resource with no transport block — shouldn't
			// happen, but skip rather than emit an empty row.
			continue
		}

		name := rule.Name
		if name == "" {
			name = detail.RuleName
		}
		out = append(out, TSStoreAggregatedRule{
			ConnectionID:   conn.ID,
			ConnectionName: conn.Name,
			Namespace:      conn.Namespace,
			StoreName:      cfg.StoreName,
			AlertID:        st.ID,
			AlertType:      st.Type,
			AlertTarget:    st.Target,
			RuleName:       name,
			Condition:      rule.Condition,
			Cooldown:       rule.Cooldown,
			ExternalRef:    rule.ExternalRef,
			DashboardID:    decodeDashboardID(rule.ExternalRef),
			State:          st.State,
			AlertsFired:    st.AlertsFired,
		})
	}
	return out, nil
}

// GetAlertDetail fetches the full alert record from the owning
// tsstore (status + transport block with rule fields). The
// response is passed through verbatim — ts-store already redacts
// secret-bearing headers and the MQTT password — so the dashboard
// doesn't have to mirror the full schema. Used by the read-only
// rule-details page.
func (s *TSStoreAlertRulesService) GetAlertDetail(ctx context.Context, connectionID, alertID string) (json.RawMessage, error) {
	conn, err := s.connections.GetConnection(ctx, connectionID)
	if err != nil {
		return nil, fmt.Errorf("get connection: %w", err)
	}
	if conn.Type != models.ConnectionTypeTSStore || conn.Config.TSStore == nil {
		return nil, fmt.Errorf("connection %s is not a tsstore connection", connectionID)
	}
	cfg := conn.Config.TSStore
	client := clientFor(cfg)
	url := fmt.Sprintf("%s/api/stores/%s/alerts/%s", cfg.BaseURL(), cfg.StoreName, alertID)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	if cfg.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.APIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("ts-store returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	return body, nil
}

// DeleteAlert deletes an entire alert resource on the underlying
// tsstore. ts-store doesn't have per-rule delete (rules live as a
// list on a single alert), so the smallest unit the dashboard can
// remove is one whole alert. The UI should call this out when the
// user picks "delete a rule" on a multi-rule alert.
func (s *TSStoreAlertRulesService) DeleteAlert(ctx context.Context, connectionID, alertID string) error {
	conn, err := s.connections.GetConnection(ctx, connectionID)
	if err != nil {
		return fmt.Errorf("get connection: %w", err)
	}
	if conn.Type != models.ConnectionTypeTSStore || conn.Config.TSStore == nil {
		return fmt.Errorf("connection %s is not a tsstore connection", connectionID)
	}
	cfg := conn.Config.TSStore
	client := clientFor(cfg)
	url := fmt.Sprintf("%s/api/stores/%s/alerts/%s", cfg.BaseURL(), cfg.StoreName, alertID)

	req, err := http.NewRequestWithContext(ctx, http.MethodDelete, url, nil)
	if err != nil {
		return err
	}
	if cfg.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.APIKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ts-store DELETE returned %d", resp.StatusCode)
	}
	return nil
}

// getJSON is a small typed HTTP GET helper that handles ts-store's
// X-API-Key auth convention and returns a clean error on non-2xx.
// Takes the client as a parameter so each tsstore connection's TLS
// posture is honored.
func getJSON(ctx context.Context, client *http.Client, url, apiKey string, out interface{}) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	if apiKey != "" {
		req.Header.Set("X-API-Key", apiKey)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("ts-store returned %d for %s", resp.StatusCode, url)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// decodeDashboardID returns the dashboard_id when external_ref is
// `{"dashboard_id":"<uuid>"}`. Soft-fail: any malformed input
// returns an empty string so non-dashboard producers aren't punished.
func decodeDashboardID(externalRef string) string {
	if externalRef == "" {
		return ""
	}
	var parsed struct {
		DashboardID string `json:"dashboard_id"`
	}
	if err := json.Unmarshal([]byte(externalRef), &parsed); err != nil {
		return ""
	}
	return parsed.DashboardID
}

// ProbeConnectionResult is the wire shape for ProbeConnectionAuth.
// HTTPStatus is 0 when the request never reached ts-store
// (DNS/timeout/refused). Otherwise it's the status code ts-store
// returned. OK collapses the common case into a single boolean the
// UI can flip the submit gate on.
type ProbeConnectionResult struct {
	OK         bool   `json:"ok"`
	HTTPStatus int    `json:"http_status,omitempty"`
	Error      string `json:"error,omitempty"`
}

// ProbeConnectionAuth fires a cheap authenticated request against
// the underlying ts-store so the rule wizard can fail fast when a
// connection's stored API key won't authenticate. Uses the same
// /api/stores/:store/alerts endpoint the aggregator uses (one
// round-trip, no per-alert detail), so a success here is a strong
// signal that the CreateAlert POST will also be authorised.
// Never returns an error itself — every failure surfaces as
// ProbeConnectionResult fields so the handler can return 200 with
// a structured result.
func (s *TSStoreAlertRulesService) ProbeConnectionAuth(ctx context.Context, connectionID string) ProbeConnectionResult {
	conn, err := s.connections.GetConnection(ctx, connectionID)
	if err != nil {
		return ProbeConnectionResult{OK: false, Error: fmt.Sprintf("connection lookup: %v", err)}
	}
	if conn.Type != models.ConnectionTypeTSStore || conn.Config.TSStore == nil {
		return ProbeConnectionResult{OK: false, Error: "connection is not a tsstore connection"}
	}
	cfg := conn.Config.TSStore
	url := fmt.Sprintf("%s/api/stores/%s/alerts", cfg.BaseURL(), cfg.StoreName)

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return ProbeConnectionResult{OK: false, Error: err.Error()}
	}
	if cfg.APIKey != "" {
		req.Header.Set("X-API-Key", cfg.APIKey)
	}
	client := clientFor(cfg)
	resp, err := client.Do(req)
	if err != nil {
		return ProbeConnectionResult{OK: false, Error: err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return ProbeConnectionResult{OK: true, HTTPStatus: resp.StatusCode}
	}
	return ProbeConnectionResult{OK: false, HTTPStatus: resp.StatusCode}
}

// CreateAlertRequest is the inbound wire shape for the rule wizard.
// ts-store has three sink transports (webhook/ws/mqtt); the dashboard
// exposes webhook and mqtt. WebSocket sink is intentionally omitted:
// it has no topic mechanism so ts-store alerts would mix with any
// telemetry on the same WS, and the dashboard already has cleaner
// paths (webhook for bell, MQTT for fan-out to brokers). Revisit if
// a concrete use case appears.
//
// Two connection IDs in play, decoupling rule ownership from sink:
//   - ConnectionID — REQUIRED. Always a TSStore connection. Defines
//     where the rule is registered (api endpoint + store).
//   - SinkConnectionID — REQUIRED for type=mqtt. Always an MQTT
//     connection. Provides broker creds; the topic lives on the rule
//     (per ts-store's API), not on the connection.
type CreateAlertRequest struct {
	Type          string `json:"type" binding:"required"`          // "webhook" | "mqtt"
	ConnectionID  string `json:"connection_id" binding:"required"` // TSStore connection (rule owner)
	RuleName      string `json:"rule_name" binding:"required"`
	Condition     string `json:"condition" binding:"required"`
	Cooldown      string `json:"cooldown,omitempty"`     // "5m" etc., ts-store duration
	DashboardID   string `json:"dashboard_id,omitempty"` // optional bell deep-link target
	PollInterval  string `json:"poll_interval,omitempty"`
	RestartPolicy string `json:"restart_policy,omitempty"` // "now" (default) or "resume"
	MaxReplay     string `json:"max_replay,omitempty"`     // e.g. "1h"; only valid when restart_policy=="resume"

	// Webhook-sink fields (type=webhook):
	// Timeout applies only to the webhook block. Optional override is
	// for callers who want to deliver to an external URL instead of
	// the dashboard's bell receiver (no secret minted in that case).
	Timeout            string            `json:"timeout,omitempty"`
	WebhookURLOverride string            `json:"webhook_url_override,omitempty"`
	WebhookHeaders     map[string]string `json:"webhook_headers,omitempty"`

	// MQTT-sink fields (type=mqtt):
	// SinkConnectionID is an MQTT-type connection record from which
	// broker_url + username + password are harvested. Topic + QoS
	// come from the rule directly (ts-store models topic as a
	// per-rule field; an MQTT connection record is just the broker).
	SinkConnectionID string `json:"sink_connection_id,omitempty"`
	MQTTTopic        string `json:"mqtt_topic,omitempty"`
	MQTTQoS          *byte  `json:"mqtt_qos,omitempty"` // 0/1/2; nil = ts-store default (1)
}

// CreateAlertResponse echoes what ts-store returned plus any
// dashboard-side artifacts the wizard wants to display (webhook URL
// + secret id for the webhook type; empty for mqtt).
type CreateAlertResponse struct {
	AlertID    string `json:"alert_id"`
	WebhookURL string `json:"webhook_url,omitempty"`
	SecretID   string `json:"secret_id,omitempty"`
}

// CreateAlert registers an alert rule on the underlying tsstore. The
// rule's owning store is always a TSStore connection (req.ConnectionID);
// the delivery sink depends on req.Type — webhook posts to the
// dashboard's own bell receiver (default) or to an override URL, mqtt
// publishes to a broker derived from req.SinkConnectionID. WebSocket
// sink is intentionally not exposed (see CreateAlertRequest godoc).
func (s *TSStoreAlertRulesService) CreateAlert(ctx context.Context, req *CreateAlertRequest, callerGUID string) (*CreateAlertResponse, error) {
	conn, err := s.connections.GetConnection(ctx, req.ConnectionID)
	if err != nil {
		return nil, fmt.Errorf("connection lookup: %w", err)
	}
	if conn.Type != models.ConnectionTypeTSStore || conn.Config.TSStore == nil {
		return nil, fmt.Errorf("connection %s is not a tsstore connection", req.ConnectionID)
	}

	// Common top-level fields shared across every sink type.
	tsBody := map[string]interface{}{
		"type":      req.Type,
		"name":      req.RuleName,
		"condition": req.Condition,
	}
	if req.Cooldown != "" {
		tsBody["cooldown"] = req.Cooldown
	}
	if ref := encodeExternalRef(req.DashboardID); ref != "" {
		tsBody["external_ref"] = ref
	}
	if req.PollInterval != "" {
		tsBody["poll_interval"] = req.PollInterval
	}
	if req.RestartPolicy != "" {
		tsBody["restart_policy"] = req.RestartPolicy
	}
	if req.MaxReplay != "" {
		tsBody["max_replay"] = req.MaxReplay
	}

	// Sink-specific assembly. Each branch fills in the transport
	// block and any dashboard-side artifacts (e.g. minted webhook
	// secret) the wizard wants surfaced in the response.
	var responseURL, secretID string
	switch req.Type {
	case "webhook":
		if s.webhookSecrets == nil {
			return nil, fmt.Errorf("webhook secrets repository not configured")
		}
		webhookURL := strings.TrimSpace(req.WebhookURLOverride)
		if webhookURL == "" {
			// Default: mint a fresh secret + build a URL pointing at
			// the dashboard's own bell receiver. Stale secrets after
			// downstream errors are harmless (receiver checks
			// connection binding).
			secret, err := mintWebhookSecret()
			if err != nil {
				return nil, fmt.Errorf("mint secret: %w", err)
			}
			ws := &models.WebhookSecret{
				ID:           uuid.NewString(),
				Secret:       secret,
				ConnectionID: conn.ID,
				Label:        fmt.Sprintf("rule %q", req.RuleName),
				CreatedAt:    time.Now().UTC(),
				CreatedBy:    callerGUID,
			}
			if err := s.webhookSecrets.Create(ctx, ws); err != nil {
				return nil, fmt.Errorf("persist secret: %w", err)
			}
			secretID = ws.ID
			webhookURL = fmt.Sprintf("http://%s/api/webhooks/tsstore/%s/%s",
				streaming.DashboardHostPort(), conn.ID, secret)
		}
		responseURL = webhookURL
		block := map[string]interface{}{"url": webhookURL}
		if len(req.WebhookHeaders) > 0 {
			block["headers"] = req.WebhookHeaders
		}
		if req.Timeout != "" {
			block["timeout"] = req.Timeout
		}
		tsBody["webhook"] = block

	case "mqtt":
		if req.SinkConnectionID == "" {
			return nil, fmt.Errorf("mqtt alert requires sink_connection_id (an MQTT connection)")
		}
		if strings.TrimSpace(req.MQTTTopic) == "" {
			return nil, fmt.Errorf("mqtt alert requires mqtt_topic")
		}
		sinkConn, err := s.connections.GetConnection(ctx, req.SinkConnectionID)
		if err != nil {
			return nil, fmt.Errorf("sink connection lookup: %w", err)
		}
		if sinkConn.Type != models.ConnectionTypeMQTT || sinkConn.Config.MQTT == nil {
			return nil, fmt.Errorf("sink connection %s is not an mqtt connection", req.SinkConnectionID)
		}
		mqttCfg := sinkConn.Config.MQTT
		block := map[string]interface{}{
			"broker_url": mqttCfg.BrokerURL,
			"topic":      strings.TrimSpace(req.MQTTTopic),
		}
		if mqttCfg.Username != "" {
			block["username"] = mqttCfg.Username
		}
		if mqttCfg.Password != "" {
			block["password"] = mqttCfg.Password
		}
		if req.MQTTQoS != nil {
			block["qos"] = *req.MQTTQoS
		}
		tsBody["mqtt"] = block

	default:
		return nil, fmt.Errorf("unsupported alert type %q (allowed: webhook, mqtt)", req.Type)
	}

	cfg := conn.Config.TSStore
	createURL := fmt.Sprintf("%s/api/stores/%s/alerts", cfg.BaseURL(), cfg.StoreName)
	bodyBytes, err := json.Marshal(tsBody)
	if err != nil {
		return nil, fmt.Errorf("marshal ts-store body: %w", err)
	}

	client := clientFor(cfg)
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, createURL, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if cfg.APIKey != "" {
		httpReq.Header.Set("X-API-Key", cfg.APIKey)
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("ts-store POST: %w", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("ts-store returned %d: %s", resp.StatusCode, strings.TrimSpace(string(respBody)))
	}

	var tsResp struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBody, &tsResp); err != nil {
		return nil, fmt.Errorf("decode ts-store response: %w", err)
	}

	return &CreateAlertResponse{
		AlertID:    tsResp.ID,
		WebhookURL: responseURL,
		SecretID:   secretID,
	}, nil
}

// encodeExternalRef returns a JSON-encoded {dashboard_id:...} payload
// for ts-store's external_ref field, or "" when no dashboard was
// chosen. Empty stays empty so ts-store doesn't store an empty JSON
// object.
func encodeExternalRef(dashboardID string) string {
	if dashboardID == "" {
		return ""
	}
	buf, _ := json.Marshal(struct {
		DashboardID string `json:"dashboard_id"`
	}{DashboardID: dashboardID})
	return string(buf)
}

// mintWebhookSecret returns a high-entropy URL-safe token suitable
// for embedding directly in a path segment. 32 bytes random → 43
// chars base64url (no padding).
func mintWebhookSecret() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}
