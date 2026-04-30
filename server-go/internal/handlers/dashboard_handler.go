// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
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

// ListDashboards retrieves a list of dashboards with pagination
// @Summary List dashboards
// @Description Get a paginated list of dashboards with optional filtering. Use include_datasources=true to get data source names for each dashboard.
// @Tags dashboards
// @Produce json
// @Param name query string false "Filter by name (partial match)"
// @Param is_public query boolean false "Filter by public status"
// @Param include_datasources query boolean false "Include data source names from charts"
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size" default(20)
// @Success 200 {object} models.DashboardListResponse "Standard response"
// @Success 200 {object} models.DashboardSummaryListResponse "Response when include_datasources=true"
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /dashboards [get]
func (h *DashboardHandler) ListDashboards(c *gin.Context) {
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

	err := h.service.DeleteDashboard(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Dashboard not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}
