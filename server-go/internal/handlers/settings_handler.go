// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"fmt"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// validateSettingBounds rejects out-of-range values for keys with
// known min/max policy. Keys not listed here pass through unchanged
// — settings are otherwise unstructured.
func validateSettingBounds(key string, value interface{}) error {
	switch key {
	case auth.SettingAccessTTLKey:
		secs, ok := coerceInt64(value)
		if !ok {
			return fmt.Errorf("%s must be a number of seconds", key)
		}
		min := int64(auth.MinAccessTokenTTL.Seconds())
		max := int64(auth.MaxAccessTokenTTL.Seconds())
		if secs < min || secs > max {
			return fmt.Errorf("%s must be between %d and %d seconds", key, min, max)
		}
	case auth.SettingRefreshTTLKey:
		secs, ok := coerceInt64(value)
		if !ok {
			return fmt.Errorf("%s must be a number of seconds", key)
		}
		min := int64(auth.MinRefreshTokenTTL.Seconds())
		max := int64(auth.MaxRefreshTokenTTL.Seconds())
		if secs < min || secs > max {
			return fmt.Errorf("%s must be between %d and %d seconds", key, min, max)
		}
	}
	return nil
}

func coerceInt64(v interface{}) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int32:
		return int64(x), true
	case int64:
		return x, true
	case float32:
		return int64(x), true
	case float64:
		return int64(x), true
	}
	return 0, false
}

// SettingsHandler handles HTTP requests for settings
type SettingsHandler struct {
	service *service.SettingsService
}

// NewSettingsHandler creates a new SettingsHandler
func NewSettingsHandler(service *service.SettingsService) *SettingsHandler {
	return &SettingsHandler{
		service: service,
	}
}

// GetAllSettings godoc
// @Summary Get all user-configurable settings
// @Description Get all settings that can be modified by administrators
// @Tags settings
// @Accept json
// @Produce json
// @Success 200 {object} models.SettingsListResponse
// @Failure 500 {object} map[string]string
// @Router /settings [get]
func (h *SettingsHandler) GetAllSettings(c *gin.Context) {
	settings, err := h.service.GetAllSettings(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// Settings are config the client reads on load and acts on immediately
	// (e.g. title_font_size → --title-scale). With no cache directive the
	// browser applies heuristic caching to these 200 GETs and can serve a
	// just-changed value stale on the next reload. Forbid caching so a
	// settings change always takes effect on the next page load.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, models.SettingsListResponse{Settings: settings})
}

// GetSetting godoc
// @Summary Get a single setting
// @Description Get a single setting by key
// @Tags settings
// @Accept json
// @Produce json
// @Param key path string true "Setting key"
// @Success 200 {object} models.ConfigItem
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /settings/{key} [get]
func (h *SettingsHandler) GetSetting(c *gin.Context) {
	key := c.Param("key")

	setting, err := h.service.GetSetting(c.Request.Context(), key)
	if err != nil {
		if err.Error() == "setting not found: "+key {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// No caching — see GetAllSettings. A freshly-changed setting must not
	// be served stale from the browser cache on the next reload.
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, setting)
}

// UpdateSetting godoc
// @Summary Update a setting
// @Description Update the value of a user-configurable setting
// @Tags settings
// @Accept json
// @Produce json
// @Param key path string true "Setting key"
// @Param body body models.UpdateSettingRequest true "New value for the setting"
// @Success 200 {object} models.ConfigItem
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Failure 500 {object} map[string]string
// @Router /settings/{key} [put]
func (h *SettingsHandler) UpdateSetting(c *gin.Context) {
	key := c.Param("key")

	var req models.UpdateSettingRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body: " + err.Error()})
		return
	}

	// Validate / clamp specific keys at the boundary so the
	// session service (which only reads, never writes) doesn't have
	// to re-validate on every issuance. Defense in depth — the
	// session service ALSO clamps when reading, in case a value
	// reached the DB another way.
	if err := validateSettingBounds(key, req.Value); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	setting, err := h.service.UpdateSetting(c.Request.Context(), key, req.Value)
	if err != nil {
		errMsg := err.Error()
		if errMsg == "setting not found: "+key {
			c.JSON(http.StatusNotFound, gin.H{"error": errMsg})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		return
	}
	c.JSON(http.StatusOK, setting)
}

// RegisterRoutes registers the settings routes
func (h *SettingsHandler) RegisterRoutes(router *gin.RouterGroup) {
	settings := router.Group("/settings")
	{
		settings.GET("", h.GetAllSettings)
		settings.GET("/:key", h.GetSetting)
		settings.PUT("/:key", h.UpdateSetting)
	}
}
