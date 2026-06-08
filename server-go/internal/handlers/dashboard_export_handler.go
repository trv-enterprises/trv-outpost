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
// @Router /dashboards/export/preview [post]
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
// @Router /dashboards/export [post]
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

// PreflightImport classifies every object in the incoming bundle into
// identical / conflicts / new / blocked. Read-only — the UI calls this
// repeatedly as the user changes target namespace or reviews diffs.
//
// @Summary Preflight an import bundle
// @Description Classifies each object in the bundle as identical/conflict/new/blocked so the UI can show what would change before the user commits.
// @Tags dashboards
// @Accept json
// @Produce json
// @Param body body models.ImportPreflightRequest true "Bundle and target namespace"
// @Success 200 {object} models.ImportPreflightResponse
// @Failure 400 {object} map[string]string
// @Router /dashboards/import/preflight [post]
func (h *DashboardHandler) PreflightImport(c *gin.Context) {
	var req models.ImportPreflightRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, err := h.service.PreflightImport(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// ApplyImport commits the bundle. The server re-runs preflight
// internally so a changed target_namespace or a race with another
// writer can't slip a blocked record through.
//
// @Summary Apply an import bundle
// @Description Writes the bundle's objects into the target namespace. Identical objects are skipped; conflicts are overwritten unless OverwriteDecisions explicitly opts out; blocked objects cause the whole apply to refuse.
// @Tags dashboards
// @Accept json
// @Produce json
// @Param body body models.ImportApplyRequest true "Bundle, target namespace, and per-object overwrite decisions"
// @Success 200 {object} models.ImportApplyResponse
// @Failure 400 {object} map[string]string
// @Router /dashboards/import/apply [post]
func (h *DashboardHandler) ApplyImport(c *gin.Context) {
	var req models.ImportApplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, err := h.service.ApplyImport(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}
