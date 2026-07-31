// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/connection"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// ErrConnectionInUse is returned by DeleteConnection when components or
// devices still reference the connection. The handler maps this to HTTP
// 409 Conflict and returns the offender list in the response body so the
// frontend can render a clear "cannot delete — referenced by ..." dialog.
var ErrConnectionInUse = errors.New("connection is in use")

// ErrQueryForbidden is returned by QueryConnection when a raw query targets
// a guarded (SQL/EdgeLake) connection but the call carries no design/manage
// caller and is not a trusted internal call. It closes the arbitrary-SQL
// hole (#23): view users can no longer replay a tampered raw query — they
// must execute stored queries by reference instead. The handler maps this
// to HTTP 403.
var ErrQueryForbidden = errors.New("raw queries against SQL/EdgeLake connections require design or manage capability")

// queryAuthKey keys the per-call authorization decision stamped onto the
// context by the entry points. Keeping it in the context (rather than a new
// method parameter) avoids threading an auth argument through every existing
// QueryConnection caller and the ConnectionServiceIface used by the AI layer.
type queryAuthKey struct{}

type queryAuth struct {
	caller  *models.User
	trusted bool
}

// WithQueryCaller stamps the authenticated caller for a raw-query request.
// The raw /query HTTP handler uses this; QueryConnection then enforces
// design/manage for guarded connection types.
func WithQueryCaller(ctx context.Context, user *models.User) context.Context {
	return context.WithValue(ctx, queryAuthKey{}, queryAuth{caller: user})
}

// WithTrustedQuery marks a query as a trusted internal call, exempt from the
// guarded-type capability check (the verb guard still applies). Used by the
// execute-by-reference path — where the server, not the client, supplies the
// query — and by surfaces already gated to design at their route (AI
// sessions, MCP). It does NOT relax the write/DDL verb guard.
func WithTrustedQuery(ctx context.Context) context.Context {
	return context.WithValue(ctx, queryAuthKey{}, queryAuth{trusted: true})
}

func queryAuthFrom(ctx context.Context) queryAuth {
	az, _ := ctx.Value(queryAuthKey{}).(queryAuth)
	return az
}

// rawQueryAuthorized reports whether a raw query against a GUARDED
// (SQL/EdgeLake) connection is allowed for this call. Allowed when the call
// is trusted (server-supplied query, e.g. execute-by-reference, or a
// design-gated surface) or the caller holds design/manage. Default-deny:
// a call with no stamped auth is refused. Pure so it's unit-testable
// without a repo/DB. Callers must only invoke this for guarded types.
func rawQueryAuthorized(az queryAuth) bool {
	if az.trusted {
		return true
	}
	return az.caller != nil &&
		(az.caller.HasCapability(models.CapabilityDesign) || az.caller.HasCapability(models.CapabilityManage))
}

// ConnectionUsage describes the entities referencing a connection. Empty
// slices mean nothing of that kind references it. The handler serializes
// this struct under "usage" in the 409 response.
type ConnectionUsage struct {
	Components []EntityRef `json:"components"`
	Devices    []EntityRef `json:"devices"`
}

// EntityRef is a minimal {id, name} pair so the frontend can show
// human-readable references without a second API round-trip. Aliased to
// the models type so the list usage-denormalization (#21) and these
// service usage structs share one definition.
type EntityRef = models.EntityRef

// ConnectionService handles connection business logic
type ConnectionService struct {
	repo          *repository.ConnectionRepository
	componentRepo *repository.ComponentRepository
	deviceRepo    *repository.DeviceRepository

	// queryGuardPolicy resolves the admin write-verb policy for the /query
	// verb guard. Wired once at startup (after SettingsService exists) via
	// SetQueryGuardPolicy. Nil → strict read-only (the safe default), so a
	// missing wire can never accidentally permit writes.
	queryGuardPolicy func(ctx context.Context) connection.WritePolicy

	// onConfigChanged is called after a connection's config is updated, so the
	// stream manager can drop any cached/failed stream for it and rebuild with
	// the new config (e.g. the admin fixes a rejected api-key and re-saves —
	// no server restart needed). Wired via SetConfigChangeHook; nil = no-op.
	// A closure rather than a *streaming.Manager keeps the service free of a
	// streaming import (and any cycle risk).
	onConfigChanged func(connectionID string)
}

// SetQueryGuardPolicy wires the closure that resolves the SQL write-verb
// policy (the query_guard.allow_* admin settings) for the /query guard.
// Called once at startup after SettingsService exists. When unset, the guard
// uses the zero-value WritePolicy (strict read-only).
func (s *ConnectionService) SetQueryGuardPolicy(fn func(ctx context.Context) connection.WritePolicy) {
	s.queryGuardPolicy = fn
}

// SetConfigChangeHook wires the callback invoked after a connection's config
// changes (typically streamManager.InvalidateStream). Called once at startup
// after the stream manager exists.
func (s *ConnectionService) SetConfigChangeHook(fn func(connectionID string)) {
	s.onConfigChanged = fn
}

// NewConnectionService creates a new connection service. The component
// and device repos are used only for the delete-guard cross-collection
// lookup; they may be nil during early bootstrap, in which case the
// guard is permissive (delete proceeds without checking references).
// Production main.go always passes live repos.
func NewConnectionService(
	repo *repository.ConnectionRepository,
	componentRepo *repository.ComponentRepository,
	deviceRepo *repository.DeviceRepository,
) *ConnectionService {
	return &ConnectionService{
		repo:          repo,
		componentRepo: componentRepo,
		deviceRepo:    deviceRepo,
	}
}

// CreateConnection creates a new connection with validation. Namespace
// defaults to "default" if the caller doesn't provide one — clients
// should normally pass the user's active namespace from the header.
func (s *ConnectionService) CreateConnection(ctx context.Context, req *models.CreateConnectionRequest) (*models.Connection, error) {
	namespace := req.Namespace
	if namespace == "" {
		namespace = models.DefaultNamespace
	}
	// Namespace grants (issue #4): creating INTO an ungranted namespace
	// is forbidden.
	if err := authz.CheckNamespace(ctx, namespace); err != nil {
		return nil, err
	}

	// Check (namespace, name) uniqueness — same name is allowed in
	// different namespaces.
	existing, err := s.repo.FindByName(ctx, namespace, req.Name)
	if err != nil {
		return nil, fmt.Errorf("error checking name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("connection with name '%s' already exists in namespace '%s'", req.Name, namespace)
	}

	// Validate config based on type
	if err := s.validateConfig(req.Type, req.Config); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	connection := &models.Connection{
		Namespace:   namespace,
		Name:        req.Name,
		Description: req.Description,
		Type:        req.Type,
		Config:      req.Config,
		Tags:        models.NormalizeTags(req.Tags),
		Health: models.HealthInfo{
			Status: models.HealthStatusUnknown,
		},
	}

	if err := s.repo.Create(ctx, connection); err != nil {
		return nil, fmt.Errorf("error creating connection: %w", err)
	}

	return connection, nil
}

// DuplicateConnection copies an existing connection under a new name,
// INCLUDING its secrets.
//
// This has to happen server-side. The API masks every secret as
// "********" on read, so the browser physically cannot build a faithful
// copy — a client-side duplicate can only produce a credential-less
// record, which types with mandatory credentials (Synology) correctly
// refuse to create, and which is useless even where it's accepted.
// Copying here means the duplicate is usable immediately, which is what
// "Duplicate" implies.
//
// SECURITY INVARIANT — the copy lands in the SOURCE's namespace, and
// there is deliberately no target-namespace parameter. Because this is
// the one write path that moves real secrets, letting the caller choose
// a destination would turn "duplicate" into a way to copy a credential
// OUT of the namespace that contains it. Keeping the namespace pinned to
// the source means secrets can never cross a boundary here: you can only
// duplicate what you were already granted (findAuthorized on the read,
// CheckNamespace re-asserted for the write). Moving the copy elsewhere
// afterwards goes through the normal update path, which requires a grant
// on the destination.
//
// Do NOT add a namespace argument to this function.
func (s *ConnectionService) DuplicateConnection(ctx context.Context, id, name string) (*models.Connection, error) {
	src, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := authz.CheckNamespace(ctx, src.Namespace); err != nil {
		return nil, err
	}

	newName := strings.TrimSpace(name)
	if newName == "" {
		return nil, fmt.Errorf("name is required")
	}

	existing, err := s.repo.FindByName(ctx, src.Namespace, newName)
	if err != nil {
		return nil, fmt.Errorf("error checking name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, fmt.Errorf("connection with name '%s' already exists in namespace '%s'", newName, src.Namespace)
	}

	// Copy every configuration-bearing field. Identity, timestamps and
	// health are intentionally NOT copied — the duplicate is a new record
	// that has never been contacted.
	dup := &models.Connection{
		Namespace:        src.Namespace,
		Name:             newName,
		Description:      src.Description,
		Type:             src.Type,
		TypeID:           src.TypeID,
		TypeConfig:       src.TypeConfig,
		Config:           src.Config,
		Tags:             models.NormalizeTags(src.Tags),
		SupportedSchemas: src.SupportedSchemas,
		Health: models.HealthInfo{
			Status: models.HealthStatusUnknown,
		},
	}

	if err := s.repo.Create(ctx, dup); err != nil {
		return nil, fmt.Errorf("error creating connection: %w", err)
	}

	return dup, nil
}

// findAuthorized fetches a connection by id and enforces the caller's
// namespace grants (issue #4). The uniform fetch for every external
// by-id entry point in this service — using it (rather than
// s.repo.FindByID) is what keeps a restricted user from reaching a
// connection, its config, its schema, or its data in an ungranted
// namespace. Returns authz.ErrNamespaceForbidden on a grant miss.
func (s *ConnectionService) findAuthorized(ctx context.Context, id string) (*models.Connection, error) {
	conn, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if conn == nil {
		return nil, fmt.Errorf("connection not found")
	}
	if err := authz.CheckNamespace(ctx, conn.Namespace); err != nil {
		return nil, err
	}
	return conn, nil
}

// GetConnection retrieves a connection by ID
func (s *ConnectionService) GetConnection(ctx context.Context, id string) (*models.Connection, error) {
	connection, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}
	return connection, nil
}

// SaveDiscoveredValues persists a column's distinct-value list onto the
// connection (merged into DiscoveredValues by column), for the dashboard-
// variable dropdown. Used for connection types with no engine-side DISTINCT
// (streams/sockets), where the values are captured client-side at authoring
// time. The route is design-gated (PUT /api/connections/* requires Design), so
// only authors persist; viewers keep a session-only override on the client.
//
// We read the stored connection and mutate only DiscoveredValues, so secrets in
// the record are preserved (we never touch a client-supplied config here).
func (s *ConnectionService) SaveDiscoveredValues(ctx context.Context, id, column string, list models.DiscoveredValueList) (*models.Connection, error) {
	column = strings.TrimSpace(column)
	if column == "" {
		return nil, fmt.Errorf("column is required")
	}
	connection, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}
	if list.CapturedAt.IsZero() {
		list.CapturedAt = time.Now()
	}
	if connection.DiscoveredValues == nil {
		connection.DiscoveredValues = map[string]models.DiscoveredValueList{}
	}
	connection.DiscoveredValues[column] = list

	if err := s.repo.Update(ctx, id, connection); err != nil {
		return nil, fmt.Errorf("error saving discovered values: %w", err)
	}
	return connection, nil
}

