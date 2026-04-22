// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package config

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Config holds all configuration
type Config struct {
	Server           ServerConfig                `mapstructure:"server"`
	MongoDB          MongoDBConfig               `mapstructure:"mongodb"`
	WebSocket        WebSocketConfig             `mapstructure:"websocket"`
	LLM              LLMConfig                   `mapstructure:"llm"`
	Validation       ValidationConfig            `mapstructure:"validation"`
	Dashboard        DashboardConfig             `mapstructure:"dashboard"`
	Layout           LayoutConfig                `mapstructure:"layout"`
	LayoutDimensions map[string]LayoutDimension  `mapstructure:"layout_dimensions"`
	Logging          LoggingConfig               `mapstructure:"logging"`
	CORS             CORSConfig                  `mapstructure:"cors"`
	Swagger          SwaggerConfig               `mapstructure:"swagger"`
	StaticFiles      StaticFilesConfig           `mapstructure:"static_files"`
	Settings         []SettingDefinition         `mapstructure:"settings"`
}

// SettingDefinition represents a configuration setting definition in the YAML file
// Used for frontend-visible settings that can be stored/modified in MongoDB
type SettingDefinition struct {
	Key         string      `mapstructure:"key" json:"key"`                 // Unique identifier for the setting
	Value       interface{} `mapstructure:"value" json:"value"`             // The setting value
	Category    string      `mapstructure:"category" json:"category"`       // Grouping category (e.g., "layout", "dashboard")
	Description string      `mapstructure:"description" json:"description"` // Human-readable description for UI
}

// UserConfigurableSettings holds settings loaded from user-configurable.yaml
type UserConfigurableSettings struct {
	Settings []SettingDefinition `mapstructure:"settings"`
}

// DashboardConfig holds dashboard-specific settings
type DashboardConfig struct {
	ConfigRefreshInterval int `mapstructure:"config_refresh_interval" json:"config_refresh_interval"` // seconds
}

// LayoutDimension represents a preset layout dimension
type LayoutDimension struct {
	MaxWidth  int `mapstructure:"max_width" json:"max_width"`
	MaxHeight int `mapstructure:"max_height" json:"max_height"`
}

type ServerConfig struct {
	Port            int           `mapstructure:"port"`
	Host            string        `mapstructure:"host"`
	Mode            string        `mapstructure:"mode"`
	ReadTimeout     time.Duration `mapstructure:"read_timeout"`
	WriteTimeout    time.Duration `mapstructure:"write_timeout"`
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout"`
}

type MongoDBConfig struct {
	URI               string        `mapstructure:"uri"`
	Database          string        `mapstructure:"database"`
	ConnectionTimeout time.Duration `mapstructure:"connection_timeout"`
	MaxPoolSize       uint64        `mapstructure:"max_pool_size"`
	MinPoolSize       uint64        `mapstructure:"min_pool_size"`
}

type WebSocketConfig struct {
	ReadBufferSize  int           `mapstructure:"read_buffer_size"`
	WriteBufferSize int           `mapstructure:"write_buffer_size"`
	PingInterval    time.Duration `mapstructure:"ping_interval"`
	PongWait        time.Duration `mapstructure:"pong_wait"`
	WriteWait       time.Duration `mapstructure:"write_wait"`
}

type LLMConfig struct {
	Provider    string        `mapstructure:"provider"`
	APIKey      string        `mapstructure:"api_key"`
	Model       string        `mapstructure:"model"`
	MaxTokens   int           `mapstructure:"max_tokens"`
	Temperature float64       `mapstructure:"temperature"`
	Timeout     time.Duration `mapstructure:"timeout"`
	BaseURL     string        `mapstructure:"base_url"`
}

type ValidationConfig struct {
	MaxCodeSize       int      `mapstructure:"max_code_size"`
	DangerousPatterns []string `mapstructure:"dangerous_patterns"`
	AllowedImports    []string `mapstructure:"allowed_imports"`
}

type LayoutConfig struct {
	Spacing            int `mapstructure:"spacing"`
	MaxWidth           int `mapstructure:"max_width"`
	MaxHeight          int `mapstructure:"max_height"`
	DefaultPanelWidth  int `mapstructure:"default_panel_width"`
	DefaultPanelHeight int `mapstructure:"default_panel_height"`
	MinPanelWidth      int `mapstructure:"min_panel_width"`
	MinPanelHeight     int `mapstructure:"min_panel_height"`
	MaxPanelWidth      int `mapstructure:"max_panel_width"`
	MaxPanelHeight     int `mapstructure:"max_panel_height"`
}

