// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// ChartHandler handles chart-related HTTP requests
type ChartHandler struct {
	service *service.ChartService
}

// NewChartHandler creates a new chart handler
func NewChartHandler(service *service.ChartService) *ChartHandler {
	return &ChartHandler{
		service: service,
	}
}

// CreateChart creates a new chart
// @Summary Create a new chart
// @Description Create a new chart with data source binding and visualization config. Creates as version 1 with status "final".
// @Tags charts
// @Accept json
// @Produce json
// @Param chart body models.CreateChartRequest true "Chart data"
// @Success 201 {object} models.Chart
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts [post]
func (h *ChartHandler) CreateChart(c *gin.Context) {
	var req models.CreateChartRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	chart, err := h.service.CreateChart(c.Request.Context(), &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "already exists") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, chart)
}

// GetChart retrieves the latest version of a chart by ID
// @Summary Get a chart
// @Description Get the latest version of a chart by ID
// @Tags charts
// @Produce json
// @Param id path string true "Chart ID"
// @Success 200 {object} models.Chart
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id} [get]
func (h *ChartHandler) GetChart(c *gin.Context) {
	id := c.Param("id")

	chart, err := h.service.GetChart(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, chart)
}

// GetChartVersion retrieves a specific version of a chart
// @Summary Get a specific chart version
// @Description Get a specific version of a chart by ID and version number
// @Tags charts
// @Produce json
// @Param id path string true "Chart ID"
// @Param version path int true "Version number"
// @Success 200 {object} models.Chart
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/versions/{version} [get]
func (h *ChartHandler) GetChartVersion(c *gin.Context) {
	id := c.Param("id")
	versionStr := c.Param("version")

	version, err := strconv.Atoi(versionStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid version number"})
		return
	}

	chart, err := h.service.GetChartVersion(c.Request.Context(), id, version)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, chart)
}

// ListChartVersions retrieves all versions of a chart
// @Summary List chart versions
// @Description Get all versions of a chart by ID
// @Tags charts
// @Produce json
// @Param id path string true "Chart ID"
// @Success 200 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/versions [get]
func (h *ChartHandler) ListChartVersions(c *gin.Context) {
	id := c.Param("id")

	versions, err := h.service.ListChartVersions(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

// GetChartVersionInfo retrieves version metadata for delete dialogs
// @Summary Get chart version info
// @Description Get version metadata for a chart (version count, has draft, etc.)
// @Tags charts
// @Produce json
// @Param id path string true "Chart ID"
// @Success 200 {object} models.ChartVersionInfo
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/version-info [get]
func (h *ChartHandler) GetChartVersionInfo(c *gin.Context) {
	id := c.Param("id")

	info, err := h.service.GetVersionInfo(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, info)
}

// GetChartDraft retrieves the draft version of a chart
// @Summary Get chart draft
// @Description Get the draft version of a chart (if exists)
// @Tags charts
// @Produce json
// @Param id path string true "Chart ID"
// @Success 200 {object} models.Chart
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/draft [get]
func (h *ChartHandler) GetChartDraft(c *gin.Context) {
	id := c.Param("id")

	chart, err := h.service.GetChartDraft(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no draft found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "No draft found for chart"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, chart)
}

// ListCharts retrieves a list of charts with pagination
// @Summary List charts
// @Description Get a paginated list of charts (latest version of each) with optional filtering
// @Tags charts
// @Produce json
// @Param name query string false "Filter by name (case-insensitive word-prefix match — `ts` matches `TS-Store` but not `Lights`)"
// @Param chart_type query string false "Filter by chart type"
// @Param component_type query string false "Filter by component type (chart, control, display)"
// @Param status query string false "Filter by status (draft, final)"
// @Param datasource_id query string false "Filter by data source ID"
// @Param tag query string false "Filter by tag"
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size" default(20)
// @Success 200 {object} models.ChartListResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts [get]
func (h *ChartHandler) ListCharts(c *gin.Context) {
	var params models.ChartQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	response, err := h.service.ListCharts(c.Request.Context(), params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetChartSummaries retrieves lightweight chart summaries for card display
// @Summary Get chart summaries
// @Description Get lightweight chart summaries for card-based selection UI
// @Tags charts
// @Produce json
// @Param limit query int false "Maximum number of summaries" default(50)
// @Success 200 {array} models.ChartSummary
// @Failure 500 {object} map[string]interface{}
// @Router /charts/summaries [get]
func (h *ChartHandler) GetChartSummaries(c *gin.Context) {
	limit := int64(50)
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.ParseInt(l, 10, 64); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	summaries, err := h.service.GetChartSummaries(c.Request.Context(), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"summaries": summaries})
}

// UpdateChart updates the latest version of a chart in-place
// @Summary Update a chart
// @Description Update the latest version of a chart in-place (for manual edits)
// @Tags charts
// @Accept json
// @Produce json
// @Param id path string true "Chart ID"
// @Param chart body models.UpdateChartRequest true "Chart update data"
// @Success 200 {object} models.Chart
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id} [put]
func (h *ChartHandler) UpdateChart(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateChartRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	chart, err := h.service.UpdateChart(c.Request.Context(), id, &req)
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

	c.JSON(http.StatusOK, chart)
}

// DeleteChart deletes all versions of a chart
// @Summary Delete a chart
// @Description Delete all versions of a chart by ID
// @Tags charts
// @Param id path string true "Chart ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id} [delete]
func (h *ChartHandler) DeleteChart(c *gin.Context) {
	id := c.Param("id")

	err := h.service.DeleteChart(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// DeleteChartVersion deletes a specific version of a chart
// @Summary Delete a chart version
// @Description Delete a specific version of a chart
// @Tags charts
// @Param id path string true "Chart ID"
// @Param version path int true "Version number"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/versions/{version} [delete]
func (h *ChartHandler) DeleteChartVersion(c *gin.Context) {
	id := c.Param("id")
	versionStr := c.Param("version")

	version, err := strconv.Atoi(versionStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid version number"})
		return
	}

	err = h.service.DeleteChartVersion(c.Request.Context(), id, version)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Chart version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// DeleteChartDraft deletes only the draft version of a chart
// @Summary Delete chart draft
// @Description Delete the draft version of a chart (if exists)
// @Tags charts
// @Param id path string true "Chart ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /charts/{id}/draft [delete]
func (h *ChartHandler) DeleteChartDraft(c *gin.Context) {
	id := c.Param("id")

	err := h.service.DeleteChartDraft(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no draft found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "No draft found for chart"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}
