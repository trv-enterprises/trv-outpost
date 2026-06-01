// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package registry

import (
	"context"
	"fmt"
	"sort"
	"strings"
)

// Catalog is the unified, read-only view of every user-facing type the
// dashboard knows about. Both the MCP server and the AI builder system
// prompt read from this structure so there is exactly one source of truth.
//
// Connection types come from the adapter registry (registry.List()).
// Component types come from the component registry (ListComponentTypes()).
// Device types come from a DB-backed lister supplied at call time — the
// registry package intentionally has no hard dependency on service/models.
type Catalog struct {
	Integrations     []IntegrationInfo        `json:"integrations"`
	ConnectionTypes  []TypeInfo               `json:"connection_types"`
	ChartTypes       []ComponentTypeInfo      `json:"chart_types"`
	ControlTypes     []ComponentTypeInfo      `json:"control_types"`
	DisplayTypes     []ComponentTypeInfo      `json:"display_types"`
	DeviceTypes      []DeviceTypeSummary      `json:"device_types"`
	LayoutDimensions []LayoutDimensionSummary `json:"layout_dimensions,omitempty"`
}

// LayoutDimensionSummary describes one dashboard-canvas size preset.
// The chat agent and MCP consume this to know which key to set on
// dashboard.settings.layout_dimension — preset names vary by
// deployment (admins can rename, add, remove via Manage Settings).
//
// Cols/Rows are server-computed using the same cell-grid math the
// React viewer applies (32-px cells, 4-px gaps, fixed viewer chrome).
// That way the agent can plan panel coordinates against an exact
// cell budget without having to do the geometry itself.
type LayoutDimensionSummary struct {
	Name      string `json:"name"`
	MaxWidth  int    `json:"max_width"`
	MaxHeight int    `json:"max_height"`
	Cols      int    `json:"cols"`
	Rows      int    `json:"rows"`
	IsDefault bool   `json:"is_default,omitempty"`
}

// LayoutDimensionLister supplies the deployment's layout-dimension
// presets to the catalog. Implementations live in the service layer
// (ConfigService) so the registry package keeps no DB / Mongo
// dependency. defaultName is the preset to mark IsDefault=true.
type LayoutDimensionLister interface {
	ListLayoutDimensionsForCatalog(ctx context.Context) (entries []LayoutDimensionEntry, defaultName string, err error)
}

// LayoutDimensionEntry is the minimal raw shape returned by the
// lister. The catalog runs the cell-grid math on these to produce
// LayoutDimensionSummary.
type LayoutDimensionEntry struct {
	Name      string
	MaxWidth  int
	MaxHeight int
}

// Grid math constants — must agree with the React viewer
// (client/src/pages/DashboardViewerPage.jsx — VIEWER_CHROME_V/H, VIEWER_GAP).
//
//	cell pitch  = 32 px
//	gap         = 4 px
//	viewer chrome (vertical)   = 57 px (the viewer toolbar: 56px + 1px
//	                             border). The displayed dashboard (view /
//	                             fullscreen) has NO app header above the
//	                             toolbar, so the budget reserves only the
//	                             toolbar — matching the pixel-perfect
//	                             "actual size" preview in the editor.
//	viewer chrome (horizontal) = 4 px  (border)
//
//	available = canvas - chrome
//	count     = floor( (available + gap) / (cell + gap) )
//
// The `+gap` in the numerator is what the viewer uses — it accounts
// for the fact that N cells only need N-1 gaps between them, so the
// final gap "doesn't count" toward the bound. Drop it and you lose
// one row at most boundary sizes (e.g. 2K becomes 36 rows instead of
// the viewer's 37).
//
// Changing these here without updating the viewer (or vice versa)
// produces dashboards that don't fit. Keep them in lockstep.
const (
	gridCellPx  = 32
	gridGapPx   = 4
	gridChromeV = 57
	gridChromeH = 4
)

// computeCells derives the (cols, rows) cell budget for a canvas of
// the given pixel dimensions. Mirrors the viewer's fit math exactly.
func computeCells(maxWidth, maxHeight int) (cols, rows int) {
	step := gridCellPx + gridGapPx
	if maxWidth > gridChromeH {
		cols = (maxWidth - gridChromeH + gridGapPx) / step
	}
	if maxHeight > gridChromeV {
		rows = (maxHeight - gridChromeV + gridGapPx) / step
	}
	return cols, rows
}

