// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Package registry provides a plugin-based adapter registration system for data sources.
// Adapters register themselves at init() time, enabling extensible connection types
// without modifying core code.
package registry

import (
	"context"
	"time"
)

// Capabilities describes what operations an adapter supports
type Capabilities struct {
	CanRead   bool `json:"can_read"`   // All adapters support reading
	CanWrite  bool `json:"can_write"`  // Bidirectional adapters only
	CanStream bool `json:"can_stream"` // Real-time subscription support
}

// Query represents a query to execute against a data source
type Query struct {
	Raw    string                 `json:"raw"`              // Raw query string (SQL, PromQL, filter, etc.)
	Params map[string]interface{} `json:"params,omitempty"` // Query parameters
}

// ResultSet represents normalized query results
type ResultSet struct {
	Columns  []string                 `json:"columns"`            // Column names
	Rows     [][]interface{}          `json:"rows"`               // Data rows
	Metadata map[string]interface{}   `json:"metadata,omitempty"` // Additional metadata
}

// Record represents a single record in a stream
type Record map[string]interface{}

// Command represents a write command for bidirectional adapters
type Command struct {
	Action  string                 `json:"action"`            // Command action (e.g., "set", "toggle", "send")
	Target  string                 `json:"target,omitempty"`  // Target identifier (e.g., device ID, channel)
	Payload map[string]interface{} `json:"payload,omitempty"` // Command payload data
}

// WriteResult represents the result of a write operation
type WriteResult struct {
	Success   bool                   `json:"success"`
	Message   string                 `json:"message,omitempty"`
	Data      map[string]interface{} `json:"data,omitempty"`
	Timestamp time.Time              `json:"timestamp"`
}

// ConfigField describes a configuration field for an adapter
type ConfigField struct {
	Name        string      `json:"name"`
	Type        string      `json:"type"`                  // string, int, bool, password, select
	Required    bool        `json:"required"`
	Default     interface{} `json:"default,omitempty"`
	Description string      `json:"description,omitempty"`
	Options     []string    `json:"options,omitempty"`     // For select type
}

// Adapter is the interface that all data source adapters must implement
type Adapter interface {
	// Metadata
	TypeID() string                        // e.g., "db.postgres", "stream.websocket"
	DisplayName() string                   // Human-readable name
	Capabilities() Capabilities            // What this adapter can do
	ConfigSchema() []ConfigField           // Configuration fields for UI

	// Lifecycle
	Connect(ctx context.Context) error     // Establish connection
	TestConnection(ctx context.Context) error // Verify connection works
	Close() error                          // Clean up resources

	// Data operations
	Query(ctx context.Context, query Query) (*ResultSet, error)
	Stream(ctx context.Context, query Query) (<-chan Record, error)
	Write(ctx context.Context, cmd Command) (*WriteResult, error)
}

// AdapterFactory creates an adapter from configuration
type AdapterFactory func(config map[string]interface{}) (Adapter, error)

// TypeInfo contains metadata about a registered adapter type
type TypeInfo struct {
	TypeID       string         `json:"type_id"`
	DisplayName  string         `json:"display_name"`
	Category     string         `json:"category"`      // e.g., "db", "stream", "api", "file", "store"
	Capabilities Capabilities   `json:"capabilities"`
	ConfigSchema []ConfigField  `json:"config_schema"`
	Integration  string         `json:"integration,omitempty"` // Optional: groups types under a named integration (e.g., "frigate", "casita")
}

// SchemaProvider is an optional interface for adapters that support schema discovery
type SchemaProvider interface {
	GetSchema(ctx context.Context) (interface{}, error)
}
