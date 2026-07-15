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
	if respondIfNamespaceForbidden(c, err) {
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
}

// respondIfNamespaceForbidden writes the uniform 403 and returns true
// when err is a namespace-grant miss (issue #4). For handlers whose
// own fallback is a 400 (validation-shaped errors) rather than a 500 —
// call this FIRST so an authorization failure isn't reported as a bad
// request. Returns false when err is something else, leaving the
// handler's existing mapping intact.
func respondIfNamespaceForbidden(c *gin.Context, err error) bool {
	if !errors.Is(err, authz.ErrNamespaceForbidden) {
		return false
	}
	c.JSON(http.StatusForbidden, gin.H{
		"error": "forbidden",
		"code":  "namespace_forbidden",
	})
	return true
}
