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

// DeviceHandler handles device HTTP requests
type DeviceHandler struct {
	service          *service.DeviceService
	discoveryService *service.DeviceDiscoveryService
}

// NewDeviceHandler creates a new device handler
func NewDeviceHandler(service *service.DeviceService, discoveryService *service.DeviceDiscoveryService) *DeviceHandler {
	return &DeviceHandler{
		service:          service,
		discoveryService: discoveryService,
	}
}

// CreateDevice creates a new device
// @Summary Create a device
// @Description Create a new device instance
// @Tags devices
// @Accept json
// @Produce json
// @Param device body models.CreateDeviceRequest true "Device to create"
// @Success 201 {object} models.Device
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /devices [post]
func (h *DeviceHandler) CreateDevice(c *gin.Context) {
	var req models.CreateDeviceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	device, err := h.service.CreateDevice(c.Request.Context(), &req)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, device)
}

// GetDevice retrieves a device by ID
// @Summary Get a device
// @Description Get a device by ID
// @Tags devices
// @Produce json
// @Param id path string true "Device ID"
// @Success 200 {object} models.Device
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /devices/{id} [get]
func (h *DeviceHandler) GetDevice(c *gin.Context) {
	id := c.Param("id")

	device, err := h.service.GetDevice(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, device)
}

// UpdateDevice updates a device
// @Summary Update a device
// @Description Update an existing device
// @Tags devices
// @Accept json
// @Produce json
// @Param id path string true "Device ID"
// @Param device body models.UpdateDeviceRequest true "Fields to update"
// @Success 200 {object} models.Device
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /devices/{id} [put]
func (h *DeviceHandler) UpdateDevice(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateDeviceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	device, err := h.service.UpdateDevice(c.Request.Context(), id, &req)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid") {
			code := http.StatusNotFound
			if strings.Contains(err.Error(), "device type") || strings.Contains(err.Error(), "connection") {
				code = http.StatusBadRequest
			}
			c.JSON(code, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, device)
}

// DeleteDevice deletes a device
// @Summary Delete a device
// @Description Delete a device by ID
// @Tags devices
// @Param id path string true "Device ID"
// @Success 204
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /devices/{id} [delete]
func (h *DeviceHandler) DeleteDevice(c *gin.Context) {
	id := c.Param("id")

	err := h.service.DeleteDevice(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "invalid") {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// ListDevices lists devices with filtering
// @Summary List devices
// @Description List devices with optional filtering and pagination
// @Tags devices
// @Produce json
// @Param device_type_id query string false "Filter by device type ID"
// @Param connection_id query string false "Filter by connection ID"
// @Param room query string false "Filter by room"
// @Param enabled query bool false "Filter by enabled status"
// @Param page query int false "Page number"
// @Param page_size query int false "Page size"
// @Success 200 {object} models.DeviceListResponse
// @Failure 500 {object} map[string]string
// @Router /devices [get]
func (h *DeviceHandler) ListDevices(c *gin.Context) {
	var params models.DeviceQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	result, err := h.service.ListDevices(c.Request.Context(), &params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}

// ImportDevices bulk-imports discovered devices
// @Summary Import devices
// @Description Bulk import devices from discovery
// @Tags devices
// @Accept json
// @Produce json
// @Param request body models.ImportDevicesRequest true "Devices to import"
// @Success 201 {array} models.Device
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /devices/import [post]
func (h *DeviceHandler) ImportDevices(c *gin.Context) {
	var req models.ImportDevicesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	devices, err := h.service.ImportDevices(c.Request.Context(), &req)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, devices)
}

// DiscoverDevices triggers device discovery on a connection
// @Summary Discover devices
// @Description Discover devices on an MQTT connection (e.g., via Zigbee2MQTT bridge)
// @Tags devices
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} models.DiscoverDevicesResponse
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /connections/{id}/discover-devices [post]
func (h *DeviceHandler) DiscoverDevices(c *gin.Context) {
	connectionID := c.Param("id")

	result, err := h.discoveryService.DiscoverDevices(c.Request.Context(), connectionID)
	if err != nil {
		if strings.Contains(err.Error(), "not found") || strings.Contains(err.Error(), "not MQTT") {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}
