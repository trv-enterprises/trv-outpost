// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/datasource"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// DatasourceService handles datasource business logic
type DatasourceService struct {
	repo *repository.DatasourceRepository
}

// NewDatasourceService creates a new datasource service
func NewDatasourceService(repo *repository.DatasourceRepository) *DatasourceService {
	return &DatasourceService{
		repo: repo,
	}
}

// CreateDatasource creates a new datasource with validation. Namespace
// defaults to "default" if the caller doesn't provide one — clients
// should normally pass the user's active namespace from the header.
func (s *DatasourceService) CreateDatasource(ctx context.Context, req *models.CreateDatasourceRequest) (*models.Datasource, error) {
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
		return nil, fmt.Errorf("datasource with name '%s' already exists in namespace '%s'", req.Name, namespace)
	}

	// Validate config based on type
	if err := s.validateConfig(req.Type, req.Config); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	// Default MaskSecrets to true if not specified
	maskSecrets := true
	if req.MaskSecrets != nil {
		maskSecrets = *req.MaskSecrets
	}

	datasource := &models.Datasource{
		Namespace:   namespace,
		Name:        req.Name,
		Description: req.Description,
		Type:        req.Type,
		Config:      req.Config,
		Tags:        models.NormalizeTags(req.Tags),
		MaskSecrets: maskSecrets,
		Health: models.HealthInfo{
			Status: models.HealthStatusUnknown,
		},
	}

	if err := s.repo.Create(ctx, datasource); err != nil {
		return nil, fmt.Errorf("error creating datasource: %w", err)
	}

	return datasource, nil
}

// GetDatasource retrieves a datasource by ID
func (s *DatasourceService) GetDatasource(ctx context.Context, id string) (*models.Datasource, error) {
	datasource, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if datasource == nil {
		return nil, fmt.Errorf("datasource not found")
	}
	return datasource, nil
}

// ListDatasources retrieves all datasources with pagination
func (s *DatasourceService) ListDatasources(ctx context.Context, limit, offset int64) ([]*models.Datasource, int64, error) {
	if limit <= 0 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}

	datasources, err := s.repo.FindAll(ctx, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("error listing datasources: %w", err)
	}

	total, err := s.repo.Count(ctx)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting datasources: %w", err)
	}

	return datasources, total, nil
}

// ListDatasourcesByType retrieves datasources by type with pagination
func (s *DatasourceService) ListDatasourcesByType(ctx context.Context, dsType models.DatasourceType, limit, offset int64) ([]*models.Datasource, int64, error) {
	if limit <= 0 {
		limit = 20
	}
	if offset < 0 {
		offset = 0
	}

	datasources, err := s.repo.FindByType(ctx, dsType, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("error listing datasources by type: %w", err)
	}

	total, err := s.repo.CountByType(ctx, dsType)
	if err != nil {
		return nil, 0, fmt.Errorf("error counting datasources by type: %w", err)
	}

	return datasources, total, nil
}

