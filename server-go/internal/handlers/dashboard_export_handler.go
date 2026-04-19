// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// PreviewExport returns counts (and any warnings) for the dashboards
// the user has selected, without producing the bundle. Drives the
// "Exporting N dashboards, M components, K connections" preview in
// the export modal.
//
// @Summary Preview a dashboard export
// @Description Returns counts of entities that would be included in an export of the given dashboards
// @Tags dashboards
// @Accept json
// @Produce json
// @Param body body models.ExportRequest true "Dashboard IDs to preview"
// @Success 200 {object} models.ExportPreview
// @Failure 400 {object} map[string]string
// @Router /api/dashboards/export/preview [post]
func (h *DashboardHandler) PreviewExport(c *gin.Context) {
	var req models.ExportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	preview, err := h.service.PreviewExport(c.Request.Context(), req.DashboardIDs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, preview)
}

// ExportDashboards builds the actual JSON bundle. The handler returns
// the bundle as application/json so the client can stash it as a file
// download (the frontend slugifies the source namespace + timestamp
// for the filename).
//
// @Summary Export dashboards as a portable bundle
// @Description Returns a JSON bundle containing the selected dashboards plus all components and connections they reference.
// @Tags dashboards
// @Accept json
// @Produce json
// @Param body body models.ExportRequest true "Dashboard IDs to export"
// @Success 200 {object} models.ExportBundle
// @Failure 400 {object} map[string]string
// @Router /api/dashboards/export [post]
func (h *DashboardHandler) ExportDashboards(c *gin.Context) {
	var req models.ExportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Stamp who built the bundle so future readers can tell. Header is
	// optional — handler stays usable from curl in dev.
	exportedBy := c.GetHeader("X-User-ID")
	bundle, err := h.service.BuildExport(c.Request.Context(), exportedBy, req.DashboardIDs)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, bundle)
}
