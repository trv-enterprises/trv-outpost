// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// PreviewExport walks the dependency graph for the given dashboard IDs
// and returns counts (no actual data) so the UI can confirm what's
// about to download. Cheap enough to call on every selection change.
func (s *DashboardService) PreviewExport(ctx context.Context, dashboardIDs []string) (*models.ExportPreview, error) {
	bundle, err := s.BuildExport(ctx, "", dashboardIDs)
	if err != nil {
		return nil, err
	}
	return &models.ExportPreview{
		ConnectionCount: len(bundle.Objects.Connections),
		ComponentCount:  len(bundle.Objects.Components),
		DashboardCount:  len(bundle.Objects.Dashboards),
		SourceNamespace: bundle.SourceNamespace,
		Warnings:        bundleWarnings(bundle),
	}, nil
}

// BuildExport fetches every record needed to round-trip the requested
// dashboards on another system: the dashboards themselves, every chart
// (latest final version) referenced by any panel, and every connection
// referenced by those charts or by display configs (Frigate, MQTT).
//
// The graph is walked dashboards → components → connections so the
// returned bundle's arrays are already in dependency order — the
// importer can apply them in array order without sorting.
//
// Connections come back via SanitizeForExport() so secrets ride out as
// "********" placeholders regardless of the per-connection MaskSecrets
// flag. The importer handles those specially: on update it preserves
// the existing stored value, on create it leaves the literal
// placeholder for the user to fix.
//
// exportedBy is opaque — the handler typically passes the requester's
// user GUID so the bundle metadata records who built it.
func (s *DashboardService) BuildExport(ctx context.Context, exportedBy string, dashboardIDs []string) (*models.ExportBundle, error) {
	if s.chartRepo == nil || s.connectionRepo == nil {
		return nil, fmt.Errorf("export requires chart and datasource repositories — service was constructed without them")
	}
	if len(dashboardIDs) == 0 {
		return nil, fmt.Errorf("no dashboards selected for export")
	}

	dashboards := make([]models.Dashboard, 0, len(dashboardIDs))
	chartIDsSeen := make(map[string]struct{})
	dsIDsSeen := make(map[string]struct{})
	namespaceCounts := make(map[string]int)

	// Pass 1: load dashboards + collect chart/connection IDs they reference.
	for _, id := range dashboardIDs {
		dash, err := s.repo.FindByID(ctx, id)
		if err != nil {
			return nil, fmt.Errorf("loading dashboard %s: %w", id, err)
		}
		if dash == nil {
			return nil, fmt.Errorf("dashboard %s not found", id)
		}
		dashboards = append(dashboards, *dash)
		namespaceCounts[dash.Namespace]++
		for _, panel := range dash.Panels {
			if panel.ChartID != "" {
				chartIDsSeen[panel.ChartID] = struct{}{}
			}
		}
	}

	// Pass 2: load charts (latest final version) + collect their connection IDs.
	components := make([]models.Component, 0, len(chartIDsSeen))
	for cid := range chartIDsSeen {
		ch, err := s.chartRepo.FindLatestFinal(ctx, cid)
		if err != nil {
			return nil, fmt.Errorf("loading chart %s: %w", cid, err)
		}
		if ch == nil {
			// Dashboard references a chart that has no final version
			// (only a draft, or was deleted). Don't fail the export;
			// the dashboard ships with the dangling reference and the
			// import-side preview will surface it.
			continue
		}
		components = append(components, *ch)
		if ch.ConnectionID != "" {
			dsIDsSeen[ch.ConnectionID] = struct{}{}
		}
		// Display components can also reference connections directly via
		// DisplayConfig — pull those into the dependency graph too so a
		// re-import of a Frigate camera or weather display still works.
		if ch.DisplayConfig != nil {
			if id := ch.DisplayConfig.FrigateConnectionID; id != "" {
				dsIDsSeen[id] = struct{}{}
			}
			if id := ch.DisplayConfig.MqttConnectionID; id != "" {
				dsIDsSeen[id] = struct{}{}
			}
		}
	}

	// Pass 3: load connections, sanitized for export (secrets masked).
	connections := make([]models.Connection, 0, len(dsIDsSeen))
	for did := range dsIDsSeen {
		ds, err := s.connectionRepo.FindByID(ctx, did)
		if err != nil {
			return nil, fmt.Errorf("loading connection %s: %w", did, err)
		}
		if ds == nil {
			// Same orphan tolerance as charts — log via warnings, don't
			// block the export.
			continue
		}
		connections = append(connections, *ds.SanitizeForExport())
	}

	// Stable ordering inside each array so the bundle is deterministic
	// (helps with diffs and re-import idempotency tests).
	sort.SliceStable(connections, func(i, j int) bool { return connections[i].ID < connections[j].ID })
	sort.SliceStable(components, func(i, j int) bool { return components[i].ID < components[j].ID })
	sort.SliceStable(dashboards, func(i, j int) bool { return dashboards[i].ID < dashboards[j].ID })

	return &models.ExportBundle{
		FormatVersion:   models.ExportFormatVersion,
		ExportedAt:      time.Now().UTC(),
		ExportedBy:      exportedBy,
		SourceNamespace: pickSourceNamespace(namespaceCounts),
		Objects: models.ExportObjects{
			Connections: connections,
			Components:  components,
			Dashboards:  dashboards,
		},
	}, nil
}

// pickSourceNamespace returns the single namespace if all dashboards
// share one, otherwise empty string. The empty case tells the importer
// "this bundle spans namespaces; fall back to the user's chosen
// target."
func pickSourceNamespace(counts map[string]int) string {
	if len(counts) != 1 {
		return ""
	}
	for ns := range counts {
		return ns
	}
	return ""
}

// bundleWarnings reports issues the export tolerated but the importer
// should know about. Today: dashboards with chart_id pointers that
// resolved to no chart (deleted or draft-only). The list is human-
// readable and surfaced in the export-preview UI.
func bundleWarnings(b *models.ExportBundle) []string {
	have := make(map[string]struct{}, len(b.Objects.Components))
	for _, c := range b.Objects.Components {
		have[c.ID] = struct{}{}
	}
	var warnings []string
	for _, d := range b.Objects.Dashboards {
		for _, p := range d.Panels {
			if p.ChartID == "" {
				continue
			}
			if _, ok := have[p.ChartID]; !ok {
				warnings = append(warnings, fmt.Sprintf(
					"dashboard %q (%s) references missing chart %s", d.Name, d.ID, p.ChartID,
				))
			}
		}
	}
	return warnings
}