// ListDatasourcesFiltered retrieves datasources with optional namespace,
// type, and tag filters. Empty namespace = all namespaces (cross-namespace
// toggle). Tags are OR-matched; normalized before the query.
func (s *DatasourceService) ListDatasourcesFiltered(ctx context.Context, namespace, typeFilter string, tags []string, limit, offset int64) ([]*models.Datasource, int64, error) {
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

// UpdateDatasource updates an existing datasource
func (s *DatasourceService) UpdateDatasource(ctx context.Context, id string, req *models.UpdateDatasourceRequest) (*models.Datasource, error) {
	// Get existing datasource
	datasource, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if datasource == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	// Resolve the post-update namespace + name. Both can change in the
	// same request; uniqueness is checked against the new (namespace, name)
	// pair, not the old one.
	newNamespace := datasource.Namespace
	if req.Namespace != "" {
		newNamespace = req.Namespace
	}
	newName := datasource.Name
	if req.Name != "" {
		newName = req.Name
	}
	if newNamespace != datasource.Namespace || newName != datasource.Name {
		existing, err := s.repo.FindByName(ctx, newNamespace, newName)
		if err != nil {
			return nil, fmt.Errorf("error checking name uniqueness: %w", err)
		}
		if existing != nil && existing.ID != datasource.ID {
			return nil, fmt.Errorf("datasource with name '%s' already exists in namespace '%s'", newName, newNamespace)
		}
		datasource.Namespace = newNamespace
		datasource.Name = newName
	}

	if req.Description != "" {
		datasource.Description = req.Description
	}

	// MaskSecrets cannot be changed after creation (security constraint)
	// If provided and different from current value, reject the update
	if req.MaskSecrets != nil && *req.MaskSecrets != datasource.MaskSecrets {
		return nil, fmt.Errorf("mask_secrets cannot be changed after datasource creation")
	}

	// Update config if provided and validate
	if req.Config.API != nil || req.Config.Socket != nil || req.Config.CSV != nil || req.Config.SQL != nil || req.Config.TSStore != nil || req.Config.EdgeLake != nil {
		// Preserve existing secrets if masked value is sent
		preserveSecrets(&req.Config, &datasource.Config)

		if err := s.validateConfig(datasource.Type, req.Config); err != nil {
			return nil, fmt.Errorf("invalid configuration: %w", err)
		}
		datasource.Config = req.Config
	}

	if req.Tags != nil {
		datasource.Tags = models.NormalizeTags(req.Tags)
	}

	if err := s.repo.Update(ctx, id, datasource); err != nil {
		return nil, fmt.Errorf("error updating datasource: %w", err)
	}

	return datasource, nil
}

// preserveSecrets copies secret values from existing config if the new config contains the masked value.
// This allows the frontend to send "********" for unchanged secrets without losing the actual value.
func preserveSecrets(newConfig, existingConfig *models.DatasourceConfig) {
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

// resolveMaskedSecrets looks up an existing connection by ID and replaces any
// masked secret values ("********") in the test request with the real values from DB.
// This allows testing with current form values without exposing secrets to the frontend.
func (s *DatasourceService) resolveMaskedSecrets(ctx context.Context, req *models.TestDatasourceRequest) {
	existing, err := s.repo.FindByID(ctx, req.ID)
	if err != nil || existing == nil {
		return
	}
	preserveSecrets(&req.Config, &existing.Config)
}

// DeleteDatasource deletes a datasource by ID
func (s *DatasourceService) DeleteDatasource(ctx context.Context, id string) error {
	// Check if datasource exists
	datasource, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return fmt.Errorf("error retrieving datasource: %w", err)
	}
	if datasource == nil {
		return fmt.Errorf("datasource not found")
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("error deleting datasource: %w", err)
	}

	return nil
}

// TestDatasource tests a datasource connection without saving
func (s *DatasourceService) TestDatasource(ctx context.Context, req *models.TestDatasourceRequest) (*models.TestDatasourceResponse, error) {
	// If an existing connection ID is provided, resolve any masked secrets from DB
	if req.ID != "" {
		s.resolveMaskedSecrets(ctx, req)
	}

	if err := s.validateConfig(req.Type, req.Config); err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Invalid configuration: %v", err),
		}, nil
	}

	startTime := time.Now()
	var response *models.TestDatasourceResponse

	switch req.Type {
	case models.DatasourceTypeSQL:
		response = s.testSQLConnection(req.Config.SQL)
	case models.DatasourceTypeAPI:
		response = s.testAPIConnection(ctx, req.Config.API)
	case models.DatasourceTypeCSV:
		response = s.testFileConnection(req.Config.CSV)
	case models.DatasourceTypeSocket:
		response = &models.TestDatasourceResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: "WebSocket validation successful (connection test requires runtime connection)",
		}
	case models.DatasourceTypeTSStore:
		response = s.testTSStoreConnection(ctx, req.Config.TSStore)
	case models.DatasourceTypePrometheus:
		response = s.testPrometheusConnection(ctx, req.Config.Prometheus)
	case models.DatasourceTypeEdgeLake:
		response = s.testEdgeLakeConnection(ctx, req.Config.EdgeLake)
	case models.DatasourceTypeMQTT:
		response = s.testMQTTConnection(ctx, req.Config.MQTT)
	case models.DatasourceTypeFrigate:
		response = s.testFrigateConnection(ctx, req.Config.Frigate)
	default:
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Unsupported datasource type: %s", req.Type),
		}, nil
	}

	response.ResponseTime = time.Since(startTime).Milliseconds()
	return response, nil
}