// ListConnections retrieves all connections with pagination
func (s *ConnectionService) ListConnections(ctx context.Context, limit, offset int64) ([]*models.Connection, int64, error) {
	if limit <= 0 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}

	connections, err := s.repo.FindAll(ctx, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("error listing connections: %w", err)
	}

	// Namespace grants (issue #4): filter in-service on this legacy path
	// (the paged ListConnectionsPaged does it at the repo level).
	if allowed, restricted := authz.AllowedList(ctx); restricted {
		connections = filterConnectionsByGrant(connections, allowed)
		return connections, int64(len(connections)), nil
	}

	total, err := s.repo.Count(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting connections: %w", err)
	}

	return connections, total, nil
}

// ListConnectionsByType retrieves connections by type with pagination.
// Namespace grants (issue #4): the result is filtered to the caller's
// granted namespaces IN-SERVICE (this legacy path doesn't thread grant
// params through the repo). This is the method the tsstore-alerts
// aggregator fans out over, so filtering here stops a restricted user
// from seeing alerts on ungranted tsstore connections. Total is
// adjusted to the visible count.
func (s *ConnectionService) ListConnectionsByType(ctx context.Context, dsType models.ConnectionType, limit, offset int64) ([]*models.Connection, int64, error) {
	if limit <= 0 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}

	connections, err := s.repo.FindByType(ctx, dsType, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("error listing connections by type: %w", err)
	}

	if allowed, restricted := authz.AllowedList(ctx); restricted {
		connections = filterConnectionsByGrant(connections, allowed)
		return connections, int64(len(connections)), nil
	}

	total, err := s.repo.CountByType(ctx, dsType)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting connections by type: %w", err)
	}

	return connections, total, nil
}

// filterConnectionsByGrant keeps only connections in the granted
// namespace set (issue #4). Empty-namespace records fail closed, same
// rule as applyNamespaceGrant / authz.Grants.Can.
func filterConnectionsByGrant(connections []*models.Connection, allowed []string) []*models.Connection {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, ns := range allowed {
		allowedSet[ns] = struct{}{}
	}
	out := make([]*models.Connection, 0, len(connections))
	for _, conn := range connections {
		if _, ok := allowedSet[conn.Namespace]; ok {
			out = append(out, conn)
		}
	}
	return out
}

// ListConnectionsPaged retrieves connections with server-side filter +
// sort + pagination, returning the standard paginated envelope (#21).
// Empty namespace = all namespaces (cross-namespace toggle). Tags are
// OR-matched and normalized. page_size=0 → all (capped via ClampPageSize).
// Used by both the HTTP list handler and the AI/toolops path so filtering
// behaves identically.
func (s *ConnectionService) ListConnectionsPaged(ctx context.Context, params models.ConnectionQueryParams) (*models.ConnectionListResponse, error) {
	if params.Page < 1 {
		params.Page = 1
	}
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}

	// Namespace grants (issue #4): restrict the query to the caller's
	// allowed set; an explicit namespace filter outside the grants
	// yields an empty page.
	var filterAllowed bool
	params.AllowedNamespaces, params.NamespacesRestricted, filterAllowed = namespaceGrantsForList(ctx, params.Namespace)
	if !filterAllowed {
		return &models.ConnectionListResponse{Connections: []*models.Connection{}, Page: params.Page, PageSize: params.PageSize}, nil
	}

	limit := int64(params.PageSize)
	offset := int64((params.Page - 1) * params.PageSize)

	connections, total, err := s.repo.List(ctx, params, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("error listing connections: %w", err)
	}

	return &models.ConnectionListResponse{
		Connections: connections,
		Total:       total,
		Page:        params.Page,
		PageSize:    params.PageSize,
		HasMore:     models.ComputeHasMore(params.Page, params.PageSize, len(connections), total),
	}, nil
}

// ListConnectionsWithUsage is ListConnectionsPaged plus the denormalized
// component-usage join (#21, ?include_usage=true): each row carries the
// components that reference this connection + the count, computed
// server-side for the current page only. Returns the with-usage rows
// (NOT sanitized here — the handler sanitizes per row before responding).
func (s *ConnectionService) ListConnectionsWithUsage(ctx context.Context, params models.ConnectionQueryParams) ([]models.ConnectionWithUsage, *models.ConnectionListResponse, error) {
	if params.Page < 1 {
		params.Page = 1
	}
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 20)
	if len(params.Tags) > 0 {
		params.Tags = models.NormalizeTags(params.Tags)
	}

	// Namespace grants (issue #4) — same rules as ListConnectionsPaged.
	var filterAllowed bool
	params.AllowedNamespaces, params.NamespacesRestricted, filterAllowed = namespaceGrantsForList(ctx, params.Namespace)
	if !filterAllowed {
		return []models.ConnectionWithUsage{}, &models.ConnectionListResponse{Page: params.Page, PageSize: params.PageSize}, nil
	}

	limit := int64(params.PageSize)
	offset := int64((params.Page - 1) * params.PageSize)

	rows, total, err := s.repo.ListWithUsage(ctx, params, limit, offset)
	if err != nil {
		return nil, nil, fmt.Errorf("error listing connections with usage: %w", err)
	}

	// Redact ungranted component-usage refs (#4): a connection the caller
	// can see may be referenced by a component in an ungranted namespace.
	for i := range rows {
		rows[i].ComponentUsage, rows[i].HasUnauthorizedDeps = redactUsageRefs(ctx, rows[i].ComponentUsage, "component")
	}

	meta := &models.ConnectionListResponse{
		Total:    total,
		Page:     params.Page,
		PageSize: params.PageSize,
		HasMore:  models.ComputeHasMore(params.Page, params.PageSize, len(rows), total),
	}
	return rows, meta, nil
}

// UpdateConnection updates an existing connection
func (s *ConnectionService) UpdateConnection(ctx context.Context, id string, req *models.UpdateConnectionRequest) (*models.Connection, error) {
	// Get existing connection
	connection, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	// Resolve the post-update namespace + name. Both can change in the
	// same request; uniqueness is checked against the new (namespace, name)
	// pair, not the old one.
	newNamespace := connection.Namespace
	if req.Namespace != "" {
		newNamespace = req.Namespace
	}
	// Namespace grants (issue #4): moving into an ungranted namespace is
	// forbidden (the CURRENT namespace was already checked at fetch).
	if err := authz.CheckNamespace(ctx, newNamespace); err != nil {
		return nil, err
	}
	newName := connection.Name
	if req.Name != "" {
		newName = req.Name
	}
	if newNamespace != connection.Namespace || newName != connection.Name {
		existing, err := s.repo.FindByName(ctx, newNamespace, newName)
		if err != nil {
			return nil, fmt.Errorf("error checking name uniqueness: %w", err)
		}
		if existing != nil && existing.ID != connection.ID {
			return nil, fmt.Errorf("connection with name '%s' already exists in namespace '%s'", newName, newNamespace)
		}
		connection.Namespace = newNamespace
		connection.Name = newName
	}

	if req.Description != "" {
		connection.Description = req.Description
	}

	// Update config if provided and validate
	if req.Config.API != nil || req.Config.Socket != nil || req.Config.CSV != nil || req.Config.SQL != nil || req.Config.TSStore != nil || req.Config.EdgeLake != nil {
		// Preserve existing secrets if masked value is sent
		preserveSecrets(&req.Config, &connection.Config)

		if err := s.validateConfig(connection.Type, req.Config); err != nil {
			return nil, fmt.Errorf("invalid configuration: %w", err)
		}
		connection.Config = req.Config
	}

	if req.Tags != nil {
		connection.Tags = models.NormalizeTags(req.Tags)
	}

	if err := s.repo.Update(ctx, id, connection); err != nil {
		return nil, fmt.Errorf("error updating connection: %w", err)
	}

	// Drop any cached/failed stream so the next subscribe rebuilds with the new
	// config — lets an admin fix a rejected api-key and re-save without a
	// server restart.
	if s.onConfigChanged != nil {
		s.onConfigChanged(id)
	}

	return connection, nil
}