// DeviceTypeSummary is the minimal, serializable slice of a DeviceType that
// the catalog exposes. The real model lives in internal/models but the
// registry package avoids depending on it so there are no import cycles —
// the lister returns this shape directly.
type DeviceTypeSummary struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description,omitempty"`
	Category       string   `json:"category,omitempty"`
	Protocol       string   `json:"protocol,omitempty"`
	SupportedTypes []string `json:"supported_types,omitempty"`
	IsBuiltIn      bool     `json:"is_built_in"`
}

// DeviceTypeLister is the minimal interface the catalog needs. Concrete
// implementations adapt DeviceTypeService or a test fake.
type DeviceTypeLister interface {
	ListDeviceTypesForCatalog(ctx context.Context) ([]DeviceTypeSummary, error)
}

// BuildCatalog assembles the unified type catalog filtered by the given
// TypeFilter. Pass nil for deviceTypes to omit them. Pass nil for filter to
// get an unfiltered catalog (equivalent to BuildUnfilteredCatalog).
//
// Filter semantics: integration-tagged types are only included when their
// integration is enabled. Connection types not registered as adapters but
// declared by an integration's OwnedConnectionType are included as
// synthetic TypeInfo entries when the integration is enabled, so the
// frontend picker and AI prompt see them.
//
// Layout dimensions are not included by this entry point — callers that
// want them (the chat agent's CatalogProvider) should use
// BuildCatalogWithLayout. The MCP catalog handler is fine without
// dimensions for now; pages that need them go through the dedicated
// /api/config/system endpoint.
func BuildCatalog(ctx context.Context, deviceTypes DeviceTypeLister, filter TypeFilter) (*Catalog, error) {
	return BuildCatalogWithLayout(ctx, deviceTypes, nil, filter)
}

// BuildCatalogWithLayout is the same as BuildCatalog but also fans in
// the deployment's layout-dimension presets. Pass nil for layoutDims
// to skip dimensions (equivalent to BuildCatalog).
func BuildCatalogWithLayout(ctx context.Context, deviceTypes DeviceTypeLister, layoutDims LayoutDimensionLister, filter TypeFilter) (*Catalog, error) {
	cat := &Catalog{
		Integrations:    ListIntegrations(),
		ConnectionTypes: List(),
		ChartTypes:      ListComponentTypes(CategoryChart),
		ControlTypes:    ListComponentTypes(CategoryControl),
		DisplayTypes:    ListComponentTypes(CategoryDisplay),
	}

	// Add synthetic connection types declared by integrations (e.g., Frigate).
	cat.ConnectionTypes = appendSyntheticConnectionTypes(cat.ConnectionTypes, cat.Integrations)

	if deviceTypes != nil {
		dts, err := deviceTypes.ListDeviceTypesForCatalog(ctx)
		if err != nil {
			return nil, fmt.Errorf("list device types: %w", err)
		}
		cat.DeviceTypes = dts
	}

	if layoutDims != nil {
		entries, defaultName, err := layoutDims.ListLayoutDimensionsForCatalog(ctx)
		if err != nil {
			return nil, fmt.Errorf("list layout dimensions: %w", err)
		}
		summaries := make([]LayoutDimensionSummary, 0, len(entries))
		for _, e := range entries {
			cols, rows := computeCells(e.MaxWidth, e.MaxHeight)
			summaries = append(summaries, LayoutDimensionSummary{
				Name:      e.Name,
				MaxWidth:  e.MaxWidth,
				MaxHeight: e.MaxHeight,
				Cols:      cols,
				Rows:      rows,
				IsDefault: e.Name == defaultName,
			})
		}
		// Sort by canvas width so the chat-agent surface matches the
		// editor dropdown's ordering (small → large).
		sort.Slice(summaries, func(i, j int) bool {
			if summaries[i].MaxWidth != summaries[j].MaxWidth {
				return summaries[i].MaxWidth < summaries[j].MaxWidth
			}
			return summaries[i].MaxHeight < summaries[j].MaxHeight
		})
		cat.LayoutDimensions = summaries
	}

	if filter != nil {
		cat.Integrations = filterIntegrations(cat.Integrations, filter)
		cat.ConnectionTypes = filterConnectionTypes(cat.ConnectionTypes, filter)
		cat.ChartTypes = filterComponentTypes(cat.ChartTypes, CategoryChart, filter)
		cat.ControlTypes = filterComponentTypes(cat.ControlTypes, CategoryControl, filter)
		cat.DisplayTypes = filterComponentTypes(cat.DisplayTypes, CategoryDisplay, filter)
	}
	return cat, nil
}

