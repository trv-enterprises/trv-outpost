// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/authz"
)

// respondError is the uniform terminal error response for service-layer
// failures (issue #4). Namespace-grant misses map to a stable 403 shape
// with NO entity details — the client keys off code=="namespace_forbidden"
// to render its "no access to this namespace" state. Everything else
// keeps the legacy 500 behavior.
func respondError(c *gin.Context, err error) {
	if errors.Is(err, authz.ErrNamespaceForbidden) {
		c.JSON(http.StatusForbidden, gin.H{
			"error": "forbidden",
			"code":  "namespace_forbidden",
		})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}
