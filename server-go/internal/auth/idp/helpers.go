// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package idp

import (
	"strings"

	"github.com/gin-gonic/gin"
)

// ExtractBearer pulls the token out of an `Authorization: Bearer <t>`
// header. Returns "" when absent, empty, or non-Bearer scheme.
// Case-insensitive on the scheme to match RFC 7235.
func ExtractBearer(c *gin.Context) string {
	auth := c.GetHeader("Authorization")
	if auth == "" {
		return ""
	}
	const prefix = "Bearer "
	if len(auth) <= len(prefix) {
		return ""
	}
	if !strings.EqualFold(auth[:len(prefix)], prefix) {
		return ""
	}
	return strings.TrimSpace(auth[len(prefix):])
}

// LooksLikeAPIKey distinguishes a dashboard API key from a JWT. API
// keys are exactly `trve_<base32>`; JWTs are dot-delimited base64.
func LooksLikeAPIKey(token string) bool {
	return strings.HasPrefix(token, "trve_")
}
