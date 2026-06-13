// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package toolops holds the shared lower-level implementations for
// tools exposed to both the MCP transport (internal/mcp) and the
// Dashboard Assistant chat agent (internal/ai/chat). The split of
// concerns:
//
//	What the tool DOES                       → toolops (this package)
//	JSON-RPC envelope, MCP tools/list shape  → internal/mcp
//	Anthropic tool-call shape, capability    → internal/ai/chat
//	gating, namespace injection, tier
//	classification, result-store handoff
//
// Adding a new dashboard operation: write the function body here
// once, then add wrappers in both consumers (~10 lines each). No
// drift on the underlying behavior; intentional drift on how each
// transport exposes it.
//
// The Component AI agent in internal/ai is NOT migrated to toolops —
// its tools are component-scoped (operate on one chart by ID) and
// don't share shape with the broader operations here.
package toolops

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/connectionguidance"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// Toolset bundles every service dependency the tool implementations
// need. Constructed once at server startup and shared across
// consumers.
type Toolset struct {
	Connections *service.ConnectionService
	Components  *service.ComponentService
	Dashboards  *service.DashboardService
	Namespaces  *service.NamespaceService
	Users       *repository.UserRepository
	Catalog     CatalogLister
}

// CatalogLister exposes the unified type catalog. The MCP package
// already has its own catalog assembly logic; we accept an interface
// so callers can pass either a service.CatalogProvider or a custom
// stub for tests.
type CatalogLister interface {
	GetCatalog(ctx context.Context) (*registry.Catalog, error)
}

// New constructs a Toolset. All fields are required for the tools
// they back; passing nil for a field disables every tool that
// depends on it (the dispatcher returns an explanatory error rather
// than panicking).
func New(
	connections *service.ConnectionService,
	components *service.ComponentService,
	dashboards *service.DashboardService,
	namespaces *service.NamespaceService,
	users *repository.UserRepository,
	catalog CatalogLister,
) *Toolset {
	return &Toolset{
		Connections: connections,
		Components:  components,
		Dashboards:  dashboards,
		Namespaces:  namespaces,
		Users:       users,
		Catalog:     catalog,
	}
}

// ─── User / caller ────────────────────────────────────────────────

// GetCurrentUserInput is empty — the caller is always resolved from
// the consumer's request context (auth GUID), never from the args.
type GetCurrentUserInput struct {
	CallerGUID string // injected by the consumer; not part of the model-facing args
}

// GetCurrentUserOutput is the slim DTO the assistant gets back.
type GetCurrentUserOutput struct {
	GUID         string             `json:"guid"`
	Name         string             `json:"name"`
	Capabilities []models.Capability `json:"capabilities"`
	Email        string             `json:"email,omitempty"`
}

// GetCurrentUser returns the caller's profile.
func (t *Toolset) GetCurrentUser(ctx context.Context, in GetCurrentUserInput) (*GetCurrentUserOutput, error) {
	if t.Users == nil {
		return nil, fmt.Errorf("user repository not wired")
	}
	if in.CallerGUID == "" {
		return nil, fmt.Errorf("caller GUID not provided — chat agent must inject from request context")
	}
	user, err := t.Users.GetByGUID(ctx, in.CallerGUID)
	if err != nil {
		return nil, fmt.Errorf("resolving user: %w", err)
	}
	if user == nil {
		return nil, fmt.Errorf("user not found for guid %s", in.CallerGUID)
	}
	return &GetCurrentUserOutput{
		GUID:         user.GUID,
		Name:         user.Name,
		Capabilities: user.Capabilities,
		Email:        user.Email,
	}, nil
}

// ─── Namespaces ───────────────────────────────────────────────────

type ListNamespacesOutput struct {
	Namespaces []models.Namespace `json:"namespaces"`
	Count      int                `json:"count"`
}

