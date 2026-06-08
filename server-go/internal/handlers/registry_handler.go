// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/connectionguidance"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// RegistryHandler handles registry-related endpoints. It owns the unified
// type catalog (connection types, chart/control/display subtypes, and
// device types), which is what the AI builder and MCP server consume as
// their single source of truth.
type RegistryHandler struct {
	deviceTypes *service.DeviceTypeService
	layoutDims  registry.LayoutDimensionLister
	filter      registry.TypeFilter
}

// NewRegistryHandler creates a new registry handler. deviceTypes may be nil
// (the catalog endpoint will omit device types if so). layoutDims may be
// nil (the catalog will omit layout dimensions). filter may be nil (no
// filtering applied — useful in tests).
func NewRegistryHandler(deviceTypes *service.DeviceTypeService, layoutDims registry.LayoutDimensionLister, filter registry.TypeFilter) *RegistryHandler {
	return &RegistryHandler{deviceTypes: deviceTypes, layoutDims: layoutDims, filter: filter}
}

// activeFilter returns the effective filter for a request: nil if the
// request opted out via ?include_disabled=true, otherwise the handler's
// configured filter (which may itself be nil if not wired up).
func (h *RegistryHandler) activeFilter(c *gin.Context) registry.TypeFilter {
	if c.Query("include_disabled") == "true" {
		return nil
	}
	return h.filter
}

// deviceTypeListerAdapter adapts DeviceTypeService to registry.DeviceTypeLister
// so the registry package stays free of service/models imports.
type deviceTypeListerAdapter struct {
	svc *service.DeviceTypeService
}

func (a *deviceTypeListerAdapter) ListDeviceTypesForCatalog(ctx context.Context) ([]registry.DeviceTypeSummary, error) {
	if a.svc == nil {
		return nil, nil
	}
	resp, err := a.svc.ListDeviceTypes(ctx, &models.DeviceTypeQueryParams{Page: 1, PageSize: 500})
	if err != nil {
		return nil, err
	}
	summaries := make([]registry.DeviceTypeSummary, 0, len(resp.DeviceTypes))
	for _, dt := range resp.DeviceTypes {
		summaries = append(summaries, registry.DeviceTypeSummary{
			ID:             dt.ID,
			Name:           dt.Name,
			Description:    dt.Description,
			Category:       dt.Category,
			Protocol:       dt.Protocol,
			SupportedTypes: dt.SupportedTypes,
			IsBuiltIn:      dt.IsBuiltIn,
		})
	}
	return summaries, nil
}

// deviceTypeLister returns a lister backed by the handler's service, or nil
// if no service was supplied.
func (h *RegistryHandler) deviceTypeLister() registry.DeviceTypeLister {
	if h.deviceTypes == nil {
		return nil
	}
	return &deviceTypeListerAdapter{svc: h.deviceTypes}
}

// ListConnectionTypesResponse represents the response for listing connection types
type ListConnectionTypesResponse struct {
	Types      []registry.TypeInfo `json:"types"`
	Categories []string            `json:"categories"`
	Count      int                 `json:"count"`
}

// ListConnectionTypes godoc
// @Summary List all available connection types
// @Description Get all registered adapter types with their capabilities and configuration schema
// @Tags registry
// @Produce json
// @Param category query string false "Filter by category (e.g., 'db', 'stream', 'api')"
// @Success 200 {object} ListConnectionTypesResponse
// @Router /registry/connections [get]
func (h *RegistryHandler) ListConnectionTypes(c *gin.Context) {
	category := c.Query("category")

	var types []registry.TypeInfo
	if category != "" {
		types = registry.ListByCategory(category)
	} else {
		types = registry.List()
	}

	// Include synthetic connection types declared by integrations (e.g., Frigate).
	types = appendSyntheticForListing(types)

	if filter := h.activeFilter(c); filter != nil {
		filtered := types[:0]
		for _, t := range types {
			if filter.IsEnabled(registry.CategoryConnection, t.TypeID) {
				filtered = append(filtered, t)
			}
		}
		types = filtered
	}

	c.JSON(http.StatusOK, ListConnectionTypesResponse{
		Types:      types,
		Categories: registry.Categories(),
		Count:      len(types),
	})
}

// appendSyntheticForListing layers in connection types declared by
// integrations that aren't in the adapter registry. Mirrors the helper in
// registry/catalog.go but works directly on the listing endpoint.
func appendSyntheticForListing(existing []registry.TypeInfo) []registry.TypeInfo {
	known := make(map[string]bool, len(existing))
	for _, t := range existing {
		known[t.TypeID] = true
	}
	for _, integ := range registry.ListIntegrations() {
		if integ.OwnedConnectionType == "" || known[integ.OwnedConnectionType] {
			continue
		}
		existing = append(existing, registry.TypeInfo{
			TypeID:      integ.OwnedConnectionType,
			DisplayName: integ.DisplayName,
			Category:    "integration",
			Integration: integ.ID,
			Capabilities: registry.Capabilities{
				CanRead: true,
			},
		})
		known[integ.OwnedConnectionType] = true
	}
	return existing
}

