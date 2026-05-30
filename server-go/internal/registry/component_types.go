// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"context"
	"sort"
	"sync"
)

// Component category constants. These match the frontend `component_type`
// discriminator on the charts collection (see docs/architecture/data-model.md).
const (
	CategoryChart   = "chart"
	CategoryControl = "control"
	CategoryDisplay = "display"
)

// ComponentCapabilities describes what a component subtype can do. This is a
// superset of the connection-side Capabilities — components have their own
// dimensions (can they read live state, can they send commands, do they
// require a device_type to interpret commands, etc).
type ComponentCapabilities struct {
	CanRead            bool `json:"can_read"`             // Subscribes to live state
	CanWrite           bool `json:"can_write"`            // Sends commands
	RequiresDeviceType bool `json:"requires_device_type"` // Needs a device_type_id to translate commands
	SupportsStreaming  bool `json:"supports_streaming"`   // Consumes streaming data (as opposed to polling)
	RequiresConnection bool `json:"requires_connection"`  // Must be bound to a connection (false for e.g. text labels)
}

// DataRequirements describes the data shape a chart subtype expects. Only
// chart components set this — controls and displays leave it nil. The
// frontend ChartEditor has an equivalent CHART_TYPE_CONFIG shape; this
// struct is the backend source of truth that both the MCP server and the
// frontend (via /api/meta/types) consume.
type DataRequirements struct {
	RequiresXAxis     bool   `json:"requires_x_axis"`
	RequiresYAxis     bool   `json:"requires_y_axis"`
	MultipleYAxis     bool   `json:"multiple_y_axis"`
	HasSeriesColumn   bool   `json:"has_series_column"`
	HasAxisLabels     bool   `json:"has_axis_labels"`
	HasXAxisFormat    bool   `json:"has_x_axis_format"`
	HasTimeBucket     bool   `json:"has_time_bucket"`
	HasSortLimit      bool   `json:"has_sort_limit"`
	HasVisibleColumns bool   `json:"has_visible_columns"`
	HasReferenceLevels bool  `json:"has_reference_levels,omitempty"` // Banded-bar style: show the reference-levels editor (value + label + kind rows)
	XAxisLabel        string `json:"x_axis_label,omitempty"` // UI label hint: "X-Axis (Categories)", "Category Column", etc.
	YAxisLabel        string `json:"y_axis_label,omitempty"`
}

// ComponentTypeInfo is the metadata for a chart/control/display subtype.
// Unlike connection TypeInfo, component types have no Go factory — the
// actual rendering lives on the frontend as a React component. The registry
// exists so the AI builder, the MCP server, and /api/meta/types all read
// from one place instead of duplicating lists.
type ComponentTypeInfo struct {
	TypeID           string                 `json:"type_id"`                     // "chart.bar", "control.toggle", "display.frigate"
	Category         string                 `json:"category"`                    // CategoryChart | CategoryControl | CategoryDisplay
	Subtype          string                 `json:"subtype"`                     // "bar", "toggle", "frigate" — the value stored in chart_type / control_type / display_type
	DisplayName      string                 `json:"display_name"`                // Human-readable label
	Description      string                 `json:"description"`                 // One-line description for selection UIs and AI prompts
	Icon             string                 `json:"icon,omitempty"`              // MDI icon name (e.g. "mdiGestureTap"); frontend resolves to an SVG path
	UICategory       string                 `json:"ui_category,omitempty"`       // Grouping for widget picker: "carbon", "custom", "tile", "decorative"
	Hidden           bool                   `json:"hidden,omitempty"`            // True for legacy aliases and backward-compat types kept so old records still edit
	Integration      string                 `json:"integration,omitempty"`       // Optional: groups types under a named integration (e.g., "frigate", "casita")
	Capabilities     ComponentCapabilities  `json:"capabilities"`
	ConfigSchema     []ConfigField          `json:"config_schema,omitempty"`     // Fields the component exposes in the editor
	DataRequirements *DataRequirements      `json:"data_requirements,omitempty"` // Charts only
	DefaultConfig    map[string]interface{} `json:"default_config,omitempty"`    // Seed values for a freshly-created instance
}