// preserveSecrets copies secret values from existing config if the new config contains the masked value.
// This allows the frontend to send "********" for unchanged secrets without losing the actual value.
func preserveSecrets(newConfig, existingConfig *models.ConnectionConfig) {
	// Preserve SQL secrets
	if newConfig.SQL != nil && existingConfig.SQL != nil {
		if newConfig.SQL.Password == models.SecretMaskedValue {
			newConfig.SQL.Password = existingConfig.SQL.Password
		}
	}

	// Preserve API secrets
	if newConfig.API != nil && existingConfig.API != nil {
		// Preserve auth credentials
		if len(newConfig.API.AuthCredentials) > 0 && len(existingConfig.API.AuthCredentials) > 0 {
			for k, v := range newConfig.API.AuthCredentials {
				if v == models.SecretMaskedValue {
					if existingVal, ok := existingConfig.API.AuthCredentials[k]; ok {
						newConfig.API.AuthCredentials[k] = existingVal
					}
				}
			}
		}
		// Preserve sensitive headers
		if len(newConfig.API.Headers) > 0 && len(existingConfig.API.Headers) > 0 {
			for k, v := range newConfig.API.Headers {
				if v == models.SecretMaskedValue {
					if existingVal, ok := existingConfig.API.Headers[k]; ok {
						newConfig.API.Headers[k] = existingVal
					}
				}
			}
		}
	}

	// Preserve TSStore secrets
	if newConfig.TSStore != nil && existingConfig.TSStore != nil {
		if newConfig.TSStore.APIKey == models.SecretMaskedValue {
			newConfig.TSStore.APIKey = existingConfig.TSStore.APIKey
		}
	}

	// Preserve Socket header secrets
	if newConfig.Socket != nil && existingConfig.Socket != nil {
		if len(newConfig.Socket.Headers) > 0 && len(existingConfig.Socket.Headers) > 0 {
			for k, v := range newConfig.Socket.Headers {
				if v == models.SecretMaskedValue {
					if existingVal, ok := existingConfig.Socket.Headers[k]; ok {
						newConfig.Socket.Headers[k] = existingVal
					}
				}
			}
		}
	}

	// Preserve Frigate secrets
	if newConfig.Frigate != nil && existingConfig.Frigate != nil {
		if newConfig.Frigate.Password == models.SecretMaskedValue {
			newConfig.Frigate.Password = existingConfig.Frigate.Password
		}
	}

	// Preserve Synology secrets
	if newConfig.Synology != nil && existingConfig.Synology != nil {
		if newConfig.Synology.Password == models.SecretMaskedValue {
			newConfig.Synology.Password = existingConfig.Synology.Password
		}
	}
}

// preserveAllSecretsFromExisting overwrites every secret field on
// newConfig with whatever is in existingConfig — regardless of what
// the new value looks like. Used by the bundle-import update path
// (dashboard_import.go::applyConnection): bundles can't clobber
// existing credentials, even with an explicit "" or a different
// secret. This is intentional. Cross-environment bundle imports
// should never affect the target's secrets; an admin fills them in
// via the editor on the target deployment.
//
// Differs from preserveSecrets, which only restores from existing
// when the new value is the SecretMaskedValue sentinel (the editor
// round-trip contract). Here we don't care what the new value is.
func preserveAllSecretsFromExisting(newConfig, existingConfig *models.ConnectionConfig) {
	if newConfig.SQL != nil && existingConfig.SQL != nil {
		newConfig.SQL.Password = existingConfig.SQL.Password
		newConfig.SQL.Options = existingConfig.SQL.Options
	}
	if newConfig.API != nil && existingConfig.API != nil {
		newConfig.API.URL = existingConfig.API.URL
		newConfig.API.AuthCredentials = existingConfig.API.AuthCredentials
		newConfig.API.Headers = existingConfig.API.Headers
		newConfig.API.Body = existingConfig.API.Body
		newConfig.API.QueryParams = existingConfig.API.QueryParams
	}
	if newConfig.TSStore != nil && existingConfig.TSStore != nil {
		newConfig.TSStore.APIKey = existingConfig.TSStore.APIKey
		newConfig.TSStore.Headers = existingConfig.TSStore.Headers
	}
	if newConfig.Socket != nil && existingConfig.Socket != nil {
		newConfig.Socket.URL = existingConfig.Socket.URL
		newConfig.Socket.Headers = existingConfig.Socket.Headers
	}
	if newConfig.Prometheus != nil && existingConfig.Prometheus != nil {
		newConfig.Prometheus.URL = existingConfig.Prometheus.URL
		newConfig.Prometheus.Password = existingConfig.Prometheus.Password
	}
	if newConfig.MQTT != nil && existingConfig.MQTT != nil {
		newConfig.MQTT.BrokerURL = existingConfig.MQTT.BrokerURL
		newConfig.MQTT.Password = existingConfig.MQTT.Password
	}
	if newConfig.Frigate != nil && existingConfig.Frigate != nil {
		newConfig.Frigate.Password = existingConfig.Frigate.Password
	}
	if newConfig.Synology != nil && existingConfig.Synology != nil {
		newConfig.Synology.URL = existingConfig.Synology.URL
		newConfig.Synology.Password = existingConfig.Synology.Password
	}
}

// stripPlaceholderSecrets clears every secret field on cfg that holds
// the SecretMaskedValue sentinel (or any other non-empty placeholder
// the bundle might carry). Used by the bundle-import create path so
// new connections land with truly-empty secret fields, not the
// literal "********" string — which would otherwise reach adapters
// at query time and produce confusing upstream errors like
// "invalid API key format".
//
// For freeform fields (API.Body, API.QueryParams, API.URL) where a
// caller might legitimately include the placeholder as part of their
// payload, we only strip the exact-match sentinel — substrings stay.
func stripPlaceholderSecrets(cfg *models.ConnectionConfig) {
	if cfg.SQL != nil {
		if cfg.SQL.Password == models.SecretMaskedValue {
			cfg.SQL.Password = ""
		}
		// Options is freeform; can't safely strip without re-parsing.
		// If the original bundle was emitted by SanitizeForExport it
		// already has "" inline; legacy bundles with literal
		// "********" segments stay as-is (the user will see them
		// when they open the editor and can re-enter).
	}
	if cfg.API != nil {
		for k, v := range cfg.API.AuthCredentials {
			if v == models.SecretMaskedValue {
				cfg.API.AuthCredentials[k] = ""
			}
		}
		for k, v := range cfg.API.Headers {
			if v == models.SecretMaskedValue {
				cfg.API.Headers[k] = ""
			}
		}
		if cfg.API.Body == models.SecretMaskedValue {
			cfg.API.Body = ""
		}
		for k, v := range cfg.API.QueryParams {
			if v == models.SecretMaskedValue {
				cfg.API.QueryParams[k] = ""
			}
		}
	}
	if cfg.TSStore != nil {
		if cfg.TSStore.APIKey == models.SecretMaskedValue {
			cfg.TSStore.APIKey = ""
		}
		for k, v := range cfg.TSStore.Headers {
			if v == models.SecretMaskedValue {
				cfg.TSStore.Headers[k] = ""
			}
		}
	}
	if cfg.Socket != nil {
		for k, v := range cfg.Socket.Headers {
			if v == models.SecretMaskedValue {
				cfg.Socket.Headers[k] = ""
			}
		}
	}
	if cfg.Prometheus != nil {
		if cfg.Prometheus.Password == models.SecretMaskedValue {
			cfg.Prometheus.Password = ""
		}
	}
	if cfg.MQTT != nil {
		if cfg.MQTT.Password == models.SecretMaskedValue {
			cfg.MQTT.Password = ""
		}
	}
	if cfg.Synology != nil {
		if cfg.Synology.Password == models.SecretMaskedValue {
			cfg.Synology.Password = ""
		}
	}
	if cfg.Frigate != nil {
		if cfg.Frigate.Password == models.SecretMaskedValue {
			cfg.Frigate.Password = ""
		}
	}
}

// resolveMaskedSecrets looks up an existing connection by ID and replaces any
// masked secret values ("********") in the test request with the real values from DB.
// This allows testing with current form values without exposing secrets to the frontend.
func (s *ConnectionService) resolveMaskedSecrets(ctx context.Context, req *models.TestConnectionRequest) {
	existing, err := s.repo.FindByID(ctx, req.ID)
	if err != nil || existing == nil {
		return
	}
	// Namespace grants (issue #4): never resolve another namespace's
	// stored secrets into a test request — a restricted caller could
	// otherwise exercise (though not read) an ungranted connection's
	// credentials by testing with its id. Fail closed: secrets stay
	// masked and the test fails.
	if authz.CheckNamespace(ctx, existing.Namespace) != nil {
		return
	}
	preserveSecrets(&req.Config, &existing.Config)
}

// DeleteConnection deletes a connection by ID, blocking the delete if
// any components or devices still reference it. Callers should detect
// ErrConnectionInUse via errors.Is and call ConnectionUsage to retrieve
// the offender list (also returned alongside the error).
func (s *ConnectionService) DeleteConnection(ctx context.Context, id string) (*ConnectionUsage, error) {
	// Check if connection exists (and the caller may touch it).
	if _, err := s.findAuthorized(ctx, id); err != nil {
		return nil, err
	}

	usage, err := s.connectionUsage(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error checking connection usage: %w", err)
	}
	if usage != nil && (len(usage.Components) > 0 || len(usage.Devices) > 0) {
		return usage, ErrConnectionInUse
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return nil, fmt.Errorf("error deleting connection: %w", err)
	}

	return nil, nil
}

