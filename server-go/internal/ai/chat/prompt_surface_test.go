// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// Step 13.5 — verifies the "## Current view" block is emitted and
// rendered correctly when the caller carries a surface payload, and
// is dropped (no empty header) when it doesn't.
func TestCurrentViewSection_OmittedWithoutSurface(t *testing.T) {
	got := currentViewSection(nil)
	if got != "" {
		t.Errorf("nil caller: expected empty, got %q", got)
	}

	got = currentViewSection(&CallerCtx{Surface: nil})
	if got != "" {
		t.Errorf("nil surface: expected empty, got %q", got)
	}

	got = currentViewSection(&CallerCtx{Surface: &models.SurfaceContext{}})
	if got != "" {
		t.Errorf("empty surface (no Surface field): expected empty, got %q", got)
	}
}

func TestCurrentViewSection_DashboardWithPanels(t *testing.T) {
	caller := &CallerCtx{Surface: &models.SurfaceContext{
		Mode:        "EDIT",
		Surface:     "DASHBOARD",
		SurfaceID:   "dash-abc",
		SurfaceName: "Telemetry",
		Panels: []models.SurfaceContextPanel{
			{ID: "p1", Title: "Voltage", ComponentID: "c-v", ComponentType: "chart", ChartType: "line"},
			{ID: "p2", Title: "Pressure Gauge", ComponentType: "chart", ChartType: "gauge"},
			{ID: "p3"}, // bare panel — no title, just ID fallback
		},
	}}

	got := currentViewSection(caller)
	checks := []string{
		"# Current view",
		"**Mode:** EDIT",
		"**Surface:** DASHBOARD (id: dash-abc, name: \"Telemetry\")",
		"**Panels visible:**",
		"**Voltage**",
		"chart, line, component_id=c-v",
		"**Pressure Gauge**",
		"chart, gauge",
		"**p3**", // bare-panel fallback uses ID
	}
	for _, want := range checks {
		if !strings.Contains(got, want) {
			t.Errorf("expected output to contain %q; got:\n%s", want, got)
		}
	}
}

func TestCurrentViewSection_DashboardTrimsOverCap(t *testing.T) {
	panels := make([]models.SurfaceContextPanel, surfacePanelCap+5)
	for i := range panels {
		panels[i] = models.SurfaceContextPanel{ID: "p", Title: "Panel"}
	}
	caller := &CallerCtx{Surface: &models.SurfaceContext{
		Mode:    "VIEW",
		Surface: "DASHBOARD",
		Panels:  panels,
	}}

	got := currentViewSection(caller)
	if !strings.Contains(got, "and 5 more panels") {
		t.Errorf("expected trim summary; got:\n%s", got)
	}
}

func TestCurrentViewSection_ComponentSurfaceNoPanels(t *testing.T) {
	caller := &CallerCtx{Surface: &models.SurfaceContext{
		Mode:        "EDIT",
		Surface:     "COMPONENT",
		SurfaceID:   "comp-1",
		SurfaceName: "Bar Chart",
	}}
	got := currentViewSection(caller)
	if !strings.Contains(got, "**Surface:** COMPONENT") {
		t.Errorf("expected COMPONENT surface line; got:\n%s", got)
	}
	if strings.Contains(got, "Panels visible") {
		t.Errorf("COMPONENT surface should not render panels block; got:\n%s", got)
	}
}
