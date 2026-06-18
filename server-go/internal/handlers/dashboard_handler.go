// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/base64"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// DashboardHandler handles dashboard-related HTTP requests
type DashboardHandler struct {
	service *service.DashboardService
}

// NewDashboardHandler creates a new dashboard handler
func NewDashboardHandler(service *service.DashboardService) *DashboardHandler {
	return &DashboardHandler{
		service: service,
	}
}

// CreateDashboard creates a new dashboard
// @Summary Create a new dashboard
// @Description Create a new dashboard with panels and embedded charts
// @Tags dashboards
// @Accept json
// @Produce json
// @Param dashboard body models.CreateDashboardRequest true "Dashboard data"
// @Success 201 {object} models.Dashboard
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards [post]
func (h *DashboardHandler) CreateDashboard(c *gin.Context) {
	var req models.CreateDashboardRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dashboard, err := h.service.CreateDashboard(c.Request.Context(), &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "already exists") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, dashboard)
}

// GetDashboard retrieves a dashboard by ID
// @Summary Get a dashboard
// @Description Get a dashboard by ID (includes panels and charts)
// @Tags dashboards
// @Produce json
// @Param id path string true "Dashboard ID"
// @Success 200 {object} models.Dashboard
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id} [get]
func (h *DashboardHandler) GetDashboard(c *gin.Context) {
	id := c.Param("id")

	dashboard, err := h.service.GetDashboard(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Dashboard not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, dashboard)
}

// GetVariableCandidates lists the selectable connections for a dashboard's
// connection_swap variable (discovered by tag, annotated with schema
// compatibility).
// @Summary Get dashboard variable candidates
// @Description List candidate connections for a connection_swap dashboard variable
// @Tags dashboards
// @Produce json
// @Param id path string true "Dashboard ID"
// @Param variable query string true "Variable name"
// @Success 200 {object} models.VariableCandidatesResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id}/variable-candidates [get]
func (h *DashboardHandler) GetVariableCandidates(c *gin.Context) {
	id := c.Param("id")
	variable := c.Query("variable")
	if variable == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "variable query parameter is required"})
		return
	}

	resp, err := h.service.GetVariableCandidates(c.Request.Context(), id, variable)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "not a connection_swap") || strings.Contains(err.Error(), "not available") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, resp)
}

// ListDashboards retrieves a list of dashboards with pagination
// @Summary List dashboards
// @Description Get a paginated list of dashboards with optional filtering. Use include_datasources=true to get data source names for each dashboard.
// @Tags dashboards
// @Produce json
// @Param name query string false "Filter by name (partial match)"
// @Param is_public query boolean false "Filter by public status"
// @Param component_id query string false "Filter to dashboards using a specific component"
// @Param connection_id query string false "Filter to dashboards using any component bound to this connection"
// @Param include_connections query boolean false "Include connection names from charts (returns DashboardSummary shape)"
// @Param sort query string false "Sort field (name, updated, created, namespace)"
// @Param direction query string false "Sort direction (asc, desc)"
// @Param page query int false "Page number" default(1)
// @Param page_size query string false "Page size; 'all' or 0 returns up to 1000 in one response" default(20)
// @Success 200 {object} models.DashboardListResponse "Standard response"
// @Success 200 {object} models.DashboardSummaryListResponse "Response when include_connections=true"
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards [get]
func (h *DashboardHandler) ListDashboards(c *gin.Context) {
	normalizeAllPageSize(c)
	var params models.DashboardQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// If include_datasources is true, use the aggregation method
	if params.IncludeConnections {
		response, err := h.service.ListDashboardsWithDatasources(c.Request.Context(), params)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, response)
		return
	}

	response, err := h.service.ListDashboards(c.Request.Context(), params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// UpdateDashboard updates a dashboard
// @Summary Update a dashboard
// @Description Update an existing dashboard
// @Tags dashboards
// @Accept json
// @Produce json
// @Param id path string true "Dashboard ID"
// @Param dashboard body models.UpdateDashboardRequest true "Dashboard update data"
// @Success 200 {object} models.Dashboard
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id} [put]
func (h *DashboardHandler) UpdateDashboard(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateDashboardRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dashboard, err := h.service.UpdateDashboard(c.Request.Context(), id, &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already exists") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, dashboard)
}

// GetDashboardThumbnail returns a dashboard's thumbnail as raw PNG bytes.
// The blob is stored as a base64 data URL in the dashboard_thumbnails
// collection (#19); this decodes it so tiles can lazy-load it directly
// via <img loading="lazy" src=...> with native browser caching. Returns
// 404 when no thumbnail has been captured for the dashboard.
// @Summary Get a dashboard thumbnail
// @Description Get the captured thumbnail image (PNG) for a dashboard
// @Tags dashboards
// @Produce image/png
// @Param id path string true "Dashboard ID"
// @Success 200 {string} binary "PNG image bytes"
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id}/thumbnail [get]
func (h *DashboardHandler) GetDashboardThumbnail(c *gin.Context) {
	id := c.Param("id")

	dataURL, err := h.service.GetThumbnail(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if dataURL == "" {
		c.JSON(http.StatusNotFound, gin.H{"error": "No thumbnail"})
		return
	}

	// Stored form is a data URL ("data:image/png;base64,...."). Strip the
	// prefix and decode to raw bytes so we can serve image/png directly.
	b64 := dataURL
	if i := strings.Index(b64, ","); i >= 0 && strings.HasPrefix(b64, "data:") {
		b64 = b64[i+1:]
	}
	raw, derr := base64.StdEncoding.DecodeString(b64)
	if derr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "corrupt thumbnail"})
		return
	}

	// Tiles refetch on a structural-signature change (the URL gets a cache
	// buster appended client-side), so a short cache is safe and cheap.
	c.Header("Cache-Control", "private, max-age=300")
	c.Data(http.StatusOK, "image/png", raw)
}