func (t *Toolset) ListNamespaces(ctx context.Context) (*ListNamespacesOutput, error) {
	if t.Namespaces == nil {
		return nil, fmt.Errorf("namespace service not wired")
	}
	resp, err := t.Namespaces.List(ctx)
	if err != nil {
		return nil, err
	}
	return &ListNamespacesOutput{
		Namespaces: resp.Namespaces,
		Count:      len(resp.Namespaces),
	}, nil
}

// ─── Connections ──────────────────────────────────────────────────

type ListConnectionsOutput struct {
	Connections []*models.Connection `json:"connections"`
	Count       int64                `json:"count"`
}

// ListConnections returns every connection in the deployment.
// Pagination cap (100) mirrors the existing MCP behavior.
func (t *Toolset) ListConnections(ctx context.Context) (*ListConnectionsOutput, error) {
	if t.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	conns, total, err := t.Connections.ListConnections(ctx, 100, 0)
	if err != nil {
		return nil, err
	}
	// Sanitize before the records reach the model. The agent never
	// needs live credentials — and the tool result is persisted into
	// the session transcript, which can be exported, so an unmasked
	// api_key/password here leaks in cleartext. SanitizeForAPI masks
	// every secret field (TSStore api_key, SQL/MQTT/Prometheus
	// passwords, API auth creds/headers/body, etc.).
	masked := make([]*models.Connection, len(conns))
	for i, c := range conns {
		masked[i] = c.SanitizeForAPI()
	}
	return &ListConnectionsOutput{
		Connections: masked,
		Count:       total,
	}, nil
}

type GetConnectionInput struct {
	ID string `json:"id"`
}

// GetConnectionOutput wraps the connection record with the
// connection-type-specific guidance string (see
// internal/connectionguidance) so an agent fetching a specific
// connection sees the per-type query-config conventions in the
// same response — no separate guidance round trip needed for the
// common path. GuidanceType echoes the type id the guidance was
// looked up against; falls back to a generic discovery hint when
// no entry exists for the type.
type GetConnectionOutput struct {
	Connection   *models.Connection `json:"connection"`
	GuidanceType string             `json:"guidance_type,omitempty"`
	Guidance     string             `json:"guidance,omitempty"`
}

func (t *Toolset) GetConnection(ctx context.Context, in GetConnectionInput) (*GetConnectionOutput, error) {
	if t.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	if in.ID == "" {
		return nil, fmt.Errorf("id is required")
	}
	conn, err := t.Connections.GetConnection(ctx, in.ID)
	if err != nil {
		return nil, err
	}
	// Sanitize before returning — the agent never needs live
	// credentials and the result is persisted/exportable. Compute
	// guidance from the raw record (type id only), then mask.
	out := &GetConnectionOutput{}
	if conn != nil {
		out.GuidanceType = conn.GetEffectiveTypeID()
		out.Guidance, _ = connectionguidance.Get(out.GuidanceType)
		out.Connection = conn.SanitizeForAPI()
	}
	return out, nil
}

// GetConnectionSchemaInput selects a connection by ID.
//
// Intentionally minimal: no Prometheus metric_prefix / contains /
// max_metrics filters here. The MCP schema tool has inline metric
// filtering today; that filter still lives only in the MCP layer.
// When a second consumer needs it, lift it into a shared helper and
// call it from both rather than duplicating.
type GetConnectionSchemaInput struct {
	ConnectionID string `json:"connection_id"`
}

// GetConnectionSchemaOutput bundles the discovered schema with the
// same per-type guidance the GetConnection path returns. Schema is
// the SchemaResponse pass-through; Guidance lets the agent see the
// query-config conventions for this connection type in the same
// turn it learned the column shape.
type GetConnectionSchemaOutput struct {
	Schema       *models.SchemaResponse `json:"schema"`
	GuidanceType string                 `json:"guidance_type,omitempty"`
	Guidance     string                 `json:"guidance,omitempty"`
}

