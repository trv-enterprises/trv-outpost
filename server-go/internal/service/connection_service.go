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

// ConnectionUsage describes the entities referencing a connection. Empty
// slices mean nothing of that kind references it. The handler serializes
// this struct under "usage" in the 409 response.
type ConnectionUsage struct {
	Components []EntityRef `json:"components"`
	Devices    []EntityRef `json:"devices"`
}

// EntityRef is a minimal {id, name} pair so the frontend can show
// human-readable references without a second API round-trip.
type EntityRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// ConnectionService handles connection business logic
type ConnectionService struct {
	repo          *repository.ConnectionRepository
	componentRepo *repository.ComponentRepository
	deviceRepo    *repository.DeviceRepository
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

// GetConnection retrieves a connection by ID
func (s *ConnectionService) GetConnection(ctx context.Context, id string) (*models.Connection, error) {
	connection, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if connection == nil {
		return nil, fmt.Errorf("connection not found")
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

	total, err := s.repo.Count(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting connections: %w", err)
	}

	return connections, total, nil
}

// ListConnectionsByType retrieves connections by type with pagination
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

	total, err := s.repo.CountByType(ctx, dsType)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting connections by type: %w", err)
	}

	return connections, total, nil
}

// ListConnectionsFiltered retrieves connections with optional namespace,
// type, and tag filters. Empty namespace = all namespaces (cross-namespace
// toggle). Tags are OR-matched; normalized before the query.
func (s *ConnectionService) ListConnectionsFiltered(ctx context.Context, namespace, typeFilter string, tags []string, limit, offset int64) ([]*models.Connection, int64, error) {
	if limit <= 0 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}
	if len(tags) > 0 {
		tags = models.NormalizeTags(tags)
	}

	return s.repo.List(ctx, namespace, typeFilter, tags, limit, offset)
}

// UpdateConnection updates an existing connection
func (s *ConnectionService) UpdateConnection(ctx context.Context, id string, req *models.UpdateConnectionRequest) (*models.Connection, error) {
	// Get existing connection
	connection, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if connection == nil {
		return nil, fmt.Errorf("connection not found")
	}

	// Resolve the post-update namespace + name. Both can change in the
	// same request; uniqueness is checked against the new (namespace, name)
	// pair, not the old one.
	newNamespace := connection.Namespace
	if req.Namespace != "" {
		newNamespace = req.Namespace
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
	preserveSecrets(&req.Config, &existing.Config)
}

// DeleteConnection deletes a connection by ID, blocking the delete if
// any components or devices still reference it. Callers should detect
// ErrConnectionInUse via errors.Is and call ConnectionUsage to retrieve
// the offender list (also returned alongside the error).
func (s *ConnectionService) DeleteConnection(ctx context.Context, id string) (*ConnectionUsage, error) {
	// Check if connection exists
	conn, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if conn == nil {
		return nil, fmt.Errorf("connection not found")
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
	connection, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if connection == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
		return &models.QueryResponse{
			Success:  false,
			Error:    err.Error(),
			Duration: duration,
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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

// GetPrometheusLabelValues retrieves all values for a specific label from a Prometheus connection
func (s *ConnectionService) GetPrometheusLabelValues(ctx context.Context, id string, labelName string) ([]string, error) {
	// Get connection configuration
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
	ds, err := s.repo.FindByID(ctx, connectionID)
	if err != nil {
		return nil, fmt.Errorf("failed to find connection: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("connection not found")
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