// GetConnectionType godoc
// @Summary Get a specific connection type
// @Description Get details about a specific adapter type including configuration schema
// @Tags registry
// @Produce json
// @Param typeId path string true "Type ID (e.g., 'db.postgres', 'stream.websocket-bidir')"
// @Success 200 {object} registry.TypeInfo
// @Failure 404 {object} map[string]interface{} "Type not found"
// @Router /registry/connections/{typeId} [get]
func (h *RegistryHandler) GetConnectionType(c *gin.Context) {
	typeID := c.Param("typeId")

	info, ok := registry.GetTypeInfo(typeID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"error":      "type not found",
			"type_id":    typeID,
			"available":  registry.Categories(),
		})
		return
	}

	c.JSON(http.StatusOK, info)
}

// ConnectionTypeGuidanceResponse describes the query-config
// conventions for a connection adapter type — the same text the
// chat agent reads via toolops, surfaced to the human editor so
// users see "ts-store doesn't speak SQL" in the same place they
// configure a chart against it.
type ConnectionTypeGuidanceResponse struct {
	TypeID   string `json:"type_id"`
	Guidance string `json:"guidance"`
	HasEntry bool   `json:"has_entry"`
}

// legacyToRegistryTypeID maps the short connection.type strings used
// throughout the older UI ("sql", "tsstore", "mqtt", ...) to the
// registry type IDs that connectionguidance is keyed by
// ("sql.postgres", "store.tsstore", "stream.mqtt", ...). Mirrors the
// canonical conversion in models.Connection.GetEffectiveTypeID for
// the cases that don't need to peek at the connection's config
// sub-block. When the legacy string already looks like a registry id
// (contains a dot), passes it through unchanged so existing
// registry-keyed callers keep working.
//
// Some legacy types (notably "sql" and "socket") need the connection
// config to pick the right registry id — for those we fall back to
// the most common variant. Callers that want sub-driver precision
// should send the registry id directly.
func legacyToRegistryTypeID(in string) string {
	if in == "" || strings.Contains(in, ".") {
		return in
	}
	switch in {
	case "sql":
		return "sql.postgres" // default; specific dialect requires registry id
	case "csv":
		return "file.csv"
	case "socket":
		return "stream.websocket"
	case "api":
		return "api.rest"
	case "tsstore":
		return "store.tsstore"
	case "prometheus":
		return "api.prometheus"
	case "edgelake":
		return "api.edgelake"
	case "mqtt":
		return "stream.mqtt"
	case "frigate":
		return "frigate"
	default:
		return in
	}
}

// GetConnectionTypeGuidance godoc
// @Summary Per-type query-config conventions
// @Description Returns the cheat-sheet describing how to write query_config for a given connection adapter type — implicit row caps, supported DSL keywords, common pitfalls, etc. Sourced from the same connectionguidance package the chat agent reads. Accepts either a registry type id (e.g. "store.tsstore") or the legacy short type ("tsstore"); legacy values are mapped server-side so existing UI callers keep working.
// @Tags registry
// @Produce json
// @Param typeId path string true "Type ID (e.g., 'store.tsstore', 'api.prometheus') or legacy type ('tsstore', 'prometheus')"
// @Success 200 {object} ConnectionTypeGuidanceResponse
// @Router /registry/connections/{typeId}/guidance [get]
func (h *RegistryHandler) GetConnectionTypeGuidance(c *gin.Context) {
	raw := c.Param("typeId")
	resolved := legacyToRegistryTypeID(raw)
	text, ok := connectionguidance.Get(resolved)
	c.JSON(http.StatusOK, ConnectionTypeGuidanceResponse{
		TypeID:   resolved,
		Guidance: text,
		HasEntry: ok,
	})
}

// ListCategoriesResponse represents the response for listing categories
type ListCategoriesResponse struct {
	Categories []CategoryInfo `json:"categories"`
}

// CategoryInfo represents information about a category
type CategoryInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	TypeCount   int    `json:"type_count"`
}

