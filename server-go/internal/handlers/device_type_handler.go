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

// DeviceTypeHandler handles device type HTTP requests
type DeviceTypeHandler struct {
	service *service.DeviceTypeService
}

// NewDeviceTypeHandler creates a new device type handler
func NewDeviceTypeHandler(service *service.DeviceTypeService) *DeviceTypeHandler {
	return &DeviceTypeHandler{
		service: service,
	}
}

// CreateDeviceType creates a new device type
// @Summary Create a device type
// @Description Create a new device type template
// @Tags device-types
// @Accept json
// @Produce json
// @Param device_type body models.CreateDeviceTypeRequest true "Device type to create"
// @Success 201 {object} models.DeviceType
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /device-types [post]
func (h *DeviceTypeHandler) CreateDeviceType(c *gin.Context) {
	var req models.CreateDeviceTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dt, err := h.service.CreateDeviceType(c.Request.Context(), &req)
	if err != nil {
		if strings.Contains(err.Error(), "already exists") ||
			strings.Contains(err.Error(), "invalid category") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, dt)
}

// GetDeviceType retrieves a device type by ID
// @Summary Get a device type
// @Description Get a device type by ID
// @Tags device-types
// @Produce json
// @Param id path string true "Device type ID"
// @Success 200 {object} models.DeviceType
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /device-types/{id} [get]
func (h *DeviceTypeHandler) GetDeviceType(c *gin.Context) {
	id := c.Param("id")

	dt, err := h.service.GetDeviceType(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, dt)
}

// UpdateDeviceType updates a device type
// @Summary Update a device type
// @Description Update an existing device type
// @Tags device-types
// @Accept json
// @Produce json
// @Param id path string true "Device type ID"
// @Param device_type body models.UpdateDeviceTypeRequest true "Fields to update"
// @Success 200 {object} models.DeviceType
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /device-types/{id} [put]
func (h *DeviceTypeHandler) UpdateDeviceType(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateDeviceTypeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	dt, err := h.service.UpdateDeviceType(c.Request.Context(), id, &req)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "cannot modify") ||
			strings.Contains(err.Error(), "invalid category") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, dt)
}

// DeleteDeviceType deletes a device type
// @Summary Delete a device type
// @Description Delete a device type by ID
// @Tags device-types
// @Param id path string true "Device type ID"
// @Success 204
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /device-types/{id} [delete]
func (h *DeviceTypeHandler) DeleteDeviceType(c *gin.Context) {
	id := c.Param("id")

	err := h.service.DeleteDeviceType(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		if strings.Contains(err.Error(), "cannot delete") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// ListDeviceTypes lists device types with filtering
// @Summary List device types
// @Description List device types with optional filtering and pagination
// @Tags device-types
// @Produce json
// @Param category query string false "Filter by category"
// @Param protocol query string false "Filter by protocol"
// @Param built_in_only query bool false "Show only built-in types"
// @Param page query int false "Page number"
// @Param page_size query int false "Page size"
// @Success 200 {object} models.DeviceTypeListResponse
// @Failure 500 {object} map[string]string
// @Router /device-types [get]
func (h *DeviceTypeHandler) ListDeviceTypes(c *gin.Context) {
	var params models.DeviceTypeQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	result, err := h.service.ListDeviceTypes(c.Request.Context(), &params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// GetCategories returns valid device categories
// @Summary Get valid device categories
// @Description Get the list of valid device categories
// @Tags device-types
// @Produce json
// @Success 200 {array} string
// @Router /device-types/categories [get]
func (h *DeviceTypeHandler) GetCategories(c *gin.Context) {
	c.JSON(http.StatusOK, models.ValidDeviceCategories())
}

// GetControlTypes returns valid control UI types
// @Summary Get valid control types
// @Description Get the list of valid control UI types (toggle, scalar, button, text, plug, dimmer)
// @Tags device-types
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Router /device-types/control-types [get]
func (h *DeviceTypeHandler) GetControlTypes(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"types": models.ValidControlUITypes(),
		"descriptions": map[string]string{
			models.ControlUITypeToggle: "On/off switch, sends boolean value",
			models.ControlUITypeScalar: "Slider/numeric input, sends number value",
			models.ControlUITypeButton: "Action trigger, sends null (fires event only)",
			models.ControlUITypeText:   "Text/command input, sends string value",
			models.ControlUITypePlug:   "Smart plug toggle, sends boolean value",
			models.ControlUITypeDimmer: "Vertical slider with on/off, sends number (0=off)",
		},
	})
}