// CheckHealth checks the health of a datasource and updates its status
func (s *DatasourceService) CheckHealth(ctx context.Context, id string) (*models.HealthInfo, error) {
	datasource, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if datasource == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	startTime := time.Now()
	health := models.HealthInfo{
		LastCheck: time.Now(),
	}

	var testResponse *models.TestDatasourceResponse

	switch datasource.Type {
	case models.DatasourceTypeSQL:
		testResponse = s.testSQLConnection(datasource.Config.SQL)
	case models.DatasourceTypeAPI:
		testResponse = s.testAPIConnection(ctx, datasource.Config.API)
	case models.DatasourceTypeCSV:
		testResponse = s.testFileConnection(datasource.Config.CSV)
	case models.DatasourceTypeSocket:
		testResponse = &models.TestDatasourceResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: "WebSocket configuration valid",
		}
	case models.DatasourceTypeTSStore:
		testResponse = s.testTSStoreConnection(ctx, datasource.Config.TSStore)
	case models.DatasourceTypePrometheus:
		testResponse = s.testPrometheusConnection(ctx, datasource.Config.Prometheus)
	case models.DatasourceTypeEdgeLake:
		testResponse = s.testEdgeLakeConnection(ctx, datasource.Config.EdgeLake)
	case models.DatasourceTypeMQTT:
		testResponse = s.testMQTTConnection(ctx, datasource.Config.MQTT)
	case models.DatasourceTypeFrigate:
		testResponse = s.testFrigateConnection(ctx, datasource.Config.Frigate)
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

// validateConfig validates datasource configuration based on type
func (s *DatasourceService) validateConfig(dsType models.DatasourceType, config models.DatasourceConfig) error {
	switch dsType {
	case models.DatasourceTypeAPI:
		if config.API == nil {
			return fmt.Errorf("API configuration is required for API datasource")
		}
		return s.validateAPIConfig(config.API)

	case models.DatasourceTypeSQL:
		if config.SQL == nil {
			return fmt.Errorf("SQL configuration is required for SQL datasource")
		}
		return s.validateSQLConfig(config.SQL)

	case models.DatasourceTypeSocket:
		if config.Socket == nil {
			return fmt.Errorf("Socket configuration is required for Socket datasource")
		}
		return s.validateSocketConfig(config.Socket)

	case models.DatasourceTypeCSV:
		if config.CSV == nil {
			return fmt.Errorf("CSV configuration is required for CSV datasource")
		}
		return s.validateCSVConfig(config.CSV)

	case models.DatasourceTypeTSStore:
		if config.TSStore == nil {
			return fmt.Errorf("TSStore configuration is required for TSStore datasource")
		}
		return s.validateTSStoreConfig(config.TSStore)

	case models.DatasourceTypePrometheus:
		if config.Prometheus == nil {
			return fmt.Errorf("Prometheus configuration is required for Prometheus datasource")
		}
		return s.validatePrometheusConfig(config.Prometheus)

	case models.DatasourceTypeEdgeLake:
		if config.EdgeLake == nil {
			return fmt.Errorf("EdgeLake configuration is required for EdgeLake datasource")
		}
		return s.validateEdgeLakeConfig(config.EdgeLake)

	case models.DatasourceTypeMQTT:
		if config.MQTT == nil {
			return fmt.Errorf("MQTT configuration is required for MQTT datasource")
		}
		return s.validateMQTTConfig(config.MQTT)

	case models.DatasourceTypeFrigate:
		if config.Frigate == nil {
			return fmt.Errorf("Frigate configuration is required for Frigate datasource")
		}
		return s.validateFrigateConfig(config.Frigate)

	default:
		return fmt.Errorf("unsupported datasource type: %s", dsType)
	}
}

// validateAPIConfig validates API configuration
func (s *DatasourceService) validateAPIConfig(config *models.APIConfig) error {
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
func (s *DatasourceService) validateSQLConfig(config *models.SQLConfig) error {
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
func (s *DatasourceService) validateSocketConfig(config *models.SocketConfig) error {
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
func (s *DatasourceService) validateCSVConfig(config *models.CSVConfig) error {
	if config.Path == "" {
		return fmt.Errorf("file path is required")
	}

	return nil
}

// validateTSStoreConfig validates TSStore configuration
func (s *DatasourceService) validateTSStoreConfig(config *models.TSStoreConfig) error {
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
func (s *DatasourceService) validatePrometheusConfig(config *models.PrometheusConfig) error {
	if config.URL == "" {
		return fmt.Errorf("Prometheus URL is required")
	}
	return nil
}

// validateEdgeLakeConfig validates EdgeLake configuration
func (s *DatasourceService) validateEdgeLakeConfig(config *models.EdgeLakeConfig) error {
	if config.Host == "" {
		return fmt.Errorf("host is required")
	}
	if config.Port == 0 {
		return fmt.Errorf("port is required")
	}
	return nil
}

// testAPIConnection tests an API connection
func (s *DatasourceService) testAPIConnection(ctx context.Context, config *models.APIConfig) *models.TestDatasourceResponse {
	timeout := 30 * time.Second
	if config.Timeout > 0 {
		timeout = time.Duration(config.Timeout) * time.Second
	}

	client := &http.Client{
		Timeout: timeout,
	}

	method := "GET"
	if config.Method != "" {
		method = config.Method
	}

	req, err := http.NewRequestWithContext(ctx, method, config.URL, nil)
	if err != nil {
		return &models.TestDatasourceResponse{
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
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return &models.TestDatasourceResponse{
			Success: true,
			Status:  models.HealthStatusHealthy,
			Message: fmt.Sprintf("Connection successful (HTTP %d)", resp.StatusCode),
		}
	}

	return &models.TestDatasourceResponse{
		Success: false,
		Status:  models.HealthStatusDegraded,
		Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status),
	}
}

// testFileConnection tests a CSV file datasource
func (s *DatasourceService) testFileConnection(config *models.CSVConfig) *models.TestDatasourceResponse {
	// Handle HTTP/HTTPS URLs
	if strings.HasPrefix(config.Path, "http://") || strings.HasPrefix(config.Path, "https://") {
		return s.testCSVURLConnection(config)
	}

	// Local file path handling
	info, err := os.Stat(config.Path)
	if err != nil {
		if os.IsNotExist(err) {
			return &models.TestDatasourceResponse{
				Success: false,
				Status:  models.HealthStatusUnhealthy,
				Message: "File does not exist",
			}
		}
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Error accessing file: %v", err),
		}
	}

	if info.IsDir() {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "Path is a directory, not a file",
		}
	}

	ext := strings.TrimPrefix(filepath.Ext(config.Path), ".")
	if ext != "csv" {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusDegraded,
			Message: fmt.Sprintf("File extension .%s is not a CSV file", ext),
		}
	}

	file, err := os.Open(config.Path)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Cannot open file: %v", err),
		}
	}
	defer file.Close()

	buffer := make([]byte, 1024)
	_, err = file.Read(buffer)
	if err != nil && err != io.EOF {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Cannot read file: %v", err),
		}
	}

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("File accessible (size: %d bytes)", info.Size()),
	}
}

