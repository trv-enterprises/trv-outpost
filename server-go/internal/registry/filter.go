// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"context"
	"sync"
	"time"
)

// Category constants used in filter calls. Connections use CategoryConnection
// (the registry already has CategoryChart/Control/Display for components).
const (
	CategoryConnection  = "connection"
	CategoryIntegration = "integration"
)

// EnabledTypes is the parsed shape of the `enabled_types` admin setting.
// Empty slices mean "nothing enabled in that category" — but since the seed
// routine populates every category on first boot, an empty slice in practice
// only happens if an admin actively disabled everything in that category.
type EnabledTypes struct {
	Integrations []string `json:"integrations"`
	Connections  []string `json:"connections"`
	Charts       []string `json:"charts"`
	Controls     []string `json:"controls"`
	Displays     []string `json:"displays"`
}

// EnabledTypesProvider is the minimal interface the filter needs to read the
// current enabled_types setting. The settings package implements this; the
// registry package stays free of service/repository imports to avoid cycles.
type EnabledTypesProvider interface {
	GetEnabledTypes(ctx context.Context) (*EnabledTypes, error)
}

// TypeFilter answers IsEnabled(category, id) lookups. It encapsulates the
// integration-toggle-wins semantics: a member of an integration that's
// disabled is always disabled, regardless of its own per-category entry.
type TypeFilter interface {
	IsEnabled(category, id string) bool
	IsIntegrationEnabled(id string) bool
	Snapshot(ctx context.Context) *EnabledTypes
	Invalidate()
}

// SettingsTypeFilter caches the parsed enabled_types setting and applies the
// filter rules. Cache TTL is short (~5s) so admin toggles propagate quickly
// without hammering Mongo. Invalidate() is also called by the settings
// service whenever enabled_types changes, making the cache mostly immediate.
type SettingsTypeFilter struct {
	provider EnabledTypesProvider
	ttl      time.Duration

	mu        sync.RWMutex
	cached    *EnabledTypes
	cachedAt  time.Time
}

// NewSettingsTypeFilter constructs a filter backed by the given provider.
// Default TTL is 5 seconds — short enough that even without explicit
// invalidation, admin saves take effect promptly.
func NewSettingsTypeFilter(provider EnabledTypesProvider) *SettingsTypeFilter {
	return &SettingsTypeFilter{
		provider: provider,
		ttl:      5 * time.Second,
	}
}

// Snapshot returns the current enabled_types, refreshing from the provider
// if the cache is stale or absent. On error, returns a permissive empty
// snapshot (all entries treated as not in any list — see IsEnabled).
func (f *SettingsTypeFilter) Snapshot(ctx context.Context) *EnabledTypes {
	f.mu.RLock()
	if f.cached != nil && time.Since(f.cachedAt) < f.ttl {
		out := f.cached
		f.mu.RUnlock()
		return out
	}
	f.mu.RUnlock()

	f.mu.Lock()
	defer f.mu.Unlock()
	// Re-check after acquiring the write lock.
	if f.cached != nil && time.Since(f.cachedAt) < f.ttl {
		return f.cached
	}
	if f.provider == nil {
		f.cached = &EnabledTypes{}
		f.cachedAt = time.Now()
		return f.cached
	}
	loaded, err := f.provider.GetEnabledTypes(ctx)
	if err != nil || loaded == nil {
		// Permissive fallback: empty struct means lookup-misses below; the
		// caller then sees nothing as enabled. The seed routine ensures this
		// is unusual — only happens before first boot completes.
		f.cached = &EnabledTypes{}
		f.cachedAt = time.Now()
		return f.cached
	}
	f.cached = loaded
	f.cachedAt = time.Now()
	return f.cached
}

// Invalidate clears the cache so the next Snapshot call refreshes from the
// provider. Called from the settings service after enabled_types is updated.
func (f *SettingsTypeFilter) Invalidate() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cached = nil
	f.cachedAt = time.Time{}
}

// IsIntegrationEnabled reports whether the given integration ID is in the
// enabled_types.integrations list.
func (f *SettingsTypeFilter) IsIntegrationEnabled(id string) bool {
	if id == "" {
		return true
	}
	snap := f.Snapshot(context.Background())
	return contains(snap.Integrations, id)
}

// IsEnabled applies the full filter logic for a (category, id) pair:
//
//  1. Look up the type's integration membership (via ComponentTypeInfo for
//     chart/control/display, or via the integration registry's
//     OwnedConnectionType for connections).
//  2. If the type belongs to an integration, it's only enabled when that
//     integration is in enabled_types.integrations.
//  3. The type's ID must also be in the corresponding per-category list.
//
// Returns true for empty IDs (defensive: nothing to filter).
func (f *SettingsTypeFilter) IsEnabled(category, id string) bool {
	if id == "" {
		return true
	}
	snap := f.Snapshot(context.Background())

	// Determine integration membership.
	integration := lookupIntegrationFor(category, id)
	if integration != "" && !contains(snap.Integrations, integration) {
		return false
	}

	switch category {
	case CategoryConnection:
		return contains(snap.Connections, id)
	case CategoryChart:
		return contains(snap.Charts, id)
	case CategoryControl:
		return contains(snap.Controls, id)
	case CategoryDisplay:
		return contains(snap.Displays, id)
	case CategoryIntegration:
		return contains(snap.Integrations, id)
	}
	return false
}

// lookupIntegrationFor returns the integration ID that owns the given
// (category, id). Components carry their integration field directly;
// connections go through the integration registry's OwnedConnectionType.
func lookupIntegrationFor(category, id string) string {
	switch category {
	case CategoryChart, CategoryControl, CategoryDisplay:
		// Component subtype IDs are bare (e.g., "frigate_camera"), but the
		// component registry keys are prefixed (e.g., "display.frigate_camera").
		// Try both forms.
		if info, ok := GetComponentType(category + "." + id); ok {
			return info.Integration
		}
		// Fallback: scan all in category for matching subtype.
		for _, info := range ListComponentTypes(category) {
			if info.Subtype == id {
				return info.Integration
			}
		}
	case CategoryConnection:
		// Adapter-registered types carry Integration on TypeInfo; synthetic
		// types (Frigate) are registered via the integration's
		// OwnedConnectionType field.
		if info, ok := GetTypeInfo(id); ok && info.Integration != "" {
			return info.Integration
		}
		return IntegrationOwningConnectionType(id)
	}
	return ""
}

// contains is a small string-slice helper used by the filter and friends.
func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