// connectionUsage returns a non-nil *ConnectionUsage describing every
// component and device that references the given connection. If the
// component or device repos are unavailable (nil), that part of the
// usage is reported as empty rather than failing — see the constructor
// note about bootstrap-time permissiveness.
func (s *ConnectionService) connectionUsage(ctx context.Context, id string) (*ConnectionUsage, error) {
	usage := &ConnectionUsage{}

	if s.componentRepo != nil {
		comps, err := s.componentRepo.FindByConnectionID(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("listing components: %w", err)
		}
		for _, c := range comps {
			name := c.Title
			if name == "" {
				name = c.Name
			}
			usage.Components = append(usage.Components, EntityRef{ID: c.ID, Name: name})
		}
	}

	if s.deviceRepo != nil {
		devs, err := s.deviceRepo.FindByConnectionID(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("listing devices: %w", err)
		}
		for _, d := range devs {
			usage.Devices = append(usage.Devices, EntityRef{ID: d.ID.Hex(), Name: d.Name})
		}
	}

	return usage, nil
}

// TestConnection tests a connection connection without saving
func (s *ConnectionService) TestConnection(ctx context.Context, req *models.TestConnectionRequest) (*models.TestConnectionResponse, error) {
	// If an existing connection ID is provided, resolve any masked secrets from DB
	if req.ID != "" {
		s.resolveMaskedSecrets(ctx, req)
	}

	if err := s.validateConfig(req.Type, req.Config); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Invalid configuration: %v", err),
		}, nil
	}

	startTime := time.Now()
	var response *models.TestConnectionResponse

	switch req.Type {
	case models.ConnectionTypeSQL:
		response = s.testSQLConnection(req.Config.SQL)
	case models.ConnectionTypeAPI:
		response = s.testAPIConnection(ctx, req.Config.API)
	case models.ConnectionTypeCSV:
		response = s.testFileConnection(req.Config.CSV)
	case models.ConnectionTypeSocket:
		response = &models.TestConnectionResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: "WebSocket validation successful (connection test requires runtime connection)",
		}
	case models.ConnectionTypeTSStore:
		response = s.testTSStoreConnection(ctx, req.Config.TSStore)
	case models.ConnectionTypePrometheus:
		response = s.testPrometheusConnection(ctx, req.Config.Prometheus)
	case models.ConnectionTypeSynology:
		response = s.testSynologyConnection(ctx, req.Config.Synology)
	case models.ConnectionTypeEdgeLake:
		response = s.testEdgeLakeConnection(ctx, req.Config.EdgeLake)
	case models.ConnectionTypeMQTT:
		response = s.testMQTTConnection(ctx, req.Config.MQTT)
	case models.ConnectionTypeFrigate:
		response = s.testFrigateConnection(ctx, req.Config.Frigate)
	default:
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Unsupported connection type: %s", req.Type),
		}, nil
	}

	response.ResponseTime = time.Since(startTime).Milliseconds()
	return response, nil
}

// CheckHealth checks the health of a connection and updates its status
func (s *ConnectionService) CheckHealth(ctx context.Context, id string) (*models.HealthInfo, error) {
	connection, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	startTime := time.Now()
	health := models.HealthInfo{
		LastCheck: time.Now(),
	}

	var testResponse *models.TestConnectionResponse

	switch connection.Type {
	case models.ConnectionTypeSQL:
		testResponse = s.testSQLConnection(connection.Config.SQL)
	case models.ConnectionTypeAPI:
		testResponse = s.testAPIConnection(ctx, connection.Config.API)
	case models.ConnectionTypeCSV:
		testResponse = s.testFileConnection(connection.Config.CSV)
	case models.ConnectionTypeSocket:
		testResponse = &models.TestConnectionResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: "WebSocket configuration valid",
		}
	case models.ConnectionTypeTSStore:
		testResponse = s.testTSStoreConnection(ctx, connection.Config.TSStore)
	case models.ConnectionTypePrometheus:
		testResponse = s.testPrometheusConnection(ctx, connection.Config.Prometheus)
	case models.ConnectionTypeSynology:
		testResponse = s.testSynologyConnection(ctx, connection.Config.Synology)
	case models.ConnectionTypeEdgeLake:
		testResponse = s.testEdgeLakeConnection(ctx, connection.Config.EdgeLake)
	case models.ConnectionTypeMQTT:
		testResponse = s.testMQTTConnection(ctx, connection.Config.MQTT)
	case models.ConnectionTypeFrigate:
		testResponse = s.testFrigateConnection(ctx, connection.Config.Frigate)
	}

	health.Status = testResponse.Status
	health.ResponseTime = time.Since(startTime).Milliseconds()

	if testResponse.Success {
		health.LastSuccess = time.Now()
		health.ErrorMessage = ""
	} else {
		health.ErrorMessage = testResponse.Message
	}

	// Update health in database
	if err := s.repo.UpdateHealth(ctx, id, health); err != nil {
		return nil, fmt.Errorf("error updating health status: %w", err)
	}

	return &health, nil
}

// validateConfig validates connection configuration based on type
func (s *ConnectionService) validateConfig(dsType models.ConnectionType, config models.ConnectionConfig) error {
	switch dsType {
	case models.ConnectionTypeAPI:
		if config.API == nil {
			return fmt.Errorf("API configuration is required for API connection")
		}
		return s.validateAPIConfig(config.API)

	case models.ConnectionTypeSQL:
		if config.SQL == nil {
			return fmt.Errorf("SQL configuration is required for SQL connection")
		}
		return s.validateSQLConfig(config.SQL)

	case models.ConnectionTypeSocket:
		if config.Socket == nil {
			return fmt.Errorf("Socket configuration is required for Socket connection")
		}
		return s.validateSocketConfig(config.Socket)

	case models.ConnectionTypeCSV:
		if config.CSV == nil {
			return fmt.Errorf("CSV configuration is required for CSV connection")
		}
		return s.validateCSVConfig(config.CSV)

	case models.ConnectionTypeTSStore:
		if config.TSStore == nil {
			return fmt.Errorf("TSStore configuration is required for TSStore connection")
		}
		return s.validateTSStoreConfig(config.TSStore)

	case models.ConnectionTypePrometheus:
		if config.Prometheus == nil {
			return fmt.Errorf("Prometheus configuration is required for Prometheus connection")
		}
		return s.validatePrometheusConfig(config.Prometheus)

	case models.ConnectionTypeSynology:
		if config.Synology == nil {
			return fmt.Errorf("Synology configuration is required for Synology connection")
		}
		return s.validateSynologyConfig(config.Synology)

	case models.ConnectionTypeEdgeLake:
		if config.EdgeLake == nil {
			return fmt.Errorf("EdgeLake configuration is required for EdgeLake connection")
		}
		return s.validateEdgeLakeConfig(config.EdgeLake)

	case models.ConnectionTypeMQTT:
		if config.MQTT == nil {
			return fmt.Errorf("MQTT configuration is required for MQTT connection")
		}
		return s.validateMQTTConfig(config.MQTT)

	case models.ConnectionTypeFrigate:
		if config.Frigate == nil {
			return fmt.Errorf("Frigate configuration is required for Frigate connection")
		}
		return s.validateFrigateConfig(config.Frigate)

	default:
		return fmt.Errorf("unsupported connection type: %s", dsType)
	}
}

// validateAPIConfig validates API configuration
func (s *ConnectionService) validateAPIConfig(config *models.APIConfig) error {
	if config.URL == "" {
		return fmt.Errorf("URL is required")
	}

	if config.Method != "" {
		validMethods := map[string]bool{
			"GET": true, "POST": true, "PUT": true, "DELETE": true, "PATCH": true,
		}
		if !validMethods[config.Method] {
			return fmt.Errorf("invalid HTTP method: %s", config.Method)
		}
	}

	if config.Timeout < 0 {
		return fmt.Errorf("timeout cannot be negative")
	}

	if config.RetryCount < 0 {
		return fmt.Errorf("retry count cannot be negative")
	}

	if config.RetryDelay < 0 {
		return fmt.Errorf("retry delay cannot be negative")
	}

	return nil
}

// validateSQLConfig validates SQL configuration
func (s *ConnectionService) validateSQLConfig(config *models.SQLConfig) error {
	if config.Driver == "" {
		return fmt.Errorf("database driver is required")
	}

	validDrivers := map[string]bool{
		"postgres": true, "mysql": true, "sqlite": true, "mssql": true, "oracle": true,
	}
	if !validDrivers[config.Driver] {
		return fmt.Errorf("unsupported database driver: %s", config.Driver)
	}

	// SQLite only needs database (file path)
	if config.Driver == "sqlite" {
		if config.Database == "" {
			return fmt.Errorf("database path is required for SQLite")
		}
		return nil
	}

	// Other drivers need host, database, and username
	if config.Host == "" {
		return fmt.Errorf("host is required")
	}
	if config.Database == "" {
		return fmt.Errorf("database name is required")
	}
	if config.Username == "" {
		return fmt.Errorf("username is required")
	}
	if config.Port == 0 {
		return fmt.Errorf("port is required")
	}

	return nil
}

// validateSocketConfig validates Socket configuration
func (s *ConnectionService) validateSocketConfig(config *models.SocketConfig) error {
	if config.URL == "" {
		return fmt.Errorf("URL is required")
	}

	if !strings.HasPrefix(config.URL, "ws://") && !strings.HasPrefix(config.URL, "wss://") {
		return fmt.Errorf("URL must start with ws:// or wss://")
	}

	if config.ReconnectDelay < 0 {
		return fmt.Errorf("reconnect delay cannot be negative")
	}

	if config.PingInterval < 0 {
		return fmt.Errorf("ping interval cannot be negative")
	}

	return nil
}