// testCSVURLConnection tests a CSV file served over HTTP/HTTPS
func (s *DatasourceService) testCSVURLConnection(config *models.CSVConfig) *models.TestDatasourceResponse {
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Get(config.Path)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to fetch CSV from URL: %v", err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, resp.Status),
		}
	}

	// Read first 1KB to verify it's readable CSV content
	buffer := make([]byte, 1024)
	n, err := resp.Body.Read(buffer)
	if err != nil && err != io.EOF {
		return &models.TestDatasourceResponse{
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

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("URL accessible (size: %s)", size),
	}
}

// testSQLConnection tests a SQL database connection
func (s *DatasourceService) testSQLConnection(config *models.SQLConfig) *models.TestDatasourceResponse {
	// Use the datasource package to create and test the connection
	sqlDS, err := datasource.NewSQLDataSource(config)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}
	defer sqlDS.Close()

	// Connection successful, now fetch schema
	response := &models.TestDatasourceResponse{
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
func (s *DatasourceService) testTSStoreConnection(ctx context.Context, config *models.TSStoreConfig) *models.TestDatasourceResponse {
	tsDS, err := datasource.NewTSStoreDataSource(config)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create TSStore datasource: %v", err),
		}
	}
	defer tsDS.Close()

	// Test the connection
	if err := tsDS.TestConnection(ctx); err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (store: %s)", config.StoreName),
	}
}

