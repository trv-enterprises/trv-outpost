// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"go.mongodb.org/mongo-driver/bson/primitive"
)

const (
	// EnabledTypesKey is the settings key holding the admin's enabled-types
	// allowlist (across integrations and per-category subtype lists).
	EnabledTypesKey = "enabled_types"

	// KnownTypesKey is the settings key holding the server-maintained ledger
	// of every type/integration the system has ever seen. Used to detect new
	// types after upgrades so they can be enabled by default.
	KnownTypesKey = "known_types"
)

// EnabledTypesAdapter implements both registry.EnabledTypesProvider and
// registry.EnabledTypesUpdater on top of SettingsService. It also exposes
// an Invalidate-bridge so the settings handler can clear the type filter
// cache after a save.
type EnabledTypesAdapter struct {
	settings   *SettingsService
	invalidate func()
}

// NewEnabledTypesAdapter constructs an adapter. invalidate is called on
// successful writes so an attached registry.SettingsTypeFilter clears its
// cache. Pass a no-op when no filter is wired (tests).
func NewEnabledTypesAdapter(settings *SettingsService, invalidate func()) *EnabledTypesAdapter {
	if invalidate == nil {
		invalidate = func() {}
	}
	return &EnabledTypesAdapter{settings: settings, invalidate: invalidate}
}

// GetEnabledTypes implements registry.EnabledTypesProvider.
func (a *EnabledTypesAdapter) GetEnabledTypes(ctx context.Context) (*registry.EnabledTypes, error) {
	return a.read(ctx, EnabledTypesKey)
}

// GetKnownTypes implements the GetKnownTypes half of registry.EnabledTypesUpdater.
func (a *EnabledTypesAdapter) GetKnownTypes(ctx context.Context) (*registry.EnabledTypes, error) {
	return a.read(ctx, KnownTypesKey)
}

// SetEnabledTypes implements registry.EnabledTypesUpdater.
func (a *EnabledTypesAdapter) SetEnabledTypes(ctx context.Context, et *registry.EnabledTypes) error {
	return a.write(ctx, EnabledTypesKey, et, true)
}

// SetKnownTypes implements registry.EnabledTypesUpdater. Does NOT trigger an
// invalidate — known_types only affects the seed routine, not the live filter.
func (a *EnabledTypesAdapter) SetKnownTypes(ctx context.Context, et *registry.EnabledTypes) error {
	return a.write(ctx, KnownTypesKey, et, false)
}

func (a *EnabledTypesAdapter) read(ctx context.Context, key string) (*registry.EnabledTypes, error) {
	item, err := a.settings.GetSetting(ctx, key)
	if err != nil {
		// Missing setting → treat as empty so callers can proceed (the seed
		// routine will populate it).
		return &registry.EnabledTypes{}, nil
	}
	return parseEnabledTypes(item.Value), nil
}

func (a *EnabledTypesAdapter) write(ctx context.Context, key string, et *registry.EnabledTypes, invalidate bool) error {
	if et == nil {
		et = &registry.EnabledTypes{}
	}
	value := map[string]interface{}{
		"integrations": stringSlice(et.Integrations),
		"connections":  stringSlice(et.Connections),
		"charts":       stringSlice(et.Charts),
		"controls":     stringSlice(et.Controls),
		"displays":     stringSlice(et.Displays),
	}
	if _, err := a.settings.UpdateSetting(ctx, key, value); err != nil {
		return fmt.Errorf("update %s: %w", key, err)
	}
	if invalidate {
		a.invalidate()
	}
	return nil
}

// stringSlice returns the input slice or an empty slice if nil. Mongo / Viper
// round-trips treat nil and [] differently in some serializations, so we
// always write [] explicitly.
func stringSlice(in []string) []string {
	if in == nil {
		return []string{}
	}
	return in
}

