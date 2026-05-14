// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// ConfigHandler handles HTTP requests for app configuration
type ConfigHandler struct {
	service *service.ConfigService
}

// NewConfigHandler creates a new ConfigHandler
func NewConfigHandler(service *service.ConfigService) *ConfigHandler {
	return &ConfigHandler{service: service}
}

// GetSystemConfig godoc
// @Summary Get system configuration
// @Description Retrieves system-wide configuration including layout dimensions
// @Tags config
// @Produce json
// @Success 200 {object} models.SystemConfigResponse
// @Failure 500 {object} map[string]string
// @Router /config/system [get]
func (h *ConfigHandler) GetSystemConfig(c *gin.Context) {
	config, err := h.service.GetSystemConfig(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, config)
}

// UpdateSystemConfig godoc
// @Summary Update system configuration
// @Description Updates system-wide configuration settings
// @Tags config
// @Accept json
// @Produce json
// @Param request body models.UpdateConfigRequest true "Configuration settings to update"
// @Success 200 {object} models.SystemConfigResponse
// @Failure 400 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /config/system [put]
func (h *ConfigHandler) UpdateSystemConfig(c *gin.Context) {
	var req models.UpdateConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	config, err := h.service.UpdateSystemConfig(c.Request.Context(), req.Settings)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, config)
}

// requireSelf enforces that the path's :user_id matches the caller's
// own GUID. Per-user config is read/written ONLY by its owner — no
// admin override on these routes. Admin cleanup happens through
// UserService.DeleteUser, which cascades to ConfigRepository.
// DeleteUserConfig directly (not via this HTTP surface).
//
// Why we don't just trust the auth middleware: the middleware proves
// "the caller is some authenticated user," but the :user_id path
// param is caller-controlled. Without this check, any signed-in user
// could read or write any other user's preferences. As user-config
// accrues more keys (default_dashboard_id today; potentially API
// preferences, dashboard pins, layout state, etc.) the "leak any
// user's settings" surface keeps growing — lock it down once at the
// handler.
//
// Returns true when the caller may proceed; false and aborts the
// request with 403 otherwise.
func requireSelf(c *gin.Context) bool {
	caller := middleware.GetUser(c)
	if caller == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return false
	}
	if c.Param("user_id") != caller.GUID {
		c.JSON(http.StatusForbidden, gin.H{"error": "Per-user config is self-only"})
		return false
	}
	return true
}

// GetUserConfig godoc
// @Summary Get user configuration
// @Description Retrieves configuration for the calling user. The path's user_id MUST equal the caller's own GUID — admin overrides are not honored on this route.
// @Tags config
// @Produce json
// @Param user_id path string true "User GUID — must match the caller's own"
// @Success 200 {object} models.UserConfigResponse
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /config/user/{user_id} [get]
func (h *ConfigHandler) GetUserConfig(c *gin.Context) {
	if !requireSelf(c) {
		return
	}
	userID := c.Param("user_id")

	config, err := h.service.GetUserConfig(c.Request.Context(), userID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, config)
}

// UpdateUserConfig godoc
// @Summary Update user configuration
// @Description Updates configuration for the calling user. The path's user_id MUST equal the caller's own GUID — admin overrides are not honored on this route.
// @Tags config
// @Accept json
// @Produce json
// @Param user_id path string true "User GUID — must match the caller's own"
// @Param request body models.UpdateConfigRequest true "Configuration settings to update"
// @Success 200 {object} models.UserConfigResponse
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /config/user/{user_id} [put]
func (h *ConfigHandler) UpdateUserConfig(c *gin.Context) {
	if !requireSelf(c) {
		return
	}
	userID := c.Param("user_id")

	var req models.UpdateConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	config, err := h.service.UpdateUserConfig(c.Request.Context(), userID, req.Settings)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, config)
}
