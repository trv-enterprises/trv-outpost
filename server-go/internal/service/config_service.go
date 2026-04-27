// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/config"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

// ConfigService handles business logic for app configuration
type ConfigService struct {
	repo                *repository.ConfigRepository
	settingsRepo        *repository.SettingsItemRepository
	layoutDimensions    map[string]config.LayoutDimension // fallback from config file
	clerkPublishableKey string                            // empty when Clerk auth is disabled
}

// NewConfigService creates a new ConfigService. clerkPublishableKey
// is non-empty only when the deployment has Clerk auth enabled. The
// value flows through to the SPA via /api/config/system so the React
// ClerkProvider can initialize without needing its own env var.
func NewConfigService(repo *repository.ConfigRepository, settingsRepo *repository.SettingsItemRepository, cfg *config.Config, clerkPublishableKey string) *ConfigService {
	return &ConfigService{
		repo:                repo,
		settingsRepo:        settingsRepo,
		layoutDimensions:    cfg.LayoutDimensions,
		clerkPublishableKey: clerkPublishableKey,
	}
}

// getLayoutDimensions reads layout dimensions from settings DB, falling back to config file
func (s *ConfigService) getLayoutDimensions(ctx context.Context) (map[string]models.LayoutDimensionDTO, string) {
	dimensions := make(map[string]models.LayoutDimensionDTO)
	defaultDimension := ""

	// Try reading from settings DB first (user-editable via Settings UI)
	if s.settingsRepo != nil {
		if item, err := s.settingsRepo.GetSettingByKey(ctx, "layout_dimensions"); err == nil && item != nil {
			var dimList []interface{}
			switch v := item.Value.(type) {
			case primitive.A:
				dimList = []interface{}(v)
			case []interface{}:
				dimList = v
			}
			if dimList != nil {
				for _, entry := range dimList {
					parsed := parseDimensionEntry(entry)
					if parsed == nil {
						continue
					}
					dimensions[parsed.Name] = *parsed
					if defaultDimension == "" {
						defaultDimension = parsed.Name
					}
				}
			}
		}

		// Read default dimension from settings DB
		if item, err := s.settingsRepo.GetSettingByKey(ctx, "default_layout_dimension"); err == nil && item != nil {
			if name, ok := item.Value.(string); ok && name != "" {
				defaultDimension = name
			}
		}
	}

	// Fall back to config file if nothing in DB
	if len(dimensions) == 0 {
		for name, dim := range s.layoutDimensions {
			dimensions[name] = models.LayoutDimensionDTO{
				Name:      name,
				MaxWidth:  dim.MaxWidth,
				MaxHeight: dim.MaxHeight,
			}
			if defaultDimension == "" {
				defaultDimension = name
			}
		}
	}

	return dimensions, defaultDimension
}

// toFieldMap normalizes various BSON/JSON types into a flat map[string]interface{}.
// Handles: map[string]interface{}, primitive.M, primitive.D
func toFieldMap(v interface{}) map[string]interface{} {
	switch m := v.(type) {
	case map[string]interface{}:
		return m
	case primitive.M:
		return map[string]interface{}(m)
	case primitive.D:
		result := make(map[string]interface{}, len(m))
		for _, e := range m {
			result[e.Key] = e.Value
		}
		return result
	default:
		return nil
	}
}

// parseDimensionEntry parses a dimension entry from either format:
// - Flat map/primitive.D: {name: "1920x1080", max_width: 1920, max_height: 1080}
// - Viper Key/Value pairs (primitive.A of primitive.D): [{Key: "name", Value: "1920x1080"}, ...]
func parseDimensionEntry(entry interface{}) *models.LayoutDimensionDTO {
	// Try flat map/document format first
	if fields := toFieldMap(entry); fields != nil {
		name, _ := fields["name"].(string)
		if name == "" {
			return nil
		}
		maxWidth := toInt(fields["max_width"])
		maxHeight := toInt(fields["max_height"])
		if maxWidth > 0 && maxHeight > 0 {
			return &models.LayoutDimensionDTO{Name: name, MaxWidth: maxWidth, MaxHeight: maxHeight}
		}
		return nil
	}

	// Try Viper Key/Value array format: [{Key: "name", Value: "..."}, {Key: "max_width", Value: 1920}, ...]
	var kvList []interface{}
	switch a := entry.(type) {
	case primitive.A:
		kvList = []interface{}(a)
	case []interface{}:
		kvList = a
	default:
		return nil
	}

	fields := make(map[string]interface{})
	for _, kv := range kvList {
		kvMap := toFieldMap(kv)
		if kvMap == nil {
			continue
		}
		key, _ := kvMap["Key"].(string)
		if key == "" {
			continue
		}
		fields[key] = kvMap["Value"]
	}
	name, _ := fields["name"].(string)
	if name == "" {
		return nil
	}
	maxWidth := toInt(fields["max_width"])
	maxHeight := toInt(fields["max_height"])
	if maxWidth > 0 && maxHeight > 0 {
		return &models.LayoutDimensionDTO{Name: name, MaxWidth: maxWidth, MaxHeight: maxHeight}
	}
	return nil
}

