// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// RequireExtensionEnabled returns a gin middleware that 403s the
// request when the admin setting `extensions.<id>.enabled` is false.
// Extension toggles live in the settings collection and are owned by
// admins via the Manage > Settings UI. When an extension is off both
// its sidebar entry (client side) and its API surface (this gate)
// disappear.
//
// settingKey is the full setting key, e.g. `extensions.tsstore_alerts.enabled`.
// extensionLabel is the short user-facing name surfaced in the 403 body.
func RequireExtensionEnabled(settings *service.SettingsService, settingKey, extensionLabel string) gin.HandlerFunc {
	return func(c *gin.Context) {
		item, err := settings.GetSetting(c.Request.Context(), settingKey)
		if err != nil || item == nil {
			c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
				"error":   "extension_unavailable",
				"message": extensionLabel + " extension is not configured",
			})
			return
		}

		enabled, _ := item.Value.(bool)
		if !enabled {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"error":   "extension_disabled",
				"message": extensionLabel + " extension is disabled. Enable it in Manage > Settings.",
			})
			return
		}

		c.Next()
	}
}
