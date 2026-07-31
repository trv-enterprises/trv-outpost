// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"fmt"
	"sort"
	"strings"
	"sync"
)

// Registry stores adapter factories by type ID
type Registry struct {
	factories map[string]AdapterFactory
	metadata  map[string]TypeInfo
	// querySurfaces holds surfaces declared by RegisterQuerySurface so a
	// declaration that arrives before its Register (init() order across
	// files is unspecified) still lands on the TypeInfo.
	querySurfaces map[string]QuerySurface
	mu            sync.RWMutex
}

// global is the default registry instance
var global = &Registry{
	factories:     make(map[string]AdapterFactory),
	metadata:      make(map[string]TypeInfo),
	querySurfaces: make(map[string]QuerySurface),
}

// Register adds an adapter factory to the global registry
// TypeID format: "category.name" (e.g., "db.postgres", "stream.websocket")
func Register(typeID string, displayName string, caps Capabilities, schema []ConfigField, factory AdapterFactory) {
	global.register(typeID, displayName, caps, schema, factory)
}

// RegisterQuerySurface attaches a query-authoring surface to a type,
// letting an adapter declare how its queries are composed alongside the
// Register call in its own init().
//
// Deliberately a separate call rather than another Register parameter:
// most types have no surface to declare, and threading a nil through
// eleven existing call sites buys nothing. Order-independent — init()
// ordering across files is unspecified, so this records the surface even
// if it lands before the matching Register and re-attaches it there.
func RegisterQuerySurface(typeID string, surface QuerySurface) {
	global.registerQuerySurface(typeID, surface)
}

func (r *Registry) registerQuerySurface(typeID string, surface QuerySurface) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.querySurfaces[typeID] = surface
	if info, ok := r.metadata[typeID]; ok {
		s := surface
		info.QuerySurface = &s
		r.metadata[typeID] = info
	}
}

// Get retrieves an adapter factory from the global registry
func Get(typeID string) (AdapterFactory, bool) {
	return global.get(typeID)
}

// List returns all registered type info sorted by type ID
func List() []TypeInfo {
	return global.list()
}

// ListByCategory returns all registered types for a specific category
func ListByCategory(category string) []TypeInfo {
	return global.listByCategory(category)
}

// Categories returns all unique categories
func Categories() []string {
	return global.categories()
}

// register adds an adapter factory to the registry
func (r *Registry) register(typeID string, displayName string, caps Capabilities, schema []ConfigField, factory AdapterFactory) {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Extract category from typeID (e.g., "db" from "db.postgres")
	category := ""
	if parts := strings.SplitN(typeID, ".", 2); len(parts) == 2 {
		category = parts[0]
	}

	r.factories[typeID] = factory
	info := TypeInfo{
		TypeID:       typeID,
		DisplayName:  displayName,
		Category:     category,
		Capabilities: caps,
		ConfigSchema: schema,
	}
	// Pick up a surface declared ahead of this Register call.
	if surface, ok := r.querySurfaces[typeID]; ok {
		s := surface
		info.QuerySurface = &s
	}
	r.metadata[typeID] = info
}

// get retrieves an adapter factory by type ID
func (r *Registry) get(typeID string) (AdapterFactory, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	factory, ok := r.factories[typeID]
	return factory, ok
}

// list returns all registered types sorted by type ID
func (r *Registry) list() []TypeInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	types := make([]TypeInfo, 0, len(r.metadata))
	for _, info := range r.metadata {
		types = append(types, info)
	}

	sort.Slice(types, func(i, j int) bool {
		return types[i].TypeID < types[j].TypeID
	})

	return types
}

// listByCategory returns all registered types for a specific category
func (r *Registry) listByCategory(category string) []TypeInfo {
	r.mu.RLock()
	defer r.mu.RUnlock()

	var types []TypeInfo
	for _, info := range r.metadata {
		if info.Category == category {
			types = append(types, info)
		}
	}

	sort.Slice(types, func(i, j int) bool {
		return types[i].TypeID < types[j].TypeID
	})

	return types
}

// categories returns all unique categories
func (r *Registry) categories() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	categorySet := make(map[string]bool)
	for _, info := range r.metadata {
		if info.Category != "" {
			categorySet[info.Category] = true
		}
	}

	categories := make([]string, 0, len(categorySet))
	for cat := range categorySet {
		categories = append(categories, cat)
	}
	sort.Strings(categories)

	return categories
}

// CreateAdapter creates an adapter using the registry
func CreateAdapter(typeID string, config map[string]interface{}) (Adapter, error) {
	factory, ok := Get(typeID)
	if !ok {
		return nil, fmt.Errorf("unknown adapter type: %s", typeID)
	}
	return factory(config)
}

// GetTypeInfo returns metadata for a specific type ID
func GetTypeInfo(typeID string) (TypeInfo, bool) {
	global.mu.RLock()
	defer global.mu.RUnlock()

	info, ok := global.metadata[typeID]
	return info, ok
}