// toInt converts various numeric types to int
func toInt(v interface{}) int {
	switch n := v.(type) {
	case int:
		return n
	case int32:
		return int(n)
	case int64:
		return int(n)
	case float64:
		return int(n)
	case float32:
		return int(n)
	default:
		return 0
	}
}

// GetSystemConfig retrieves system configuration with layout dimensions
func (s *ConfigService) GetSystemConfig(ctx context.Context) (*models.SystemConfigResponse, error) {
	appConfig, err := s.repo.GetSystemConfig(ctx)
	if err != nil {
		return nil, err
	}

	dimensions, defaultDimension := s.getLayoutDimensions(ctx)

	// If no current dimension is set, use the default
	if appConfig.Settings == nil {
		appConfig.Settings = make(map[string]interface{})
	}
	if _, exists := appConfig.Settings[models.ConfigKeyCurrentDimension]; !exists {
		appConfig.Settings[models.ConfigKeyCurrentDimension] = defaultDimension
	}

	return &models.SystemConfigResponse{
		Settings:            appConfig.Settings,
		LayoutDimensions:    dimensions,
		DefaultDimension:    defaultDimension,
		ClerkPublishableKey: s.clerkPublishableKey,
	}, nil
}

// UpdateSystemConfig updates system configuration
func (s *ConfigService) UpdateSystemConfig(ctx context.Context, settings map[string]interface{}) (*models.SystemConfigResponse, error) {
	// Validate dimension setting if provided
	if dimValue, exists := settings[models.ConfigKeyCurrentDimension]; exists {
		dimName, ok := dimValue.(string)
		if !ok {
			return nil, fmt.Errorf("invalid dimension value type")
		}
		dimensions, _ := s.getLayoutDimensions(ctx)
		if _, valid := dimensions[dimName]; !valid {
			return nil, fmt.Errorf("invalid dimension: %s", dimName)
		}
	}

	_, err := s.repo.UpsertSystemConfig(ctx, settings)
	if err != nil {
		return nil, err
	}

	return s.GetSystemConfig(ctx)
}

// GetCurrentDimension gets the current layout dimension
func (s *ConfigService) GetCurrentDimension(ctx context.Context) (string, *config.LayoutDimension, error) {
	appConfig, err := s.repo.GetSystemConfig(ctx)
	if err != nil {
		return "", nil, err
	}

	dimensions, defaultDimension := s.getLayoutDimensions(ctx)

	// Get current dimension name
	dimName := ""
	if appConfig.Settings != nil {
		if val, exists := appConfig.Settings[models.ConfigKeyCurrentDimension]; exists {
			dimName, _ = val.(string)
		}
	}

	// Default to first dimension if not set
	if dimName == "" {
		dimName = defaultDimension
	}

	dim, exists := dimensions[dimName]
	if !exists {
		return "", nil, fmt.Errorf("dimension not found: %s", dimName)
	}

	return dimName, &config.LayoutDimension{MaxWidth: dim.MaxWidth, MaxHeight: dim.MaxHeight}, nil
}

// ValidatePanelBounds checks if panels fit within the given dimension
func (s *ConfigService) ValidatePanelBounds(ctx context.Context, panels []models.DashboardPanel, dimensionName string) error {
	dimensions, _ := s.getLayoutDimensions(ctx)

	dim, exists := dimensions[dimensionName]
	if !exists {
		return fmt.Errorf("invalid dimension: %s", dimensionName)
	}

	for _, panel := range panels {
		panelRight := panel.X + panel.W
		panelBottom := panel.Y + panel.H

		if panelRight > dim.MaxWidth {
			return fmt.Errorf("panel '%s' exceeds max width: panel ends at %d, max is %d",
				panel.ID, panelRight, dim.MaxWidth)
		}
		if panelBottom > dim.MaxHeight {
			return fmt.Errorf("panel '%s' exceeds max height: panel ends at %d, max is %d",
				panel.ID, panelBottom, dim.MaxHeight)
		}
	}

	return nil
}

// GetUserConfig retrieves user-specific configuration
func (s *ConfigService) GetUserConfig(ctx context.Context, userID string) (*models.UserConfigResponse, error) {
	appConfig, err := s.repo.GetUserConfig(ctx, userID)
	if err != nil {
		return nil, err
	}

	return &models.UserConfigResponse{
		UserID:   userID,
		Settings: appConfig.Settings,
	}, nil
}

// UpdateUserConfig updates user-specific configuration
func (s *ConfigService) UpdateUserConfig(ctx context.Context, userID string, settings map[string]interface{}) (*models.UserConfigResponse, error) {
	_, err := s.repo.UpsertUserConfig(ctx, userID, settings)
	if err != nil {
		return nil, err
	}

	return s.GetUserConfig(ctx, userID)
}