// GetConnectionSchema runs schema discovery against a connection
// (SQL tables/columns, Prometheus metrics/labels, ts-store
// sample-and-union, etc — see ConnectionService.GetSchema) and
// attaches the per-type guidance for the connection's type.
func (t *Toolset) GetConnectionSchema(ctx context.Context, in GetConnectionSchemaInput) (*GetConnectionSchemaOutput, error) {
	if t.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	if in.ConnectionID == "" {
		return nil, fmt.Errorf("connection_id is required")
	}
	conn, err := t.Connections.GetConnection(ctx, in.ConnectionID)
	if err != nil {
		return nil, err
	}
	schema, err := t.Connections.GetSchema(ctx, in.ConnectionID)
	if err != nil {
		return nil, err
	}

	out := &GetConnectionSchemaOutput{Schema: schema}
	if conn != nil {
		out.GuidanceType = conn.GetEffectiveTypeID()
		out.Guidance, _ = connectionguidance.Get(out.GuidanceType)
	}
	return out, nil
}

// GetConnectionTypeGuidanceInput selects a type id directly. Used
// by callers that haven't picked a specific connection yet but want
// to learn the query-config conventions for a type they're
// considering (e.g. "what would a Postgres connection look like").
type GetConnectionTypeGuidanceInput struct {
	Type string `json:"type"`
}

// GetConnectionTypeGuidanceOutput mirrors the same {type, guidance}
// shape the MCP and component-agent surfaces emit so consumers can
// treat all three identically.
type GetConnectionTypeGuidanceOutput struct {
	Type     string `json:"type"`
	Guidance string `json:"guidance"`
	HasEntry bool   `json:"has_entry"`
}

// GetConnectionTypeGuidance returns the query-config conventions
// for a connection type id (e.g. "store.tsstore", "api.prometheus").
// When no entry exists the result still includes a generic
// discovery hint — callers can detect this via has_entry=false.
func (t *Toolset) GetConnectionTypeGuidance(_ context.Context, in GetConnectionTypeGuidanceInput) (*GetConnectionTypeGuidanceOutput, error) {
	if in.Type == "" {
		return nil, fmt.Errorf("type is required")
	}
	text, ok := connectionguidance.Get(in.Type)
	return &GetConnectionTypeGuidanceOutput{
		Type:     in.Type,
		Guidance: text,
		HasEntry: ok,
	}, nil
}

// CreateConnectionInput wraps the request model so callers can
// stay on the strongly-typed schema.
type CreateConnectionInput struct {
	Request models.CreateConnectionRequest
}

// CreateConnection persists a new connection. Namespace defaults are
// applied by the underlying service if Namespace is empty.
func (t *Toolset) CreateConnection(ctx context.Context, in CreateConnectionInput) (*models.Connection, error) {
	if t.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	return t.Connections.CreateConnection(ctx, &in.Request)
}

type QueryConnectionInput struct {
	ConnectionID string                 `json:"connection_id"`
	Raw          string                 `json:"raw"`
	Type         string                 `json:"type,omitempty"`
	Params       map[string]interface{} `json:"params,omitempty"`
	Limit        int                    `json:"limit,omitempty"`
}

// QueryConnection executes a query against a connection. Mirrors the
// MCP behavior exactly: applies an optional limit AFTER the adapter
// returns and stamps a truncated_to metadata marker on the result so
// downstream consumers (chat-agent + MCP clients) can tell the row
// list was trimmed.
//
// The chat-agent tool-result store (step 4) decides whether to
// summarize the full result before sending it back to the model.
func (ts *Toolset) QueryConnection(ctx context.Context, in QueryConnectionInput) (*models.QueryResponse, error) {
	if ts.Connections == nil {
		return nil, fmt.Errorf("connection service not wired")
	}
	if in.ConnectionID == "" {
		return nil, fmt.Errorf("connection_id is required")
	}
	queryReq := &models.QueryRequest{
		Query: models.Query{
			Raw:    in.Raw,
			Type:   models.QueryType(in.Type),
			Params: in.Params,
		},
	}
	resp, err := ts.Connections.QueryConnection(ctx, in.ConnectionID, queryReq)
	if err != nil || resp == nil || resp.ResultSet == nil {
		return resp, err
	}
	if in.Limit > 0 && len(resp.ResultSet.Rows) > in.Limit {
		resp.ResultSet.Rows = resp.ResultSet.Rows[:in.Limit]
		if resp.ResultSet.Metadata == nil {
			resp.ResultSet.Metadata = map[string]interface{}{}
		}
		resp.ResultSet.Metadata["truncated_to"] = in.Limit
	}
	return resp, nil
}