// validateCSVConfig validates CSV file configuration
func (s *ConnectionService) validateCSVConfig(config *models.CSVConfig) error {
	if config.Path == "" {
		return fmt.Errorf("file path is required")
	}

	return nil
}

// validateTSStoreConfig validates TSStore configuration
func (s *ConnectionService) validateTSStoreConfig(config *models.TSStoreConfig) error {
	if config.Host == "" {
		return fmt.Errorf("host is required")
	}
	if config.Port == 0 {
		return fmt.Errorf("port is required")
	}
	if config.StoreName == "" {
		return fmt.Errorf("store name is required")
	}

	return nil
}

// validatePrometheusConfig validates Prometheus configuration
func (s *ConnectionService) validatePrometheusConfig(config *models.PrometheusConfig) error {
	if config.URL == "" {
		return fmt.Errorf("Prometheus URL is required")
	}
	return nil
}

// validateSynologyConfig validates Synology DSM configuration. Unlike
// Prometheus, credentials are mandatory — DSM has no anonymous read surface.
func (s *ConnectionService) validateSynologyConfig(config *models.SynologyDSMConfig) error {
	if config.URL == "" {
		return fmt.Errorf("DSM URL is required")
	}
	if config.Username == "" {
		return fmt.Errorf("DSM username is required")
	}
	if config.Password == "" {
		return fmt.Errorf("DSM password is required")
	}
	return nil
}

// validateEdgeLakeConfig validates EdgeLake configuration
func (s *ConnectionService) validateEdgeLakeConfig(config *models.EdgeLakeConfig) error {
	if config.Host == "" {
		return fmt.Errorf("host is required")
	}
	if config.Port == 0 {
		return fmt.Errorf("port is required")
	}
	return nil
}

// testAPIConnection tests an API connection
func (s *ConnectionService) testAPIConnection(ctx context.Context, config *models.APIConfig) *models.TestConnectionResponse {
	// Use the shared builder so the test-connection path honors the
	// same TLS posture as the runtime adapter (both gates: per-conn
	// insecure_skip_verify AND deployment-wide api.allow_insecure_tls).
	if config.InsecureSkipVerify && !connection.IsInsecureTLSAllowed() {
		log.Printf("test api connection %s: insecure_skip_verify is set but ignored — set api.allow_insecure_tls=true (or DASHBOARD_API_ALLOW_INSECURE_TLS=true) at the server level to honor it", config.URL)
	}
	client := connection.BuildAPIHTTPClient(config.Timeout, config.InsecureSkipVerify)

	method := "GET"
	if config.Method != "" {
		method = config.Method
	}

	req, err := http.NewRequestWithContext(ctx, method, config.URL, nil)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Error creating request: %v", err),
		}
	}

	// Add headers
	for key, value := range config.Headers {
		req.Header.Set(key, value)
	}

	// Add auth headers
	if config.AuthType == "bearer" && config.AuthCredentials["token"] != "" {
		req.Header.Set("Authorization", "Bearer "+config.AuthCredentials["token"])
	} else if config.AuthType == "basic" {
		username := config.AuthCredentials["username"]
		password := config.AuthCredentials["password"]
		if username != "" || password != "" {
			req.SetBasicAuth(username, password)
		}
	} else if config.AuthType == "api-key" {
		if key := config.AuthCredentials["key"]; key != "" {
			headerName := config.AuthCredentials["header"]
			if headerName == "" {
				headerName = "X-API-Key"
			}
			req.Header.Set(headerName, key)
		}
	}

	// Add query params
	if len(config.QueryParams) > 0 {
		q := req.URL.Query()
		for key, value := range config.QueryParams {
			q.Add(key, value)
		}
		req.URL.RawQuery = q.Encode()
	}

	resp, err := client.Do(req)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return &models.TestConnectionResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: fmt.Sprintf("Connection successful (HTTP %d)", resp.StatusCode),
		}
	}

	return &models.TestConnectionResponse{
		Success: false,
		Status:  models.HealthStatusDegraded,
		Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status),
	}
}

// testFileConnection tests a CSV file connection
func (s *ConnectionService) testFileConnection(config *models.CSVConfig) *models.TestConnectionResponse {
	// Handle HTTP/HTTPS URLs
	if strings.HasPrefix(config.Path, "http://") || strings.HasPrefix(config.Path, "https://") {
		return s.testCSVURLConnection(config)
	}

	// Local file path handling
	info, err := os.Stat(config.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return &models.TestConnectionResponse{
				Success: false,
				Status:  models.HealthStatusUnhealthy,
				Message: "File does not exist",
			}
		}
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Error accessing file: %v", err),
		}
	}

	if info.IsDir() {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "Path is a directory, not a file",
		}
	}

	ext := strings.TrimPrefix(filepath.Ext(config.Path), ".")
	if ext != "csv" {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusDegraded,
			Message: fmt.Sprintf("File extension .%s is not a CSV file", ext),
		}
	}

	file, err := os.Open(config.Path)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Cannot open file: %v", err),
		}
	}
	defer file.Close()

	buffer := make([]byte, 1024)
	_, err = file.Read(buffer)
	if err != nil && err != io.EOF {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Cannot read file: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("File accessible (size: %d bytes)", info.Size()),
	}
}

// testCSVURLConnection tests a CSV file served over HTTP/HTTPS
func (s *ConnectionService) testCSVURLConnection(config *models.CSVConfig) *models.TestConnectionResponse {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(config.Path)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to fetch CSV from URL: %v", err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status),
		}
	}

	// Read first 1KB to verify it's readable CSV content
	buffer := make([]byte, 1024)
	n, err := resp.Body.Read(buffer)
	if err != nil && err != io.EOF {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Cannot read response body: %v", err),
		}
	}

	size := "unknown"
	if resp.ContentLength > 0 {
		size = fmt.Sprintf("%d bytes", resp.ContentLength)
	} else {
		size = fmt.Sprintf("%d+ bytes", n)
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("URL accessible (size: %s)", size),
	}
}

// testSQLConnection tests a SQL database connection
func (s *ConnectionService) testSQLConnection(config *models.SQLConfig) *models.TestConnectionResponse {
	// Use the connection package to create and test the connection
	sqlDS, err := connection.NewSQLDataSource(config)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}
	defer sqlDS.Close()

	// Connection successful, now fetch schema
	response := &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (driver: %s)", config.Driver),
	}

	// Try to get schema info and include it in the response
	ctx := context.Background()
	schema, err := sqlDS.GetSchema(ctx)
	if err == nil && schema != nil {
		response.Data = schema
	}

	return response
}

// testTSStoreConnection tests a TSStore connection
func (s *ConnectionService) testTSStoreConnection(ctx context.Context, config *models.TSStoreConfig) *models.TestConnectionResponse {
	tsDS, err := connection.NewTSStoreDataSource(config)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create TSStore connection: %v", err),
		}
	}
	defer tsDS.Close()

	// Test the connection
	if err := tsDS.TestConnection(ctx); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (store: %s)", config.StoreName),
	}
}

// testPrometheusConnection tests a Prometheus connection
func (s *ConnectionService) testPrometheusConnection(ctx context.Context, config *models.PrometheusConfig) *models.TestConnectionResponse {
	promDS, err := connection.NewPrometheusDataSource(config)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create Prometheus connection: %v", err),
		}
	}
	defer promDS.Close()

	// Test the connection
	if err := promDS.TestConnection(ctx); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (%s)", config.URL),
	}
}

// testSynologyConnection logs in to DSM and reads system info. Synology is
// registry-only (no legacy DataSource type), so this builds the adapter through
// the registry rather than a New*DataSource constructor.
func (s *ConnectionService) testSynologyConnection(ctx context.Context, config *models.SynologyDSMConfig) *models.TestConnectionResponse {
	if config == nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "Synology configuration is required",
		}
	}

	adapter, err := registry.CreateAdapter("api.synology", map[string]interface{}{
		"url":                  config.URL,
		"username":             config.Username,
		"password":             config.Password,
		"timeout":              config.Timeout,
		"insecure_skip_verify": config.InsecureSkipVerify,
	})
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create Synology connection: %v", err),
		}
	}
	defer adapter.Close()

	if err := adapter.TestConnection(ctx); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (%s)", config.URL),
	}
}

// testEdgeLakeConnection tests an EdgeLake connection
func (s *ConnectionService) testEdgeLakeConnection(ctx context.Context, config *models.EdgeLakeConfig) *models.TestConnectionResponse {
	elDS, err := connection.NewEdgeLakeDataSource(config)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create EdgeLake connection: %v", err),
		}
	}
	defer elDS.Close()

	// Test the connection
	if err := elDS.TestConnection(ctx); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (%s:%d)", config.Host, config.Port),
	}
}

// validateMQTTConfig validates MQTT configuration
func (s *ConnectionService) validateMQTTConfig(config *models.MQTTConfig) error {
	if config.BrokerURL == "" {
		return fmt.Errorf("broker URL is required")
	}
	if config.QoS < 0 || config.QoS > 2 {
		return fmt.Errorf("QoS must be 0, 1, or 2")
	}
	return nil
}

// testMQTTConnection tests an MQTT broker connection
func (s *ConnectionService) testMQTTConnection(ctx context.Context, config *models.MQTTConfig) *models.TestConnectionResponse {
	if config == nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "MQTT configuration is required",
		}
	}

	// Use the registry adapter to test the connection
	adapter, err := registry.CreateAdapter("stream.mqtt", map[string]interface{}{
		"broker_url":  config.BrokerURL,
		"client_id":   config.ClientID,
		"username":    config.Username,
		"password":    config.Password,
		"tls":         config.TLS,
		"keep_alive":  config.KeepAlive,
		"qos":         config.QoS,
		"clean_start": config.CleanStart,
	})
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create adapter: %v", err),
		}
	}

	if err := adapter.TestConnection(ctx); err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connected to MQTT broker at %s", config.BrokerURL),
	}
}

