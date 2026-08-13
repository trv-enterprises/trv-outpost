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
	Columns  []string               `json:"columns"`            // Column names
	Rows     [][]interface{}        `json:"rows"`               // Data rows
	Metadata map[string]interface{} `json:"metadata,omitempty"` // Additional metadata
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
	Type        string      `json:"type"` // string, int, bool, password, select
	Required    bool        `json:"required"`
	Default     interface{} `json:"default,omitempty"`
	Description string      `json:"description,omitempty"`
	Options     []string    `json:"options,omitempty"` // For select type
}

// Adapter is the interface that all data source adapters must implement
type Adapter interface {
	// Metadata
	TypeID() string              // e.g., "db.postgres", "stream.websocket"
	DisplayName() string         // Human-readable name
	Capabilities() Capabilities  // What this adapter can do
	ConfigSchema() []ConfigField // Configuration fields for UI

	// Lifecycle
	Connect(ctx context.Context) error        // Establish connection
	TestConnection(ctx context.Context) error // Verify connection works
	Close() error                             // Clean up resources

	// Data operations
	Query(ctx context.Context, query Query) (*ResultSet, error)
	Stream(ctx context.Context, query Query) (<-chan Record, error)
	Write(ctx context.Context, cmd Command) (*WriteResult, error)
}

// AdapterFactory creates an adapter from configuration
type AdapterFactory func(config map[string]interface{}) (Adapter, error)

// QuerySurfaceKind identifies how a type's query is authored, and so
// which renderer the editor uses. Adding a kind is additive: a client
// that doesn't recognize one falls back to the plain raw box, which is
// exactly the behavior every type has today.
const (
	// QuerySurfaceCatalog — the query is chosen from a fixed list of
	// named presets. The preset carries the full raw+params tuple, so
	// the user picks a thing to look at and never sees dispatch
	// mechanics. Used by adapters that front a fixed RPC-ish API set
	// rather than a query language.
	QuerySurfaceCatalog = "catalog"

	// QuerySurfaceStoreList — the type supports a per-component store
	// choice, orthogonal to the query itself: the backend endpoint hosts
	// multiple named stores and a component on an endpoint-scoped
	// connection names one in query_config.params.store. The store list
	// is per-connection dynamic (scoped to the connection's key), so it
	// is NOT carried as static presets here — the editor fetches it from
	// GET /api/connections/:id/stores (adapters implementing StoreLister)
	// and renders a store picker when the selected connection has no
	// pinned store. (#248)
	QuerySurfaceStoreList = "store_list"
)

// QueryPreset is one named, ready-to-run query: a human label plus the
// exact Raw + Params the adapter needs to execute it.
//
// The point of holding Params here rather than in the UI is that these
// are DISPATCH MECHANICS, not user knobs — a Synology DSM call needs
// method/version/result_path/additional to be exactly right or the API
// returns an error, and no user should be asked to know them. Keeping
// them adapter-side also means the correct values ship with the adapter
// that consumes them, instead of being restated in the client.
type QueryPreset struct {
	ID          string                 `json:"id"`                    // Stable identifier, unique within the surface
	Label       string                 `json:"label"`                 // Human-readable, shown in the picker
	Description string                 `json:"description,omitempty"` // Optional one-liner about what it returns
	Raw         string                 `json:"raw"`                   // Query.Raw to send
	Params      map[string]interface{} `json:"params,omitempty"`      // Query.Params to send
}

// QuerySurface describes how a connection type's query is authored, so
// the editor can render a real input surface instead of falling back to
// a bare raw text box.
//
// This is metadata ABOUT authoring, declared by the adapter that owns
// the query semantics — the adapter is the only place that knows what a
// valid query for it looks like, so it is the right place to say so.
// Types that don't declare one keep the existing raw-box behavior.
//
// Kind is the forward-compatibility seam: today only "catalog" exists,
// but a type with modes and dependent fields can declare a new kind and
// grow its own renderer without reshaping what already ships.
type QuerySurface struct {
	Kind        string        `json:"kind"`                  // One of the QuerySurface* constants
	Label       string        `json:"label,omitempty"`       // Field label for the picker (e.g. "DSM API")
	Description string        `json:"description,omitempty"` // Optional helper text under the control
	Presets     []QueryPreset `json:"presets,omitempty"`     // Kind == "catalog": the selectable queries
}

// TypeInfo contains metadata about a registered adapter type
type TypeInfo struct {
	TypeID       string        `json:"type_id"`
	DisplayName  string        `json:"display_name"`
	Category     string        `json:"category"` // e.g., "db", "stream", "api", "file", "store"
	Capabilities Capabilities  `json:"capabilities"`
	ConfigSchema []ConfigField `json:"config_schema"`
	Integration  string        `json:"integration,omitempty"` // Optional: groups types under a named integration (e.g., "frigate", "casita")
	// QuerySurface is nil for types that have no declared authoring
	// surface — the editor renders its raw query box for those, which
	// is the behavior every type had before this field existed.
	QuerySurface *QuerySurface `json:"query_surface,omitempty"`
}

// SchemaProvider is an optional interface for adapters that support schema discovery
type SchemaProvider interface {
	GetSchema(ctx context.Context) (interface{}, error)
}

// StoreInfo is one entry from a multi-store backend's store listing,
// mirroring ts-store's GET /api/stores response (v0.20.0-rc.2+): identity,
// role, per-store data type, and the caller's effective access classes on
// that store ("read"/"write"/"manage" — independent flags, not a hierarchy).
// Consumers filter on Access: the component editor's store picker wants
// "read", the alerts wizard wants "manage".
type StoreInfo struct {
	Name     string   `json:"name"`
	DataType string   `json:"data_type,omitempty"`
	Role     string   `json:"role,omitempty"`      // "store" | "source" | "rollup"
	RollupOf string   `json:"rollup_of,omitempty"` // set when Role == "rollup"
	Window   string   `json:"window,omitempty"`    // set when Role == "rollup"
	Access   []string `json:"access,omitempty"`
}

// StoreLister is an optional interface for adapters whose backend hosts
// multiple named stores discoverable at runtime (declared alongside a
// QuerySurfaceStoreList surface). The listing is scoped server-side to what
// the connection's credentials can see — it backs GET
// /api/connections/:id/stores so the key never reaches the browser. (#248)
type StoreLister interface {
	ListStores(ctx context.Context) ([]StoreInfo, error)
}