// ListCategories godoc
// @Summary List all connection type categories
// @Description Get all available categories with their type counts
// @Tags registry
// @Produce json
// @Success 200 {object} ListCategoriesResponse
// @Router /registry/categories [get]
func (h *RegistryHandler) ListCategories(c *gin.Context) {
	categories := registry.Categories()

	categoryInfos := make([]CategoryInfo, len(categories))
	displayNames := map[string]string{
		"db":     "Databases",
		"file":   "Files",
		"stream": "Streams",
		"api":    "APIs",
		"store":  "Data Stores",
	}

	for i, cat := range categories {
		displayName := displayNames[cat]
		if displayName == "" {
			displayName = cat
		}
		categoryInfos[i] = CategoryInfo{
			Name:        cat,
			DisplayName: displayName,
			TypeCount:   len(registry.ListByCategory(cat)),
		}
	}

	c.JSON(http.StatusOK, ListCategoriesResponse{
		Categories: categoryInfos,
	})
}

// ListComponentTypesResponse wraps component type listings.
type ListComponentTypesResponse struct {
	Types []registry.ComponentTypeInfo `json:"types"`
	Count int                          `json:"count"`
}

// ListComponentTypes godoc
// @Summary List component subtypes (chart/control/display)
// @Description Returns registered component types. Pass ?category=chart, ?category=control, or ?category=display to filter; omit for all. Hidden types are included so legacy editors still work.
// @Tags registry
// @Produce json
// @Param category query string false "Filter: chart, control, display"
// @Success 200 {object} ListComponentTypesResponse
// @Router /registry/components [get]
func (h *RegistryHandler) ListComponentTypes(c *gin.Context) {
	category := c.Query("category")
	types := registry.ListComponentTypes(category)

	if filter := h.activeFilter(c); filter != nil {
		filtered := types[:0]
		for _, t := range types {
			if filter.IsEnabled(t.Category, t.Subtype) {
				filtered = append(filtered, t)
			}
		}
		types = filtered
	}

	c.JSON(http.StatusOK, ListComponentTypesResponse{
		Types: types,
		Count: len(types),
	})
}

// GetComponentType godoc
// @Summary Get a single component type by ID
// @Description Returns metadata for a single component subtype like "chart.bar" or "control.toggle".
// @Tags registry
// @Produce json
// @Param typeId path string true "Component type ID"
// @Success 200 {object} registry.ComponentTypeInfo
// @Failure 404 {object} map[string]interface{}
// @Router /registry/components/{typeId} [get]
func (h *RegistryHandler) GetComponentType(c *gin.Context) {
	typeID := c.Param("typeId")
	info, ok := registry.GetComponentType(typeID)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{
			"error":   "component type not found",
			"type_id": typeID,
		})
		return
	}
	c.JSON(http.StatusOK, info)
}

// GetCatalog godoc
// @Summary Unified type catalog (single source of truth)
// @Description Returns connection types, chart/control/display subtypes, and device types in one payload. This is what the AI builder and MCP server consume so they never duplicate enum lists.
// @Tags registry
// @Produce json
// @Success 200 {object} registry.Catalog
// @Router /registry/catalog [get]
func (h *RegistryHandler) GetCatalog(c *gin.Context) {
	cat, err := registry.BuildCatalogWithLayout(c.Request.Context(), h.deviceTypeLister(), h.layoutDims, h.activeFilter(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, cat)
}

// ListIntegrationsResponse wraps the integration listing.
type ListIntegrationsResponse struct {
	Integrations []registry.IntegrationInfo `json:"integrations"`
	Count        int                        `json:"count"`
}

// ListIntegrations godoc
// @Summary List registered integrations
// @Description Integrations group related connection / chart / control / display types so admins can enable or disable them as a bundle from the settings UI. Pass ?include_disabled=true to see every integration regardless of the current enabled_types setting.
// @Tags registry
// @Produce json
// @Param include_disabled query bool false "If true, returns all integrations even if disabled"
// @Success 200 {object} ListIntegrationsResponse
// @Router /registry/integrations [get]
func (h *RegistryHandler) ListIntegrations(c *gin.Context) {
	items := registry.ListIntegrations()
	if filter := h.activeFilter(c); filter != nil {
		filtered := items[:0]
		for _, info := range items {
			if filter.IsIntegrationEnabled(info.ID) {
				filtered = append(filtered, info)
			}
		}
		items = filtered
	}
	c.JSON(http.StatusOK, ListIntegrationsResponse{
		Integrations: items,
		Count:        len(items),
	})
}

// GetCatalogMarkdown godoc
// @Summary Catalog rendered as markdown
// @Description Same data as /catalog but formatted as a markdown document. Useful for embedding directly in an LLM system prompt or pasting into chat.
// @Tags registry
// @Produce text/plain
// @Success 200 {string} string "Markdown document"
// @Router /registry/catalog.md [get]
func (h *RegistryHandler) GetCatalogMarkdown(c *gin.Context) {
	cat, err := registry.BuildCatalogWithLayout(c.Request.Context(), h.deviceTypeLister(), h.layoutDims, h.activeFilter(c))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(cat.RenderMarkdown()))
}
