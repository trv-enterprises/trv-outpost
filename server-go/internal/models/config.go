// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import "time"

// ConfigScope represents the scope of a configuration
type ConfigScope string

const (
	ConfigScopeSystem ConfigScope = "system"
	ConfigScopeUser   ConfigScope = "user"
)

// AppConfig represents a configuration document stored in MongoDB
// Used for persistent settings that need to survive server restarts
type AppConfig struct {
	ID        string                 `json:"id" bson:"_id"`
	Scope     ConfigScope            `json:"scope" bson:"scope"`         // "system" or "user"
	UserID    string                 `json:"user_id,omitempty" bson:"user_id,omitempty"` // Only for user-scoped configs
	Settings  map[string]interface{} `json:"settings" bson:"settings"`   // Key-value settings
	Created   time.Time              `json:"created" bson:"created"`
	Updated   time.Time              `json:"updated" bson:"updated"`
}

// ConfigItem represents an individual user-configurable setting stored in MongoDB
// These settings are synced from user-configurable.yaml on first run and persist in the database
type ConfigItem struct {
	ID          string      `json:"id" bson:"_id"`                                       // Unique key (e.g., "layout_dimensions")
	Key         string      `json:"key" bson:"key"`                                      // Same as ID, for clarity
	Value       interface{} `json:"value" bson:"value"`                                  // The setting value
	Category    string      `json:"category,omitempty" bson:"category,omitempty"`        // Grouping category (e.g., "layout")
	Description string      `json:"description,omitempty" bson:"description,omitempty"`  // Human-readable description
	Created     time.Time   `json:"created" bson:"created"`
	Updated     time.Time   `json:"updated" bson:"updated"`
}

// SystemConfigResponse is the API response for system configuration
type SystemConfigResponse struct {
	Settings         map[string]interface{}        `json:"settings"`
	LayoutDimensions map[string]LayoutDimensionDTO `json:"layout_dimensions"`
	DefaultDimension string                        `json:"default_dimension"`
	// ClerkPublishableKey, when present, signals to the SPA that the
	// deployment is configured with Clerk-backed sign-in. The value is
	// the publishable key (`pk_test_…` or `pk_live_…`) needed to
	// initialize the React ClerkProvider. Empty string means Clerk is
	// disabled and the SPA uses the v0.8.5 bootstrap chain instead.
	ClerkPublishableKey string `json:"clerk_publishable_key,omitempty"`
}

// UserConfigResponse is the API response for user configuration
type UserConfigResponse struct {
	UserID   string                 `json:"user_id"`
	Settings map[string]interface{} `json:"settings"`
}

// LayoutDimensionDTO represents a layout dimension preset for API responses
type LayoutDimensionDTO struct {
	Name      string `json:"name"`
	MaxWidth  int    `json:"max_width"`
	MaxHeight int    `json:"max_height"`
	// DefaultScale is the default display-scale % for dashboards created
	// at this dimension (e.g. 120 = "our 4K screens look best at 120%").
	// New dashboards seed scale_percent from this; designer can override.
	// 0/absent = 100 (no scaling).
	DefaultScale int `json:"default_scale,omitempty"`
}

// UpdateConfigRequest is the request body for updating configuration
type UpdateConfigRequest struct {
	Settings map[string]interface{} `json:"settings" binding:"required"`
}

// Common system config keys
const (
	ConfigKeyCurrentDimension = "current_layout_dimension"
)

// SettingsListResponse is the API response for all user-configurable settings
type SettingsListResponse struct {
	Settings []ConfigItem `json:"settings"`
}

// UpdateSettingRequest is the request body for updating a single setting
type UpdateSettingRequest struct {
	Value interface{} `json:"value" binding:"required"`
}
