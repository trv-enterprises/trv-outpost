// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import "github.com/gin-gonic/gin"

// normalizeAllPageSize rewrites a literal `page_size=all` query param to
// `page_size=0` in the request URL BEFORE struct binding, so the int bind
// succeeds and the service's ClampPageSize treats 0 as "all" (capped).
// Without this, `all` would fail to bind to an int field. Idempotent and
// safe to call on every list handler.
func normalizeAllPageSize(c *gin.Context) {
	q := c.Request.URL.Query()
	if q.Get("page_size") == "all" {
		q.Set("page_size", "0")
		c.Request.URL.RawQuery = q.Encode()
	}
}