// ─── Components ───────────────────────────────────────────────────

type ListComponentsInput struct {
	ChartType    string
	ConnectionID string
	Tag          string
}

type ListComponentsOutput struct {
	Components []models.Component `json:"components"`
	Count      int64              `json:"count"`
}

// ListComponents returns components matching the optional filters.
// Pagination + behavior mirror MCP exactly so the shim is transparent.
func (t *Toolset) ListComponents(ctx context.Context, in ListComponentsInput) (*ListComponentsOutput, error) {
	if t.Components == nil {
		return nil, fmt.Errorf("component service not wired")
	}
	params := models.ComponentQueryParams{
		Page:         1,
		PageSize:     100,
		ChartType:    in.ChartType,
		ConnectionID: in.ConnectionID,
		Tag:          in.Tag,
	}
	resp, err := t.Components.ListComponents(ctx, params)
	if err != nil {
		return nil, err
	}
	return &ListComponentsOutput{
		Components: resp.Components,
		Count:      resp.Total,
	}, nil
}

type GetComponentInput struct {
	ID string `json:"id"`
}

// GetComponent returns the latest version of a component by ID.
// Mirrors the existing list-then-pick pattern for the single-record case.
func (t *Toolset) GetComponent(ctx context.Context, in GetComponentInput) (*models.Component, error) {
	if t.Components == nil {
		return nil, fmt.Errorf("component service not wired")
	}
	if in.ID == "" {
		return nil, fmt.Errorf("id is required")
	}
	return t.Components.GetComponent(ctx, in.ID)
}

type CreateComponentInput struct {
	Request models.CreateComponentRequest
}

func (t *Toolset) CreateComponent(ctx context.Context, in CreateComponentInput) (*models.Component, error) {
	if t.Components == nil {
		return nil, fmt.Errorf("component service not wired")
	}
	// Stamp the AI-provenance tag server-side (issue #59) so every
	// agent-created component is marked regardless of what the model did.
	// NormalizeTags (via WithAITag) dedupes, so descriptive tags the model
	// supplied are preserved and "ai" is never doubled.
	in.Request.Tags = models.WithAITag(in.Request.Tags)
	return t.Components.CreateComponent(ctx, &in.Request)
}

type UpdateComponentInput struct {
	ID      string
	Request models.UpdateComponentRequest
}

// UpdateComponent patches an existing component in place (same version).
// Only the fields set in the request are changed — UpdateComponentRequest
// uses pointer fields, so a nil field leaves the stored value untouched.
// The underlying service re-syncs the spec-driven one-liner when
// chart_type changes on a config (non-custom) chart, so callers patch
// chart_type / data_mapping / options and the rendered chart stays in
// sync without ever touching component_code.
//
// Shared by the Assistant and (eventually) MCP so both modify components
// through one code path — see GetComponent/CreateComponent above.
func (t *Toolset) UpdateComponent(ctx context.Context, in UpdateComponentInput) (*models.Component, error) {
	if t.Components == nil {
		return nil, fmt.Errorf("component service not wired")
	}
	if in.ID == "" {
		return nil, fmt.Errorf("id is required")
	}
	return t.Components.UpdateComponent(ctx, in.ID, &in.Request)
}

// ─── Dashboards ───────────────────────────────────────────────────

