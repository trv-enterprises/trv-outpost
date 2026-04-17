// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"context"
)

// EnabledTypesUpdater is the minimal interface seed needs to write the
// enabled_types and known_types settings. The settings package provides the
// implementation; the registry package stays free of service imports.
type EnabledTypesUpdater interface {
	GetEnabledTypes(ctx context.Context) (*EnabledTypes, error)
	GetKnownTypes(ctx context.Context) (*EnabledTypes, error)
	SetEnabledTypes(ctx context.Context, et *EnabledTypes) error
	SetKnownTypes(ctx context.Context, et *EnabledTypes) error
}

// SeedKnownAndEnabledTypes scans the active registries for any
// types/integrations that aren't in the known_types ledger yet and adds them
// to BOTH known_types AND enabled_types. This delivers the upgrade behavior:
// new types added in a future release ship enabled by default, while admin
// disables persist (because anything already in known_types isn't touched).
//
// Call once at server startup AFTER all init() registrations have populated
// the registries.
func SeedKnownAndEnabledTypes(ctx context.Context, updater EnabledTypesUpdater) error {
	if updater == nil {
		return nil
	}

	known, err := updater.GetKnownTypes(ctx)
	if err != nil {
		return err
	}
	if known == nil {
		known = &EnabledTypes{}
	}
	enabled, err := updater.GetEnabledTypes(ctx)
	if err != nil {
		return err
	}
	if enabled == nil {
		enabled = &EnabledTypes{}
	}

	changed := false

	// Connections — both registry-backed adapter types and synthetic types
	// declared by integrations (e.g., Frigate's "frigate" type).
	connSeen := make(map[string]bool, len(known.Connections))
	for _, id := range known.Connections {
		connSeen[id] = true
	}
	for _, info := range List() {
		if !connSeen[info.TypeID] {
			known.Connections = append(known.Connections, info.TypeID)
			enabled.Connections = appendUnique(enabled.Connections, info.TypeID)
			connSeen[info.TypeID] = true
			changed = true
		}
	}
	for _, integ := range ListIntegrations() {
		if integ.OwnedConnectionType != "" && !connSeen[integ.OwnedConnectionType] {
			known.Connections = append(known.Connections, integ.OwnedConnectionType)
			enabled.Connections = appendUnique(enabled.Connections, integ.OwnedConnectionType)
			connSeen[integ.OwnedConnectionType] = true
			changed = true
		}
	}

	// Component subtypes — chart, control, display.
	for _, cat := range []string{CategoryChart, CategoryControl, CategoryDisplay} {
		var (
			ledger  *[]string
			enabled_ *[]string
		)
		switch cat {
		case CategoryChart:
			ledger = &known.Charts
			enabled_ = &enabled.Charts
		case CategoryControl:
			ledger = &known.Controls
			enabled_ = &enabled.Controls
		case CategoryDisplay:
			ledger = &known.Displays
			enabled_ = &enabled.Displays
		}
		seen := make(map[string]bool, len(*ledger))
		for _, id := range *ledger {
			seen[id] = true
		}
		for _, info := range ListComponentTypes(cat) {
			if !seen[info.Subtype] {
				*ledger = append(*ledger, info.Subtype)
				*enabled_ = appendUnique(*enabled_, info.Subtype)
				seen[info.Subtype] = true
				changed = true
			}
		}
	}

	// Integrations.
	integSeen := make(map[string]bool, len(known.Integrations))
	for _, id := range known.Integrations {
		integSeen[id] = true
	}
	for _, info := range ListIntegrations() {
		if !integSeen[info.ID] {
			known.Integrations = append(known.Integrations, info.ID)
			enabled.Integrations = appendUnique(enabled.Integrations, info.ID)
			integSeen[info.ID] = true
			changed = true
		}
	}

	if !changed {
		return nil
	}
	if err := updater.SetKnownTypes(ctx, known); err != nil {
		return err
	}
	return updater.SetEnabledTypes(ctx, enabled)
}

func appendUnique(slice []string, item string) []string {
	for _, s := range slice {
		if s == item {
			return slice
		}
	}
	return append(slice, item)
}