// testPrometheusConnection tests a Prometheus connection
func (s *DatasourceService) testPrometheusConnection(ctx context.Context, config *models.PrometheusConfig) *models.TestDatasourceResponse {
	promDS, err := datasource.NewPrometheusDataSource(config)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create Prometheus datasource: %v", err),
		}
	}
	defer promDS.Close()

	// Test the connection
	if err := promDS.TestConnection(ctx); err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (%s)", config.URL),
	}
}

// testEdgeLakeConnection tests an EdgeLake connection
func (s *DatasourceService) testEdgeLakeConnection(ctx context.Context, config *models.EdgeLakeConfig) *models.TestDatasourceResponse {
	elDS, err := datasource.NewEdgeLakeDataSource(config)
	if err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create EdgeLake datasource: %v", err),
		}
	}
	defer elDS.Close()

	// Test the connection
	if err := elDS.TestConnection(ctx); err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connection successful (%s:%d)", config.Host, config.Port),
	}
}

// validateMQTTConfig validates MQTT configuration
func (s *DatasourceService) validateMQTTConfig(config *models.MQTTConfig) error {
	if config.BrokerURL == "" {
		return fmt.Errorf("broker URL is required")
	}
	if config.QoS < 0 || config.QoS > 2 {
		return fmt.Errorf("QoS must be 0, 1, or 2")
	}
	return nil
}

// testMQTTConnection tests an MQTT broker connection
func (s *DatasourceService) testMQTTConnection(ctx context.Context, config *models.MQTTConfig) *models.TestDatasourceResponse {
	if config == nil {
		return &models.TestDatasourceResponse{
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
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to create adapter: %v", err),
		}
	}

	if err := adapter.TestConnection(ctx); err != nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Connection failed: %v", err),
		}
	}

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connected to MQTT broker at %s", config.BrokerURL),
	}
}

// validateFrigateConfig validates Frigate NVR configuration
func (s *DatasourceService) validateFrigateConfig(config *models.FrigateConfig) error {
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
func (s *DatasourceService) testFrigateConnection(ctx context.Context, config *models.FrigateConfig) *models.TestDatasourceResponse {
	if config == nil {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: "Frigate configuration is required",
		}
	}

	client := &http.Client{Timeout: 10 * time.Second}
	url := config.BaseURL() + "/api/version"

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return &models.TestDatasourceResponse{
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
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Failed to connect to Frigate at %s: %v", config.BaseURL(), err),
		}
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &models.TestDatasourceResponse{
			Success: false,
			Status:  models.HealthStatusUnhealthy,
			Message: fmt.Sprintf("Frigate returned status %d", resp.StatusCode),
		}
	}

	body, _ := io.ReadAll(resp.Body)
	version := strings.TrimSpace(string(body))

	return &models.TestDatasourceResponse{
		Success: true,
		Status:  models.HealthStatusHealthy,
		Message: fmt.Sprintf("Connected to Frigate %s at %s", version, config.BaseURL()),
	}
}