// validateFrigateConfig validates Frigate NVR configuration
func (s *ConnectionService) validateFrigateConfig(config *models.FrigateConfig) error {
	if config.Host == "" {
		return fmt.Errorf("host is required")
	}
	if config.Port == 0 {
		config.Port = 5000
	}
	if config.Go2RTCPort == 0 {
		config.Go2RTCPort = 1984
	}
	return nil
}

// testFrigateConnection tests a Frigate NVR connection by hitting /api/version
func (s *ConnectionService) testFrigateConnection(ctx context.Context, config *models.FrigateConfig) *models.TestConnectionResponse {
	if config == nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "Frigate configuration is required",
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := config.BaseURL() + "/api/version"

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create request: %v", err),
		}
	}

	if config.Username != "" {
		req.SetBasicAuth(config.Username, config.Password)
	}

	resp, err := client.Do(req)
	if err != nil {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to connect to Frigate at %s: %v", config.BaseURL(), err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &models.TestConnectionResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Frigate returned status %d", resp.StatusCode),
		}
	}

	body, _ := io.ReadAll(resp.Body)
	version := strings.TrimSpace(string(body))

	return &models.TestConnectionResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connected to Frigate %s at %s", version, config.BaseURL()),
	}
}

// QueryConnection executes a query against a connection
func (s *ConnectionService) QueryConnection(ctx context.Context, id string, req *models.QueryRequest) (*models.QueryResponse, error) {
	// Get connection configuration
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	// Server-side verb guard: /query is a no-capability endpoint (View Mode
	// renders every non-streaming chart through it), so it can't be defended
	// by capability gating. Refuse write/DDL verbs here so a replayed or
	// tampered request can't run an INSERT/DELETE/DROP.
	//
	// CRITICAL: gate on the CONNECTION's type (ds.Type, server-side and
	// trustworthy), NOT req.Query.Type. The adapter is chosen by the
	// connection, and the SQL adapter runs query.Raw regardless of the
	// client-supplied query.Type — so trusting query.Type here is a
	// type-confusion bypass (set type:"api" on a SQL connection and the
	// guard would skip while the SQL adapter still runs the DROP).
	// SQL-family connections only; api/mqtt/prometheus/... can't run raw SQL.
	// Runs before adapter creation so a blocked query never opens a connection.
	if connection.MustGuard(string(ds.Type)) {
		// Capability gate (#23): a raw query against a SQL/EdgeLake
		// connection is only allowed for a trusted internal call (e.g.
		// execute-by-reference, where the SERVER supplied the query) or a
		// caller holding design/manage. Default-deny: a call with no
		// stamped auth fails closed. This closes the view-user arbitrary-
		// SQL hole — view users execute stored queries by reference and
		// never reach the raw path for guarded types. The verb guard below
		// still applies on top of this.
		if !rawQueryAuthorized(queryAuthFrom(ctx)) {
			return nil, ErrQueryForbidden
		}

		policy := connection.WritePolicy{} // zero value = strict read-only
		if s.queryGuardPolicy != nil {
			policy = s.queryGuardPolicy(ctx)
		}
		if gErr := connection.ClassifyAndAuthorize(req.Query.Raw, policy); gErr != nil {
			return &models.QueryResponse{
				Success:   false,
				Error:     connection.GuardErrorMessage(gErr),
				ErrorCode: models.QueryErrorWriteNotAllowed,
			}, nil
		}
	}

	// Create connection adapter
	factory := connection.NewConnectionFactory()
	dataSource, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.QueryResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create connection: %v", err),
		}, nil
	}
	defer dataSource.Close()

	// Execute query
	startTime := time.Now()
	resultSet, err := dataSource.Query(ctx, req.Query)
	duration := time.Since(startTime).Milliseconds()

	if err != nil {
		errorCode := ""
		if errors.Is(err, connection.ErrDashboardVariableNotSet) {
			errorCode = models.QueryErrorVariableNotSet
		} else if errors.Is(err, connection.ErrRangeNotSet) {
			errorCode = models.QueryErrorRangeNotSet
		}
		return &models.QueryResponse{
			Success:   false,
			Error:     err.Error(),
			ErrorCode: errorCode,
			Duration:  duration,
		}, nil
	}

	return &models.QueryResponse{
		Success:   true,
		ResultSet: resultSet,
		Duration:  duration,
	}, nil
}

// GetSchema retrieves schema information for a connection that supports it
// Only SQL connections implement SchemaProvider; others return an error
func (s *ConnectionService) GetSchema(ctx context.Context, id string) (*models.SchemaResponse, error) {
	// Get connection configuration
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	// Handle Prometheus schema separately
	if ds.Type == models.ConnectionTypePrometheus {
		return s.getPrometheusSchema(ctx, ds)
	}

	// Handle TSStore schema separately. ts-store has three flavours of
	// store (json / schema / text); only `schema` stores have a formal
	// schema endpoint. For `json` and unset, fall back to sampling the
	// most recent records and unioning their keys — the same pattern an
	// agent would otherwise have to do manually. Works
	// for both WS-transport and REST-transport tsstore connections since
	// the schema fetch hits the same REST endpoint either way.
	if ds.Type == models.ConnectionTypeTSStore {
		return s.getTSStoreSchema(ctx, ds)
	}

	// Synology: DSM has no schema endpoint, so sample a small fixed set of
	// APIs and infer columns from the results — same idea as the ts-store
	// json-store path. Deliberately scoped to Synology: the other unsupported
	// types (api / csv / socket / mqtt / edgelake) each need their own probe
	// strategy and none has been tested, so they keep the explicit
	// "not supported" answer rather than a guess. See #215.
	if ds.Type == models.ConnectionTypeSynology {
		return s.getSynologySchema(ctx, ds)
	}

	// Only SQL connections support schema discovery
	if ds.Type != models.ConnectionTypeSQL {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Schema discovery not supported for connection type: %s", ds.Type),
		}, nil
	}

	// Create connection adapter
	factory := connection.NewConnectionFactory()
	dataSource, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create connection: %v", err),
		}, nil
	}
	defer dataSource.Close()

	// Check if connection implements SchemaProvider
	schemaProvider, ok := dataSource.(models.SchemaProvider)
	if !ok {
		return &models.SchemaResponse{
			Success: false,
			Error:   "Connection does not support schema discovery",
		}, nil
	}

	// Get schema
	startTime := time.Now()
	schema, err := schemaProvider.GetSchema(ctx)
	duration := time.Since(startTime).Milliseconds()

	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    err.Error(),
			Duration: duration,
		}, nil
	}

	return &models.SchemaResponse{
		Success:  true,
		Schema:   schema,
		Duration: duration,
	}, nil
}

// GetVariableValues returns the distinct values of a column on a connection,
// used to populate a dashboard-variable picker. Dispatches per connection type
// (mirrors GetSchema). Step 1 implements SQL + EdgeLake via a generated GROUP BY
// query; streaming/record-based capture and the API/CSV dedupe path land next.
func (s *ConnectionService) GetVariableValues(ctx context.Context, id string, req *models.VariableValuesRequest) (*models.VariableValuesResponse, error) {
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}
	if req == nil || req.Column == "" {
		return &models.VariableValuesResponse{Success: false, Error: "column is required"}, nil
	}

	switch ds.Type {
	case models.ConnectionTypeSQL:
		return s.getSQLVariableValues(ctx, ds, req)
	case models.ConnectionTypeEdgeLake:
		return s.getEdgeLakeVariableValues(ctx, ds, req)
	case models.ConnectionTypeAPI:
		return s.getAPIVariableValues(ctx, ds, req)
	case models.ConnectionTypeTSStore:
		return s.getTSStoreVariableValues(ctx, ds, req)
	default:
		return &models.VariableValuesResponse{
			Success: false,
			Error:   fmt.Sprintf("variable value discovery not yet supported for connection type: %s", ds.Type),
		}, nil
	}
}

// getTSStoreVariableValues harvests distinct column values from the most-recent
// records of a ts-store connection. ts-store exposes an HTTP query API
// (fetchNewest) regardless of transport — even "streaming" (WebSocket) tsstore
// connections answer "newest" over HTTP — so discovery pulls the latest 1000
// records and harvests the column, rather than relying on a slow live capture.
// (Raw websocket/socket connections, which have NO query API, are the only
// types that still require a live SSE capture.)
func (s *ConnectionService) getTSStoreVariableValues(ctx context.Context, ds *models.Connection, req *models.VariableValuesRequest) (*models.VariableValuesResponse, error) {
	limit := req.Limit
	if limit <= 0 {
		limit = 1000
	}
	query := models.Query{
		Raw:    "newest",
		Type:   models.QueryTypeTSStore,
		Params: map[string]interface{}{"limit": limit},
	}
	return s.runColumnDistinct(ctx, ds, query, req.Column)
}

// getAPIVariableValues fetches records from an API connection (one-shot, low
// latency — no engine-side DISTINCT) and harvests the distinct values of the
// requested column in the browser-equivalent way the editor does. The column
// is matched by NAME (API result sets carry all record fields), not position.
func (s *ConnectionService) getAPIVariableValues(ctx context.Context, ds *models.Connection, req *models.VariableValuesRequest) (*models.VariableValuesResponse, error) {
	// Empty raw → the adapter uses the connection's configured base URL. The
	// component's query params aren't needed for value discovery; we just want a
	// representative record set to harvest the column from.
	query := models.Query{Raw: "", Type: models.QueryTypeAPI}
	return s.runColumnDistinct(ctx, ds, query, req.Column)
}