// PutDashboardThumbnail upserts a dashboard's thumbnail blob. Body is
// { "thumbnail": "data:image/png;base64,..." }. Replaces the old
// thumbnail-only PUT /dashboards/:id path that embedded the blob in the
// dashboard document (#19).
// @Summary Set a dashboard thumbnail
// @Description Upsert the captured thumbnail (base64 data URL) for a dashboard
// @Tags dashboards
// @Accept json
// @Produce json
// @Param id path string true "Dashboard ID"
// @Param thumbnail body object true "Thumbnail data URL"
// @Success 204
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id}/thumbnail [put]
func (h *DashboardHandler) PutDashboardThumbnail(c *gin.Context) {
	id := c.Param("id")

	var body struct {
		Thumbnail string `json:"thumbnail"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Thumbnail == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "thumbnail is required"})
		return
	}

	if err := h.service.SetThumbnail(c.Request.Context(), id, body.Thumbnail); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// GetDashboardComponents returns the latest final version of every component
// the dashboard's panels reference (defaults + component-swap overrides) in a
// single response, so the viewer can fetch all panel components in ONE request
// instead of one getComponent per panel (#60).
// @Summary Get all components for a dashboard
// @Description Batch-fetch the components referenced by a dashboard's panels (latest final versions)
// @Tags dashboards
// @Produce json
// @Param id path string true "Dashboard ID"
// @Success 200 {object} map[string]interface{} "{ components: [...] }"
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id}/components [get]
func (h *DashboardHandler) GetDashboardComponents(c *gin.Context) {
	id := c.Param("id")

	components, err := h.service.GetDashboardComponents(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Dashboard not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"components": components})
}

// DeleteDashboard deletes a dashboard
// @Summary Delete a dashboard
// @Description Delete a dashboard by ID
// @Tags dashboards
// @Param id path string true "Dashboard ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards/{id} [delete]
func (h *DashboardHandler) DeleteDashboard(c *gin.Context) {
	id := c.Param("id")

	// Optional body: { "delete_component_ids": ["..."] } — components to also
	// delete (cascade). Each is re-validated server-side as actually orphaned.
	// Body is optional so a plain DELETE still works (delete dashboard only).
	var body struct {
		DeleteComponentIDs []string `json:"delete_component_ids"`
	}
	_ = c.ShouldBindJSON(&body)

	deleted, err := h.service.DeleteDashboardCascade(c.Request.Context(), id, body.DeleteComponentIDs)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Dashboard not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if len(deleted) > 0 {
		c.JSON(http.StatusOK, gin.H{"deleted_component_ids": deleted})
		return
	}
	c.Status(http.StatusNoContent)
}

// GetDashboardDeletePreview returns the components that would be orphaned if
// this dashboard were deleted (referenced by no other dashboard). The delete
// confirmation UI uses it to offer cascade deletion.
// @Summary Preview orphaned components for a dashboard delete
// @Tags dashboards
// @Param id path string true "Dashboard ID"
// @Success 200 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /dashboards/{id}/delete-preview [get]
func (h *DashboardHandler) GetDashboardDeletePreview(c *gin.Context) {
	id := c.Param("id")
	orphans, err := h.service.DashboardOrphanPreview(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Dashboard not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"orphaned_components": orphans})
}
