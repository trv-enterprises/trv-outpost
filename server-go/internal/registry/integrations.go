// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"sort"
	"sync"
)

// IntegrationInfo describes a named integration that bundles related types
// together so admins can enable or disable the whole bundle with one toggle.
//
// Each integration may "own" a connection type, one or more chart subtypes,
// one or more control subtypes, and one or more display subtypes. Member
// types declare their integration via the Integration field on TypeInfo /
// ComponentTypeInfo. The integrations registry mostly carries metadata for
// the settings UI and a list of connection type IDs that aren't otherwise
// registered as adapters (e.g., Frigate, which proxies through the API
// adapter rather than registering its own factory).
type IntegrationInfo struct {
	ID                  string   `json:"id"`                    // Stable identifier (e.g., "frigate", "casita")
	DisplayName         string   `json:"display_name"`          // Human-readable label
	Description         string   `json:"description,omitempty"` // One-line description for the settings UI
	OwnedConnectionType string   `json:"owned_connection_type,omitempty"` // Optional: connection type ID this integration adds beyond the standard adapter registry (e.g., "frigate")
	OwnedChartTypes     []string `json:"owned_chart_types,omitempty"`     // Subtype IDs of charts owned by this integration
	OwnedControlTypes   []string `json:"owned_control_types,omitempty"`   // Subtype IDs of controls owned by this integration
	OwnedDisplayTypes   []string `json:"owned_display_types,omitempty"`   // Subtype IDs of displays owned by this integration
}

type integrationRegistry struct {
	items map[string]IntegrationInfo
	mu    sync.RWMutex
}

var integrationGlobal = &integrationRegistry{
	items: make(map[string]IntegrationInfo),
}

// RegisterIntegration adds an integration to the global registry. Call from
// an init() function in the integration's owning package.
func RegisterIntegration(info IntegrationInfo) {
	integrationGlobal.mu.Lock()
	defer integrationGlobal.mu.Unlock()
	integrationGlobal.items[info.ID] = info
}

// ListIntegrations returns all registered integrations sorted by ID.
func ListIntegrations() []IntegrationInfo {
	integrationGlobal.mu.RLock()
	defer integrationGlobal.mu.RUnlock()

	out := make([]IntegrationInfo, 0, len(integrationGlobal.items))
	for _, info := range integrationGlobal.items {
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].ID < out[j].ID
	})
	return out
}

// GetIntegration returns a single integration by ID.
func GetIntegration(id string) (IntegrationInfo, bool) {
	integrationGlobal.mu.RLock()
	defer integrationGlobal.mu.RUnlock()
	info, ok := integrationGlobal.items[id]
	return info, ok
}

// IntegrationOwningConnectionType returns the integration ID that owns the
// given connection type (via OwnedConnectionType), or empty string if none.
// This lets the filter look up integration membership for connection types
// that aren't registered as adapters.
func IntegrationOwningConnectionType(typeID string) string {
	integrationGlobal.mu.RLock()
	defer integrationGlobal.mu.RUnlock()
	for _, info := range integrationGlobal.items {
		if info.OwnedConnectionType == typeID {
			return info.ID
		}
	}
	return ""
}