// BuildUnfilteredCatalog returns the catalog with no filtering applied.
// Used by the settings editor so admins can see every type, including the
// ones they previously disabled.
func BuildUnfilteredCatalog(ctx context.Context, deviceTypes DeviceTypeLister) (*Catalog, error) {
	return BuildCatalog(ctx, deviceTypes, nil)
}

// appendSyntheticConnectionTypes adds TypeInfo entries for connection types
// owned by integrations that aren't already in the adapter registry.
// Frigate's connection type is the canonical example — it has no Go adapter
// because its requests proxy through frigate_handler.
func appendSyntheticConnectionTypes(existing []TypeInfo, integrations []IntegrationInfo) []TypeInfo {
	known := make(map[string]bool, len(existing))
	for _, t := range existing {
		known[t.TypeID] = true
	}
	for _, integ := range integrations {
		if integ.OwnedConnectionType == "" || known[integ.OwnedConnectionType] {
			continue
		}
		existing = append(existing, TypeInfo{
			TypeID:      integ.OwnedConnectionType,
			DisplayName: integ.DisplayName,
			Category:    "integration",
			Integration: integ.ID,
			Capabilities: Capabilities{
				CanRead: true,
			},
		})
		known[integ.OwnedConnectionType] = true
	}
	sort.Slice(existing, func(i, j int) bool {
		return existing[i].TypeID < existing[j].TypeID
	})
	return existing
}

func filterIntegrations(items []IntegrationInfo, filter TypeFilter) []IntegrationInfo {
	out := make([]IntegrationInfo, 0, len(items))
	for _, info := range items {
		if filter.IsEnabled(CategoryIntegration, info.ID) {
			out = append(out, info)
		}
	}
	return out
}

func filterConnectionTypes(items []TypeInfo, filter TypeFilter) []TypeInfo {
	out := make([]TypeInfo, 0, len(items))
	for _, info := range items {
		if filter.IsEnabled(CategoryConnection, info.TypeID) {
			out = append(out, info)
		}
	}
	return out
}

func filterComponentTypes(items []ComponentTypeInfo, category string, filter TypeFilter) []ComponentTypeInfo {
	out := make([]ComponentTypeInfo, 0, len(items))
	for _, info := range items {
		if filter.IsEnabled(category, info.Subtype) {
			out = append(out, info)
		}
	}
	return out
}