// runColumnDistinct executes a query through the connection's adapter and
// harvests the distinct values of a NAMED column (by header index), preserving
// first-seen order. Used for record-based sources (API) where the result set
// carries every field, unlike the single-column SQL/EdgeLake distinct queries
// that runDistinctQuery flattens from column 0.
func (s *ConnectionService) runColumnDistinct(ctx context.Context, ds *models.Connection, query models.Query, column string) (*models.VariableValuesResponse, error) {
	factory := connection.NewConnectionFactory()
	adapter, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: fmt.Sprintf("failed to create connection: %v", err)}, nil
	}
	defer adapter.Close()

	rs, err := adapter.Query(ctx, query)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: err.Error()}, nil
	}

	// Find the column index by name.
	idx := -1
	for i, c := range rs.Columns {
		if c == column {
			idx = i
			break
		}
	}
	if idx < 0 {
		return &models.VariableValuesResponse{
			Success: false,
			Error:   fmt.Sprintf("column %q not found in API response (columns: %v)", column, rs.Columns),
		}, nil
	}

	seen := make(map[string]struct{})
	values := make([]string, 0, len(rs.Rows))
	for _, row := range rs.Rows {
		if idx >= len(row) || row[idx] == nil {
			continue
		}
		v := fmt.Sprintf("%v", row[idx])
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		values = append(values, v)
	}
	return &models.VariableValuesResponse{Success: true, Values: values, Count: len(values)}, nil
}

// getSQLVariableValues runs a dialect-correct GROUP BY distinct query against a
// SQL connection and returns the first column's values.
func (s *ConnectionService) getSQLVariableValues(ctx context.Context, ds *models.Connection, req *models.VariableValuesRequest) (*models.VariableValuesResponse, error) {
	if ds.Config.SQL == nil {
		return &models.VariableValuesResponse{Success: false, Error: "SQL configuration missing"}, nil
	}
	if req.Table == "" {
		return &models.VariableValuesResponse{Success: false, Error: "table is required for SQL value discovery"}, nil
	}
	sqlText, err := connection.BuildDistinctQuery(ds.Config.SQL.Driver, req.Column, req.Table, req.Limit)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: err.Error()}, nil
	}
	return s.runDistinctQuery(ctx, ds, models.Query{Raw: sqlText, Type: models.QueryTypeSQL}, false)
}

// getEdgeLakeVariableValues runs a GROUP BY distinct query (no DISTINCT, no
// ORDER BY — EdgeLake parser limits) and sorts the values server-side.
func (s *ConnectionService) getEdgeLakeVariableValues(ctx context.Context, ds *models.Connection, req *models.VariableValuesRequest) (*models.VariableValuesResponse, error) {
	if req.Table == "" {
		return &models.VariableValuesResponse{Success: false, Error: "table is required for EdgeLake value discovery"}, nil
	}
	if req.Database == "" {
		return &models.VariableValuesResponse{Success: false, Error: "database is required for EdgeLake value discovery"}, nil
	}
	sqlText, err := connection.BuildDistinctQuery("edgelake", req.Column, req.Table, req.Limit)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: err.Error()}, nil
	}
	query := models.Query{
		Raw:    sqlText,
		Type:   models.QueryTypeEdgeLake,
		Params: map[string]interface{}{"database": req.Database},
	}
	return s.runDistinctQuery(ctx, ds, query, true) // sort server-side
}

// runDistinctQuery executes a single-column query through the connection's
// adapter and flattens the first column into a de-duplicated string slice.
// When sortValues is true the result is sorted (for adapters that can't order
// server-side, e.g. EdgeLake).
func (s *ConnectionService) runDistinctQuery(ctx context.Context, ds *models.Connection, query models.Query, sortValues bool) (*models.VariableValuesResponse, error) {
	factory := connection.NewConnectionFactory()
	adapter, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: fmt.Sprintf("failed to create connection: %v", err)}, nil
	}
	defer adapter.Close()

	rs, err := adapter.Query(ctx, query)
	if err != nil {
		return &models.VariableValuesResponse{Success: false, Error: err.Error()}, nil
	}

	seen := make(map[string]struct{})
	values := make([]string, 0, len(rs.Rows))
	for _, row := range rs.Rows {
		if len(row) == 0 || row[0] == nil {
			continue
		}
		v := fmt.Sprintf("%v", row[0])
		if v == "" {
			continue
		}
		if _, dup := seen[v]; dup {
			continue
		}
		seen[v] = struct{}{}
		values = append(values, v)
	}
	if sortValues {
		sort.Strings(values)
	}
	return &models.VariableValuesResponse{Success: true, Values: values, Count: len(values)}, nil
}

// getPrometheusSchema retrieves schema information from a Prometheus connection
func (s *ConnectionService) getPrometheusSchema(ctx context.Context, ds *models.Connection) (*models.SchemaResponse, error) {
	startTime := time.Now()

	// Create Prometheus connection
	promDS, err := connection.NewPrometheusDataSource(ds.Config.Prometheus)
	if err != nil {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create Prometheus connection: %v", err),
		}, nil
	}
	defer promDS.Close()

	// Get metrics list
	metrics, err := promDS.GetMetrics(ctx)
	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    fmt.Sprintf("Failed to get metrics: %v", err),
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	// Get labels list
	labels, err := promDS.GetLabels(ctx)
	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    fmt.Sprintf("Failed to get labels: %v", err),
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	// Build metric info list (just names for now, metadata could be added later)
	metricInfos := make([]models.PrometheusMetricInfo, len(metrics))
	for i, name := range metrics {
		metricInfos[i] = models.PrometheusMetricInfo{
			Name: name,
		}
	}

	return &models.SchemaResponse{
		Success: true,
		PrometheusSchema: &models.PrometheusSchemaInfo{
			Metrics: metricInfos,
			Labels:  labels,
		},
		Duration: time.Since(startTime).Milliseconds(),
	}, nil
}