// QueryDatasource executes a query against a datasource
func (s *DatasourceService) QueryDatasource(ctx context.Context, id string, req *models.QueryRequest) (*models.QueryResponse, error) {
	// Get datasource configuration
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	// Create datasource adapter
	factory := datasource.NewDataSourceFactory()
	dataSource, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.QueryResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create datasource: %v", err),
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

// GetSchema retrieves schema information for a datasource that supports it
// Only SQL datasources implement SchemaProvider; others return an error
func (s *DatasourceService) GetSchema(ctx context.Context, id string) (*models.SchemaResponse, error) {
	// Get datasource configuration
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	// Handle Prometheus schema separately
	if ds.Type == models.DatasourceTypePrometheus {
		return s.getPrometheusSchema(ctx, ds)
	}

	// Only SQL datasources support schema discovery
	if ds.Type != models.DatasourceTypeSQL {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Schema discovery not supported for datasource type: %s", ds.Type),
		}, nil
	}

	// Create datasource adapter
	factory := datasource.NewDataSourceFactory()
	dataSource, err := factory.CreateFromConfig(ds)
	if err != nil {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create datasource: %v", err),
		}, nil
	}
	defer dataSource.Close()

	// Check if datasource implements SchemaProvider
	schemaProvider, ok := dataSource.(models.SchemaProvider)
	if !ok {
		return &models.SchemaResponse{
			Success: false,
			Error:   "Datasource does not support schema discovery",
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

// getPrometheusSchema retrieves schema information from a Prometheus datasource
func (s *DatasourceService) getPrometheusSchema(ctx context.Context, ds *models.Datasource) (*models.SchemaResponse, error) {
	startTime := time.Now()

	// Create Prometheus datasource
	promDS, err := datasource.NewPrometheusDataSource(ds.Config.Prometheus)
	if err != nil {
		return &models.SchemaResponse{
			Success: false,
			Error:   fmt.Sprintf("Failed to create Prometheus datasource: %v", err),
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

// GetPrometheusLabelValues retrieves all values for a specific label from a Prometheus datasource
func (s *DatasourceService) GetPrometheusLabelValues(ctx context.Context, id string, labelName string) ([]string, error) {
	// Get datasource configuration
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	// Only Prometheus datasources support this
	if ds.Type != models.DatasourceTypePrometheus {
		return nil, fmt.Errorf("label values are only available for Prometheus datasources")
	}

	// Create Prometheus datasource
	promDS, err := datasource.NewPrometheusDataSource(ds.Config.Prometheus)
	if err != nil {
		return nil, fmt.Errorf("failed to create Prometheus datasource: %w", err)
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
func (s *DatasourceService) GetEdgeLakeDatabases(ctx context.Context, id string) ([]string, error) {
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	if ds.Type != models.DatasourceTypeEdgeLake {
		return nil, fmt.Errorf("database listing is only available for EdgeLake datasources")
	}

	elDS, err := datasource.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake datasource: %w", err)
	}
	defer elDS.Close()

	databases, err := elDS.ListDatabases(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to list databases: %w", err)
	}

	return databases, nil
}

// GetEdgeLakeTables retrieves tables for a specific database from an EdgeLake data source
func (s *DatasourceService) GetEdgeLakeTables(ctx context.Context, id string, database string) ([]string, error) {
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	if ds.Type != models.DatasourceTypeEdgeLake {
		return nil, fmt.Errorf("table listing is only available for EdgeLake datasources")
	}

	elDS, err := datasource.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake datasource: %w", err)
	}
	defer elDS.Close()

	tables, err := elDS.ListTables(ctx, database)
	if err != nil {
		return nil, fmt.Errorf("failed to list tables: %w", err)
	}

	return tables, nil
}

// GetEdgeLakeSchema retrieves the column schema for a table from an EdgeLake data source
func (s *DatasourceService) GetEdgeLakeSchema(ctx context.Context, id string, database, table string) ([]models.EdgeLakeColumnInfo, error) {
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("error retrieving datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}

	if ds.Type != models.DatasourceTypeEdgeLake {
		return nil, fmt.Errorf("schema discovery is only available for EdgeLake datasources")
	}

	elDS, err := datasource.NewEdgeLakeDataSource(ds.Config.EdgeLake)
	if err != nil {
		return nil, fmt.Errorf("failed to create EdgeLake datasource: %w", err)
	}
	defer elDS.Close()

	columns, err := elDS.GetTableSchema(ctx, database, table)
	if err != nil {
		return nil, fmt.Errorf("failed to get table schema: %w", err)
	}

	return columns, nil
}

// GetMQTTTopics discovers available topics from an MQTT broker by subscribing briefly
func (s *DatasourceService) GetMQTTTopics(ctx context.Context, id string) ([]string, error) {
	ds, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}
	if ds.Type != models.DatasourceTypeMQTT || ds.Config.MQTT == nil {
		return nil, fmt.Errorf("datasource is not an MQTT connection")
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
func (s *DatasourceService) SampleMQTTTopic(ctx context.Context, datasourceID string, topic string) (map[string]interface{}, error) {
	ds, err := s.repo.FindByID(ctx, datasourceID)
	if err != nil {
		return nil, fmt.Errorf("failed to find datasource: %w", err)
	}
	if ds == nil {
		return nil, fmt.Errorf("datasource not found")
	}
	if ds.Type != models.DatasourceTypeMQTT || ds.Config.MQTT == nil {
		return nil, fmt.Errorf("datasource is not an MQTT connection")
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
func (s *DatasourceService) CreateAdapter(ctx context.Context, ds *models.Datasource) (registry.Adapter, error) {
	factory := datasource.NewDataSourceFactory()
	return factory.CreateAdapterFromConfig(ds)
}