// RenderMarkdown produces a compact markdown description of the catalog
// suitable for embedding in an LLM system prompt. Hidden component types
// are skipped.
func (c *Catalog) RenderMarkdown() string {
	var sb strings.Builder

	sb.WriteString("## Connection types\n\n")
	sb.WriteString("Each connection type requires a different `config` sub-document. Use `list_connections` to see configured connections and `get_connection_schema` to discover the data shape of an existing connection.\n\n")
	if len(c.ConnectionTypes) == 0 {
		sb.WriteString("_(none registered)_\n\n")
	} else {
		for _, t := range c.ConnectionTypes {
			writeConnectionType(&sb, t)
		}
	}

	sb.WriteString("## Chart types\n\n")
	sb.WriteString("These are the canonical `chart_type` values. Use `chart.custom` with `use_custom_code: true` for anything outside this list — the React component path can render any ECharts type or custom visualization bundled with the client.\n\n")
	writeComponentTypes(&sb, c.ChartTypes)

	sb.WriteString("## Control types\n\n")
	sb.WriteString("Interactive controls. Writable controls that bind to a connection also need a `device_type_id` so the server knows how to translate user actions into wire-format commands.\n\n")
	writeComponentTypes(&sb, c.ControlTypes)

	sb.WriteString("## Display types\n\n")
	sb.WriteString("Non-chart visual components bundled with the frontend (Frigate viewers, weather, etc).\n\n")
	writeComponentTypes(&sb, c.DisplayTypes)

	if len(c.LayoutDimensions) > 0 {
		sb.WriteString("## Layout dimensions\n\n")
		sb.WriteString("Dashboard canvas presets configured for this deployment. Set `settings.layout_dimension` on a dashboard to the exact `name` of one of these entries. `cols` × `rows` is the cell-grid budget for panel placement.\n\n")
		for _, d := range c.LayoutDimensions {
			marker := ""
			if d.IsDefault {
				marker = " (default)"
			}
			fmt.Fprintf(&sb, "- **`%s`** — %d×%d px, grid %d × %d cells%s\n",
				d.Name, d.MaxWidth, d.MaxHeight, d.Cols, d.Rows, marker)
		}
		sb.WriteString("\n")
	}

	if len(c.DeviceTypes) > 0 {
		sb.WriteString("## Device types\n\n")
		sb.WriteString("User-managed device definitions stored in MongoDB. Each has a command schema used by controls; `supported_types` lists which control subtypes can bind to it.\n\n")
		dts := make([]DeviceTypeSummary, len(c.DeviceTypes))
		copy(dts, c.DeviceTypes)
		sort.Slice(dts, func(i, j int) bool { return dts[i].ID < dts[j].ID })
		for _, dt := range dts {
			fmt.Fprintf(&sb, "- **`%s`** — %s", dt.ID, dt.Name)
			if dt.Category != "" {
				fmt.Fprintf(&sb, " (%s", dt.Category)
				if dt.Protocol != "" {
					fmt.Fprintf(&sb, "/%s", dt.Protocol)
				}
				sb.WriteString(")")
			}
			if len(dt.SupportedTypes) > 0 {
				fmt.Fprintf(&sb, " — supports: %s", strings.Join(dt.SupportedTypes, ", "))
			}
			if dt.Description != "" {
				fmt.Fprintf(&sb, "\n  %s", dt.Description)
			}
			sb.WriteString("\n")
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

func writeConnectionType(sb *strings.Builder, t TypeInfo) {
	fmt.Fprintf(sb, "- **`%s`** — %s", t.TypeID, t.DisplayName)
	var caps []string
	if t.Capabilities.CanRead {
		caps = append(caps, "read")
	}
	if t.Capabilities.CanWrite {
		caps = append(caps, "write")
	}
	if t.Capabilities.CanStream {
		caps = append(caps, "stream")
	}
	if len(caps) > 0 {
		fmt.Fprintf(sb, " (%s)", strings.Join(caps, ", "))
	}
	sb.WriteString("\n")

	if len(t.ConfigSchema) > 0 {
		sb.WriteString("  - Config fields: ")
		fields := make([]string, 0, len(t.ConfigSchema))
		for _, f := range t.ConfigSchema {
			marker := ""
			if f.Required {
				marker = "*"
			}
			fields = append(fields, fmt.Sprintf("`%s`%s", f.Name, marker))
		}
		sb.WriteString(strings.Join(fields, ", "))
		sb.WriteString(" (`*` = required)\n")
	}
}

func writeComponentTypes(sb *strings.Builder, types []ComponentTypeInfo) {
	visible := make([]ComponentTypeInfo, 0, len(types))
	for _, t := range types {
		if !t.Hidden {
			visible = append(visible, t)
		}
	}
	if len(visible) == 0 {
		sb.WriteString("_(none registered)_\n\n")
		return
	}
	for _, t := range visible {
		fmt.Fprintf(sb, "- **`%s`** — %s", t.Subtype, t.DisplayName)
		var caps []string
		if t.Capabilities.CanRead {
			caps = append(caps, "read")
		}
		if t.Capabilities.CanWrite {
			caps = append(caps, "write")
		}
		if t.Capabilities.RequiresDeviceType {
			caps = append(caps, "needs device_type")
		}
		if len(caps) > 0 {
			fmt.Fprintf(sb, " (%s)", strings.Join(caps, ", "))
		}
		sb.WriteString("\n")
		if t.Description != "" {
			fmt.Fprintf(sb, "  %s\n", t.Description)
		}
		if t.DataRequirements != nil && (t.DataRequirements.RequiresXAxis || t.DataRequirements.RequiresYAxis) {
			sb.WriteString("  Data: ")
			var parts []string
			if t.DataRequirements.RequiresXAxis {
				label := "x_axis"
				if t.DataRequirements.XAxisLabel != "" {
					label = fmt.Sprintf("x_axis (%s)", t.DataRequirements.XAxisLabel)
				}
				parts = append(parts, label)
			}
			if t.DataRequirements.RequiresYAxis {
				label := "y_axis"
				if t.DataRequirements.MultipleYAxis {
					label = "y_axis (multiple allowed)"
				}
				if t.DataRequirements.YAxisLabel != "" {
					label = fmt.Sprintf("%s (%s)", label, t.DataRequirements.YAxisLabel)
				}
				parts = append(parts, label)
			}
			sb.WriteString(strings.Join(parts, ", "))
			sb.WriteString("\n")
		}
	}
	sb.WriteString("\n")
}