// getTSStoreSchema retrieves schema information from a TSStore connection.
// Strategy depends on the store's data_type:
//   - "schema" stores: ts-store has a formal /schema endpoint we can decode.
//     (Not yet exposed by the dashboard's adapter — fall through to sampling
//     for now; once we add a typed accessor this branch should call it.)
//   - "json" / unset: sample the 10 newest records via the existing Query
//     path; the adapter already unions keys across records to produce the
//     columns array. We surface that list as a single synthetic table.
//   - "text" stores: there are no fields. Return success with an empty
//     column list so the UI can render a friendly "no fields" message
//     rather than an error.
//
// Works identically for streaming-transport and REST-transport tsstore
// connections because both point at the same ts-store backend (host+port+
// store_name) and reach the same REST endpoint for the sample fetch.
func (s *ConnectionService) getTSStoreSchema(ctx context.Context, ds *models.Connection) (*models.SchemaResponse, error) {
	startTime := time.Now()

	if ds.Config.TSStore == nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    "TSStore connection has no tsstore config block",
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	dataType := string(ds.Config.TSStore.DataType)

	// "text" stores have no field structure. Friendlier than returning an
	// empty-string-equals-json fallthrough.
	if dataType == "text" {
		return &models.SchemaResponse{
			Success: true,
			Schema: &models.SchemaInfo{
				Database: ds.Config.TSStore.StoreName,
				Tables: []models.TableInfo{{
					Name:    ds.Config.TSStore.StoreName,
					Columns: []models.ColumnInfo{},
				}},
			},
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	// Sample-and-infer path. Works for "json" stores (the common case) and
	// for "schema" stores (until we wire a dedicated accessor). The adapter's
	// Query method handles ResultSet construction including the column union
	// across records — we just lift the columns out and type-tag them.
	tsDS, err := connection.NewTSStoreDataSource(ds.Config.TSStore)
	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    fmt.Sprintf("Failed to create TSStore connection: %v", err),
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}
	defer tsDS.Close()

	rs, err := tsDS.Query(ctx, models.Query{
		Raw:    "newest",
		Params: map[string]interface{}{"limit": 10},
	})
	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    fmt.Sprintf("Failed to sample records: %v", err),
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	// Build columns. Type comes from the first non-null cell we see in
	// each column across the sample — JSON has limited type info, but
	// "number" vs "string" vs "bool" is still useful for the UI.
	// (Shared with the Synology probe so the typing rules stay identical.)
	columns := inferColumnsFromResultSet(rs)

	return &models.SchemaResponse{
		Success: true,
		Schema: &models.SchemaInfo{
			Database: ds.Config.TSStore.StoreName,
			Tables: []models.TableInfo{{
				Name:    ds.Config.TSStore.StoreName,
				Columns: columns,
			}},
		},
		Duration: time.Since(startTime).Milliseconds(),
	}, nil
}

// Unlike ts-store — where a single "newest" query describes the whole store —
// a Synology connection has no one probe that characterizes it: each component
// targets a different DSM API, and the columns depend on which one plus the
// result_path. So we sample the DSM catalog the adapter ships (see
// connection.SynologyCatalog) and return each API as its own "table".
//
// The catalog is deliberately NOT the full DSM API surface: it holds the APIs
// that carry dashboard-worthy data, need no per-component parameters, and are
// cheap. An author targeting some other API still discovers its columns the
// same way anyone does — run the query (the editor's Fetch Data, or the agent's
// query tool) and read result_set.columns.
//
// Sourcing the probes from the catalog rather than a second hardcoded list
// means the editor's query picker and this schema prober can never disagree
// about how an API is called.

// getSynologySchema builds an inferred schema for a Synology DSM connection by
// sampling a handful of DSM APIs and reading the columns off each ResultSet.
//
// DSM exposes no schema endpoint — it is a fixed set of RPC-ish APIs whose
// response shape is whatever that API returns. This mirrors the ts-store
// sample-and-infer path: run the adapter's own Query (which already handles
// flattening + the column union across records) and type-tag from the first
// non-null cell in each column.
//
// A probe that fails is SKIPPED rather than failing the whole call — an
// account without privilege for one API (DSM returns 105) should still get the
// schema of the APIs it can read. Only an empty result overall is an error.
func (s *ConnectionService) getSynologySchema(ctx context.Context, ds *models.Connection) (*models.SchemaResponse, error) {
	startTime := time.Now()

	if ds.Config.Synology == nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    "Synology connection has no synology config block",
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	factory := connection.NewConnectionFactory()
	adapter, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.SchemaResponse{
			Success:  false,
			Error:    fmt.Sprintf("Failed to create Synology connection: %v", err),
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}
	defer adapter.Close()

	tables := make([]models.TableInfo, 0, len(connection.SynologyCatalog))
	var skipped []string

	for _, probe := range connection.SynologyCatalog {
		rs, err := adapter.Query(ctx, models.Query{Raw: probe.API, Params: probe.Params()})
		if err != nil || rs == nil || len(rs.Columns) == 0 {
			// Most commonly DSM error 105 (this account lacks privilege for
			// that API). Record it so the caller knows the schema is partial.
			skipped = append(skipped, probe.ID)
			continue
		}

		tables = append(tables, models.TableInfo{
			Name:    probe.ID,
			Columns: inferColumnsFromResultSet(rs),
		})
	}

	if len(tables) == 0 {
		msg := "No Synology API returned data — the account may lack privilege for SYNO.Core.* reads (DSM error 105 requires a group with administrator privilege)"
		return &models.SchemaResponse{
			Success:  false,
			Error:    msg,
			Duration: time.Since(startTime).Milliseconds(),
		}, nil
	}

	if len(skipped) > 0 {
		log.Printf("synology schema: %d/%d probes returned no data (skipped: %v) — schema is partial",
			len(skipped), len(connection.SynologyCatalog), skipped)
	}

	return &models.SchemaResponse{
		Success: true,
		Schema: &models.SchemaInfo{
			Database: ds.Name,
			Tables:   tables,
		},
		Duration: time.Since(startTime).Milliseconds(),
	}, nil
}

// inferColumnsFromResultSet type-tags each column from the first non-null cell
// found in the sample. Extracted from the ts-store schema path so the Synology
// probe uses the identical typing rules.
func inferColumnsFromResultSet(rs *models.ResultSet) []models.ColumnInfo {
	columns := make([]models.ColumnInfo, 0, len(rs.Columns))
	for colIdx, name := range rs.Columns {
		typ := "unknown"
		for _, row := range rs.Rows {
			if colIdx >= len(row) || row[colIdx] == nil {
				continue
			}
			switch row[colIdx].(type) {
			case bool:
				typ = "boolean"
			case float32, float64, int, int32, int64, uint, uint32, uint64:
				typ = "number"
			case string:
				typ = "string"
			default:
				typ = "object"
			}
			break
		}
		columns = append(columns, models.ColumnInfo{
			Name:     name,
			Type:     typ,
			Nullable: true,
		})
	}
	return columns
}

// GetPrometheusLabelValues retrieves all values for a specific label from a Prometheus connection
func (s *ConnectionService) GetPrometheusLabelValues(ctx context.Context, id string, labelName string) ([]string, error) {
	// Get connection configuration
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	// Only Prometheus connections support this
	if ds.Type != models.ConnectionTypePrometheus {
		return nil, fmt.Errorf("label values are only available for Prometheus connections")
	}

	// Create Prometheus connection
	promDS, err := connection.NewPrometheusDataSource(ds.Config.Prometheus)
	if err != nil {
		return nil, fmt.Errorf("failed to create Prometheus connection: %w", err)
	}
	defer promDS.Close()

	// Get label values
	values, err := promDS.GetLabelValues(ctx, labelName)
	if err != nil {
		return nil, fmt.Errorf("failed to get label values: %w", err)
	}

	return values, nil
}

// GetEdgeLakeDatabases retrieves all databases from an EdgeLake data source
func (s *ConnectionService) GetEdgeLakeDatabases(ctx context.Context, id string) ([]string, error) {
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	if ds.Type != models.ConnectionTypeEdgeLake {
		return nil, fmt.Errorf("database listing is only available for EdgeLake connections")
	}

	elDS, err := connection.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake connection: %w", err)
	}
	defer elDS.Close()

	databases, err := elDS.ListDatabases(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list databases: %w", err)
	}

	return databases, nil
}

// GetEdgeLakeTables retrieves tables for a specific database from an EdgeLake data source
func (s *ConnectionService) GetEdgeLakeTables(ctx context.Context, id string, database string) ([]string, error) {
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	if ds.Type != models.ConnectionTypeEdgeLake {
		return nil, fmt.Errorf("table listing is only available for EdgeLake connections")
	}

	elDS, err := connection.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake connection: %w", err)
	}
	defer elDS.Close()

	tables, err := elDS.ListTables(ctx, database)
	if err != nil {
		return nil, fmt.Errorf("failed to list tables: %w", err)
	}

	return tables, nil
}

// GetEdgeLakeSchema retrieves the column schema for a table from an EdgeLake data source
func (s *ConnectionService) GetEdgeLakeSchema(ctx context.Context, id string, database, table string) ([]models.EdgeLakeColumnInfo, error) {
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}

	if ds.Type != models.ConnectionTypeEdgeLake {
		return nil, fmt.Errorf("schema discovery is only available for EdgeLake connections")
	}

	elDS, err := connection.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake connection: %w", err)
	}
	defer elDS.Close()

	columns, err := elDS.GetTableSchema(ctx, database, table)
	if err != nil {
		return nil, fmt.Errorf("failed to get table schema: %w", err)
	}

	return columns, nil
}

// GetMQTTTopics discovers available topics from an MQTT broker by subscribing briefly
func (s *ConnectionService) GetMQTTTopics(ctx context.Context, id string) ([]string, error) {
	ds, err := s.findAuthorized(ctx, id)
	if err != nil {
		return nil, err
	}
	if ds.Type != models.ConnectionTypeMQTT || ds.Config.MQTT == nil {
		return nil, fmt.Errorf("connection is not an MQTT connection")
	}

	// Create adapter and use Stream to collect topics
	adapter, err := registry.CreateAdapter("stream.mqtt", ds.GetEffectiveConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create MQTT adapter: %w", err)
	}

	// Subscribe to # for a few seconds to discover topics
	collectCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	recordChan, err := adapter.Stream(collectCtx, registry.Query{Raw: "#"})
	if err != nil {
		return nil, fmt.Errorf("failed to subscribe: %w", err)
	}

	topicSet := make(map[string]bool)
	for {
		select {
		case record, ok := <-recordChan:
			if !ok {
				goto done
			}
			if topic, exists := record["topic"].(string); exists {
				topicSet[topic] = true
			}
		case <-collectCtx.Done():
			goto done
		}
	}

done:
	// Close the adapter to clean up the connection
	adapter.Close()

	topics := make([]string, 0, len(topicSet))
	for topic := range topicSet {
		topics = append(topics, topic)
	}

	// Sort topics alphabetically
	sort.Strings(topics)

	return topics, nil
}

// SampleMQTTTopic subscribes to a single MQTT topic and returns the schema (columns)
// plus one sample row, with a short timeout. Used by the chart editor to discover
// the message schema for a topic before configuring data mapping.
func (s *ConnectionService) SampleMQTTTopic(ctx context.Context, connectionID string, topic string) (map[string]interface{}, error) {
	ds, err := s.findAuthorized(ctx, connectionID)
	if err != nil {
		return nil, err
	}
	if ds.Type != models.ConnectionTypeMQTT || ds.Config.MQTT == nil {
		return nil, fmt.Errorf("connection is not an MQTT connection")
	}

	adapter, err := registry.CreateAdapter("stream.mqtt", ds.GetEffectiveConfig())
	if err != nil {
		return nil, fmt.Errorf("failed to create MQTT adapter: %w", err)
	}
	defer adapter.Close()

	// Subscribe to the specific topic for up to 3 seconds, stop after first message
	collectCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	recordChan, err := adapter.Stream(collectCtx, registry.Query{Raw: topic})
	if err != nil {
		return nil, fmt.Errorf("failed to subscribe to topic: %w", err)
	}

	// Wait for first message
	select {
	case record, ok := <-recordChan:
		if !ok {
			return map[string]interface{}{
				"topic":   topic,
				"columns": []string{},
				"sample":  map[string]interface{}{},
			}, nil
		}
		// Extract columns in a stable order: timestamp and topic first, then sorted alpha
		columns := []string{"timestamp", "topic"}
		otherCols := []string{}
		for k := range record {
			if k != "timestamp" && k != "topic" {
				otherCols = append(otherCols, k)
			}
		}
		sort.Strings(otherCols)
		columns = append(columns, otherCols...)

		return map[string]interface{}{
			"topic":   topic,
			"columns": columns,
			"sample":  record,
		}, nil

	case <-collectCtx.Done():
		return map[string]interface{}{
			"topic":   topic,
			"columns": []string{},
			"sample":  map[string]interface{}{},
			"timeout": true,
		}, nil
	}
}

// CreateAdapter creates a registry.Adapter for the given data source
// This is used by the command handler for bidirectional communication
func (s *ConnectionService) CreateAdapter(ctx context.Context, ds *models.Connection) (registry.Adapter, error) {
	factory := connection.NewConnectionFactory()
	return factory.CreateAdapterFromConfig(ds)
}