type ListDashboardsOutput struct {
	Dashboards []models.Dashboard `json:"dashboards"`
	Count      int64              `json:"count"`
}

func (t *Toolset) ListDashboards(ctx context.Context) (*ListDashboardsOutput, error) {
	if t.Dashboards == nil {
		return nil, fmt.Errorf("dashboard service not wired")
	}
	resp, err := t.Dashboards.ListDashboards(ctx, models.DashboardQueryParams{
		Page:     1,
		PageSize: 100,
	})
	if err != nil {
		return nil, err
	}
	return &ListDashboardsOutput{
		Dashboards: resp.Dashboards,
		Count:      resp.Total,
	}, nil
}

type GetDashboardInput struct {
	ID string `json:"id"`
}

// GetDashboard returns a dashboard record by ID, including its
// panels array. Use it when the model needs to inspect a dashboard's
// composition (e.g. to add a panel to an existing layout) without
// pulling every dashboard via list_dashboards.
func (t *Toolset) GetDashboard(ctx context.Context, in GetDashboardInput) (*models.Dashboard, error) {
	if t.Dashboards == nil {
		return nil, fmt.Errorf("dashboard service not wired")
	}
	if in.ID == "" {
		return nil, fmt.Errorf("id is required")
	}
	return t.Dashboards.GetDashboard(ctx, in.ID)
}

type CreateDashboardInput struct {
	Request models.CreateDashboardRequest
}

func (t *Toolset) CreateDashboard(ctx context.Context, in CreateDashboardInput) (*models.Dashboard, error) {
	if t.Dashboards == nil {
		return nil, fmt.Errorf("dashboard service not wired")
	}
	// Stamp the AI-provenance tag server-side (issue #59); see CreateComponent.
	in.Request.Tags = models.WithAITag(in.Request.Tags)
	return t.Dashboards.CreateDashboard(ctx, &in.Request)
}

type UpdateDashboardInput struct {
	ID      string
	Request models.UpdateDashboardRequest
}

// UpdateDashboard patches an existing dashboard in place. Only the fields
// set in the request are changed — UpdateDashboardRequest uses pointer
// fields, so a nil field leaves the stored value untouched. When Panels is
// provided it REPLACES the whole panel array (fetch first to add a subset).
//
// Shared by the Assistant and MCP so both modify dashboards through one
// code path — mirrors UpdateComponent above. This is the seam variable
// authoring rides on: an agent adds settings.variables[] to an existing
// dashboard by patching Settings here.
func (t *Toolset) UpdateDashboard(ctx context.Context, in UpdateDashboardInput) (*models.Dashboard, error) {
	if t.Dashboards == nil {
		return nil, fmt.Errorf("dashboard service not wired")
	}
	if in.ID == "" {
		return nil, fmt.Errorf("id is required")
	}
	return t.Dashboards.UpdateDashboard(ctx, in.ID, &in.Request)
}

// ─── Type catalog ─────────────────────────────────────────────────

// GetCatalogOutput is the deployment-wide unified catalog.
type GetCatalogOutput struct {
	Catalog *registry.Catalog `json:"catalog"`
}

// GetCatalog returns the unified type catalog (integrations,
// connection types, chart/control/display types, device types).
// Honors enabled_types when the catalog provider is wired.
//
// Note: MCP's static-registry tools (list_integrations,
// list_connection_types, list_chart_types, etc.) operate on the
// package-level registry directly and do NOT shim through here —
// they're cheap, deterministic, and would only add a layer.
// GetCatalog is the dynamic catalog (filtered by enabled_types via
// the provider) that the chat agent uses for the "what's available
// here" question.
func (t *Toolset) GetCatalog(ctx context.Context) (*GetCatalogOutput, error) {
	if t.Catalog == nil {
		return nil, fmt.Errorf("catalog provider not wired")
	}
	cat, err := t.Catalog.GetCatalog(ctx)
	if err != nil {
		return nil, err
	}
	return &GetCatalogOutput{Catalog: cat}, nil
}