// ComponentSource is the pluggable source of component type metadata. Today
// only CodeSource (compile-time registrations) exists. A future MongoDB-backed
// source can be added without touching any consumer.
type ComponentSource interface {
	ListComponentTypes(ctx context.Context) ([]ComponentTypeInfo, error)
	GetComponentType(ctx context.Context, typeID string) (ComponentTypeInfo, bool, error)
}

// componentRegistry is the in-memory component type registry populated by
// per-category init() functions in chart_types.go, control_types.go, and
// display_types.go.
type componentRegistry struct {
	types map[string]ComponentTypeInfo
	mu    sync.RWMutex
}

var componentGlobal = &componentRegistry{
	types: make(map[string]ComponentTypeInfo),
}

// RegisterComponentType registers a component type into the global component
// registry. Call from an init() function in a file that defines the type.
func RegisterComponentType(info ComponentTypeInfo) {
	componentGlobal.mu.Lock()
	defer componentGlobal.mu.Unlock()
	componentGlobal.types[info.TypeID] = info
}

// ListComponentTypes returns all registered component types sorted by TypeID.
// Pass Category filter as empty string to get everything.
func ListComponentTypes(category string) []ComponentTypeInfo {
	componentGlobal.mu.RLock()
	defer componentGlobal.mu.RUnlock()

	out := make([]ComponentTypeInfo, 0, len(componentGlobal.types))
	for _, info := range componentGlobal.types {
		if category != "" && info.Category != category {
			continue
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].TypeID < out[j].TypeID
	})
	return out
}

// GetComponentType returns a single component type by TypeID (e.g. "chart.bar").
func GetComponentType(typeID string) (ComponentTypeInfo, bool) {
	componentGlobal.mu.RLock()
	defer componentGlobal.mu.RUnlock()
	info, ok := componentGlobal.types[typeID]
	return info, ok
}

// IsSpecDrivenChart reports whether a chart subtype (e.g. "line", "bar",
// "banded_bar") renders via the client's spec-driven path rather than
// hand-written custom code. A type is spec-driven iff it is a registered
// canonical chart type and is NOT "custom" — every canonical chart type
// now has a buildOption module on the frontend.
//
// This is the server-side contract for the render-side list. The
// authoritative list of chart types that actually have a buildOption is
// the frontend BUILD_OPTIONS map in
// client/src/chart-spec/build-options.js; this registry must stay in
// sync with it (chart_types.go already carries that "keep in sync"
// obligation for every canonical type). Callers that emit component_code
// (component_service create path, the spec-code migration) use this to
// decide whether to write the <SpecDrivenChart> one-liner.
func IsSpecDrivenChart(subtype string) bool {
	if subtype == "" || subtype == "custom" {
		return false
	}
	info, ok := GetComponentType("chart." + subtype)
	return ok && info.Category == CategoryChart
}

// CodeSource is a ComponentSource backed by the compile-time component
// registry. It's the default source used today; a MongoDB source can be
// layered on later without changing consumers.
type CodeSource struct{}

// NewCodeSource returns a CodeSource that reads from the global registry.
func NewCodeSource() *CodeSource {
	return &CodeSource{}
}

// ListComponentTypes implements ComponentSource.
func (s *CodeSource) ListComponentTypes(ctx context.Context) ([]ComponentTypeInfo, error) {
	return ListComponentTypes(""), nil
}

// GetComponentType implements ComponentSource.
func (s *CodeSource) GetComponentType(ctx context.Context, typeID string) (ComponentTypeInfo, bool, error) {
	info, ok := GetComponentType(typeID)
	return info, ok, nil
}