// parseEnabledTypes accepts the polymorphic value shape that Viper / Mongo
// produces for the enabled_types setting and normalizes it to a typed
// EnabledTypes struct. The value is conceptually a map with five string-array
// fields, but it can come back as map[string]interface{}, bson.M, bson.D, or
// []interface{} depending on driver and serialization path.
func parseEnabledTypes(v interface{}) *registry.EnabledTypes {
	out := &registry.EnabledTypes{
		Integrations: []string{},
		Connections:  []string{},
		Charts:       []string{},
		Controls:     []string{},
		Displays:     []string{},
	}
	m := normalizeToMap(v)
	if m == nil {
		return out
	}
	out.Integrations = pickStringArray(m, "integrations")
	out.Connections = pickStringArray(m, "connections")
	out.Charts = pickStringArray(m, "charts")
	out.Controls = pickStringArray(m, "controls")
	out.Displays = pickStringArray(m, "displays")
	return out
}

// normalizeToMap converts polymorphic Mongo/Viper-decoded values into a flat
// map[string]interface{}. Mongo's BSON decoder produces primitive.D for
// nested documents when the target type is interface{}, so we unwrap that
// here. Recurses into nested values so primitive.D arrays of {Key, Value}
// pairs become array values directly.
func normalizeToMap(v interface{}) map[string]interface{} {
	switch x := v.(type) {
	case nil:
		return nil
	case map[string]interface{}:
		return x
	case primitive.M:
		return map[string]interface{}(x)
	case primitive.D:
		out := make(map[string]interface{}, len(x))
		for _, kv := range x {
			out[kv.Key] = kv.Value
		}
		return out
	}
	return nil
}

func pickStringArray(m map[string]interface{}, key string) []string {
	raw, ok := m[key]
	if !ok || raw == nil {
		return []string{}
	}
	switch arr := raw.(type) {
	case []string:
		return arr
	case []interface{}:
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case primitive.A:
		out := make([]string, 0, len(arr))
		for _, item := range arr {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return []string{}
}

// CatalogProvider is a thin adapter that builds the unified registry catalog
// using the installed device-type service and TypeFilter. Used by the AI
// agent so each user message rebuilds the prompt and tool enums from the
// current admin selections.
type CatalogProvider struct {
	deviceTypes registry.DeviceTypeLister
	filter      registry.TypeFilter
}

// NewCatalogProvider constructs a CatalogProvider.
func NewCatalogProvider(deviceTypes registry.DeviceTypeLister, filter registry.TypeFilter) *CatalogProvider {
	return &CatalogProvider{deviceTypes: deviceTypes, filter: filter}
}

// GetCatalog implements ai.CatalogProvider.
func (p *CatalogProvider) GetCatalog(ctx context.Context) (*registry.Catalog, error) {
	return registry.BuildCatalog(ctx, p.deviceTypes, p.filter)
}

// DeviceTypeListerAdapter adapts DeviceTypeService to registry.DeviceTypeLister.
// Mirrors the unexported version in registry_handler.go but lives here so the
// CatalogProvider in main.go can get a lister without reaching into handlers.
type DeviceTypeListerAdapter struct {
	Service *DeviceTypeService
}

// ListDeviceTypesForCatalog implements registry.DeviceTypeLister.
func (a *DeviceTypeListerAdapter) ListDeviceTypesForCatalog(ctx context.Context) ([]registry.DeviceTypeSummary, error) {
	if a.Service == nil {
		return nil, nil
	}
	resp, err := a.Service.ListDeviceTypes(ctx, &models.DeviceTypeQueryParams{Page: 1, PageSize: 500})
	if err != nil {
		return nil, err
	}
	out := make([]registry.DeviceTypeSummary, 0, len(resp.DeviceTypes))
	for _, dt := range resp.DeviceTypes {
		out = append(out, registry.DeviceTypeSummary{
			ID:             dt.ID,
			Name:           dt.Name,
			Description:    dt.Description,
			Category:       dt.Category,
			Protocol:       dt.Protocol,
			SupportedTypes: dt.SupportedTypes,
			IsBuiltIn:      dt.IsBuiltIn,
		})
	}
	return out, nil
}