type LoggingConfig struct {
	Level    string `mapstructure:"level"`
	Format   string `mapstructure:"format"`
	Output   string `mapstructure:"output"`
	FilePath string `mapstructure:"file_path"`
}

type CORSConfig struct {
	AllowedOrigins   []string `mapstructure:"allowed_origins"`
	AllowedMethods   []string `mapstructure:"allowed_methods"`
	AllowedHeaders   []string `mapstructure:"allowed_headers"`
	ExposeHeaders    []string `mapstructure:"expose_headers"`
	AllowCredentials bool     `mapstructure:"allow_credentials"`
	MaxAge           int      `mapstructure:"max_age"`
}

type SwaggerConfig struct {
	Enabled      bool     `mapstructure:"enabled"`
	Title        string   `mapstructure:"title"`
	Version      string   `mapstructure:"version"`
	Description  string   `mapstructure:"description"`
	Host         string   `mapstructure:"host"`
	BasePath     string   `mapstructure:"base_path"`
	Schemes      []string `mapstructure:"schemes"`
	ContactName  string   `mapstructure:"contact_name"`
	ContactEmail string   `mapstructure:"contact_email"`
}

type StaticFilesConfig struct {
	Enabled bool   `mapstructure:"enabled"`
	Path    string `mapstructure:"path"`
}

// Load loads configuration from file and environment variables
func Load() (*Config, error) {
	// Set config file name and paths
	viper.SetConfigName("config")
	viper.SetConfigType("yaml")
	viper.AddConfigPath("./config")
	viper.AddConfigPath(".")
	viper.AddConfigPath("/etc/dashboard")

	// Read base config
	if err := viper.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("failed to read config file: %w", err)
	}

	// Get environment (from ENV var or default to development)
	env := viper.GetString("ENV")
	if env == "" {
		env = "development"
	}

	// Merge environment-specific config
	viper.SetConfigName(fmt.Sprintf("config.%s", env))
	if err := viper.MergeInConfig(); err != nil {
		// It's okay if env-specific config doesn't exist
		fmt.Printf("No environment-specific config found for %s (this is optional)\n", env)
	}

	// Enable environment variable override
	viper.AutomaticEnv()
	viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	viper.SetEnvPrefix("DASHBOARD") // Prefix all env vars with DASHBOARD_

	// Unmarshal into Config struct
	var cfg Config
	if err := viper.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("failed to unmarshal config: %w", err)
	}

	// Validate configuration
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("invalid configuration: %w", err)
	}

	return &cfg, nil
}

// Validate validates the configuration
func (c *Config) Validate() error {
	if c.Server.Port < 1 || c.Server.Port > 65535 {
		return fmt.Errorf("invalid server port: %d", c.Server.Port)
	}

	if c.MongoDB.URI == "" {
		return fmt.Errorf("mongodb uri is required")
	}

	if c.MongoDB.Database == "" {
		return fmt.Errorf("mongodb database name is required")
	}

	if c.Server.Mode != "debug" && c.Server.Mode != "release" {
		return fmt.Errorf("invalid server mode: %s (must be 'debug' or 'release')", c.Server.Mode)
	}

	return nil
}

// LoadUserConfigurableSettings loads user-configurable settings from a separate YAML file
// These are settings that administrators can modify through the UI
func LoadUserConfigurableSettings() (*UserConfigurableSettings, error) {
	v := viper.New()
	v.SetConfigName("user-configurable")
	v.SetConfigType("yaml")
	v.AddConfigPath("./config")
	v.AddConfigPath(".")
	v.AddConfigPath("/etc/dashboard")

	if err := v.ReadInConfig(); err != nil {
		return nil, fmt.Errorf("failed to read user-configurable config file: %w", err)
	}

	var settings UserConfigurableSettings
	if err := v.Unmarshal(&settings); err != nil {
		return nil, fmt.Errorf("failed to unmarshal user-configurable settings: %w", err)
	}

	return &settings, nil
}
