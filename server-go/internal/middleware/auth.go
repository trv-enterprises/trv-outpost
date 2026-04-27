// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

const (
	// UserContextKey is the key used to store user in gin context
	UserContextKey = "user"
	// AuthHeader is the header name for user GUID
	AuthHeader = "X-User-ID"
	// AuthQueryParam is the query parameter name for user GUID (fallback for EventSource)
	AuthQueryParam = "user_id"
)

// RouteCapability defines which capability is required for a route pattern
type RouteCapability struct {
	PathPrefix string             // Path prefix to match (e.g., "/api/dashboards")
	Method     string             // HTTP method (empty = all methods)
	Required   models.Capability  // Required capability
	WriteOnly  bool               // If true, only applies to write operations (POST, PUT, DELETE)
}

// AuthMiddleware provides authentication and authorization
type AuthMiddleware struct {
	userService   *service.UserService
	apiKeyService *service.APIKeyService
	rules         []RouteCapability
}

// NewAuthMiddleware creates a new auth middleware. The API key service
// is optional only in tests; production callers always pass a live
// service so `Authorization: Bearer trve_...` works.
func NewAuthMiddleware(userService *service.UserService, apiKeyService *service.APIKeyService) *AuthMiddleware {
	return &AuthMiddleware{
		userService:   userService,
		apiKeyService: apiKeyService,
		rules:         buildRouteRules(),
	}
}

// buildRouteRules defines which routes require which capabilities
func buildRouteRules() []RouteCapability {
	return []RouteCapability{
		// Design mode routes - require design capability for write operations
		// Read operations are allowed for VIEW users so they can see dashboards

		// Datasources - design required for write
		{PathPrefix: "/api/datasources", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/datasources", Method: "PUT", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/datasources", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// Charts - design required for write
		{PathPrefix: "/api/charts", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/charts", Method: "PUT", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/charts", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// Dashboards - design required for write
		{PathPrefix: "/api/dashboards", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/dashboards", Method: "PUT", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/dashboards", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// AI sessions - design required (AI builder is part of design)
		{PathPrefix: "/api/ai/sessions", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/ai/sessions", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// Manage mode routes - require manage capability
		{PathPrefix: "/api/config/system", Method: "PUT", Required: models.CapabilityManage, WriteOnly: true},
		{PathPrefix: "/api/users", Method: "POST", Required: models.CapabilityManage, WriteOnly: true},
		{PathPrefix: "/api/users", Method: "PUT", Required: models.CapabilityManage, WriteOnly: true},
		{PathPrefix: "/api/users", Method: "DELETE", Required: models.CapabilityManage, WriteOnly: true},

		// Namespaces - manage required for write (lives in Manage mode UI).
		// Reads are open so every authenticated client can populate pickers
		// and render namespace chips on list pages.
		{PathPrefix: "/api/namespaces", Method: "POST", Required: models.CapabilityManage, WriteOnly: true},
		{PathPrefix: "/api/namespaces", Method: "PUT", Required: models.CapabilityManage, WriteOnly: true},
		{PathPrefix: "/api/namespaces", Method: "DELETE", Required: models.CapabilityManage, WriteOnly: true},

		// API keys — every authenticated user can create/list/revoke
		// their OWN keys (no capability required). The deployment-wide
		// /api/api-keys/all view is admin-only, gated by a more specific
		// rule that wins because it appears first in the slice.
		{PathPrefix: "/api/api-keys/all", Method: "GET", Required: models.CapabilityManage},
	}
}

// Authenticate resolves the calling user from one of the supported
// credential channels and attaches the User to gin context for
// downstream handlers. Channels, in precedence order:
//
//  1. `Authorization: Bearer trve_...` — API key (preferred for
//     non-browser callers: dashboard-agent CLI, MCP clients, scripts).
//  2. `X-User-ID` header — legacy identity assertion (no real auth);
//     still used by the in-browser SPA. To be replaced by a real
//     session cookie in the v0.10.0 Clerk integration.
//  3. `?user_id=...` query param — fallback for EventSource, which
//     can't set custom headers. Same trust model as X-User-ID.
//  4. None of the above — continue unauthenticated. Route
//     authorization decides whether the unauthenticated path is
//     acceptable for the requested endpoint.
//
// A request that supplies both Bearer and X-User-ID is treated as
// Bearer-authenticated; X-User-ID is ignored when a valid bearer is
// present. This keeps the migration story sane: a caller can opt into
// the new path simply by adding the Authorization header.
func (m *AuthMiddleware) Authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1. Bearer token (API key)
		if token := extractBearerToken(c); token != "" && m.apiKeyService != nil {
			key, err := m.apiKeyService.Validate(c.Request.Context(), token)
			if err != nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
				c.Abort()
				return
			}
			user, err := m.userService.GetUserByGUID(c.Request.Context(), key.UserGUID)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to authenticate"})
				c.Abort()
				return
			}
			if user == nil {
				// Key references a deleted user — treat as invalid.
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
				c.Abort()
				return
			}
			if !user.Active {
				c.JSON(http.StatusForbidden, gin.H{"error": "User account is inactive"})
				c.Abort()
				return
			}
			c.Set(UserContextKey, user)
			c.Next()
			return
		}

		// 2 & 3. Legacy X-User-ID header / ?user_id query param
		guid := c.GetHeader(AuthHeader)
		if guid == "" {
			guid = c.Query(AuthQueryParam)
		}
		if guid == "" {
			// 4. No credentials — let route authorization decide.
			c.Next()
			return
		}

		user, err := m.userService.GetUserByGUID(c.Request.Context(), guid)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to authenticate"})
			c.Abort()
			return
		}

		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid user ID"})
			c.Abort()
			return
		}

		if !user.Active {
			c.JSON(http.StatusForbidden, gin.H{"error": "User account is inactive"})
			c.Abort()
			return
		}

		c.Set(UserContextKey, user)
		c.Next()
	}
}

// extractBearerToken pulls the token out of an `Authorization: Bearer
// <token>` header. Returns "" when the header is absent, empty, or
// uses a non-Bearer scheme. Case-insensitive on the scheme to match
// RFC 7235.
func extractBearerToken(c *gin.Context) string {
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

// Authorize checks if the current user has permission for the route
func (m *AuthMiddleware) Authorize() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		method := c.Request.Method

		// Find required capability for this route
		requiredCap := m.getRequiredCapability(path, method)
		if requiredCap == "" {
			// No specific capability required - allow all authenticated users
			c.Next()
			return
		}

		// Get user from context (may be nil if no auth header)
		userInterface, exists := c.Get(UserContextKey)
		if !exists || userInterface == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
			c.Abort()
			return
		}

		user, ok := userInterface.(*models.User)
		if !ok {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Invalid user context"})
			c.Abort()
			return
		}

		// Check if user has required capability
		if !user.HasCapability(requiredCap) {
			c.JSON(http.StatusForbidden, gin.H{
				"error":    "Access denied",
				"required": string(requiredCap),
				"message":  "You do not have permission to perform this action",
			})
			c.Abort()
			return
		}

		c.Next()
	}
}

// getRequiredCapability returns the capability required for a path/method
func (m *AuthMiddleware) getRequiredCapability(path, method string) models.Capability {
	// Streaming endpoints are read operations, allow all authenticated users
	// Even though /stream/aggregated uses POST, it's reading data not modifying it
	if strings.Contains(path, "/stream") {
		return "" // No specific capability required for streaming
	}

	// Query endpoints are also read operations
	if strings.HasSuffix(path, "/query") {
		return "" // No specific capability required for queries
	}

	for _, rule := range m.rules {
		if strings.HasPrefix(path, rule.PathPrefix) {
			if rule.Method == "" || rule.Method == method {
				return rule.Required
			}
		}
	}
	return "" // No specific capability required
}

// GetUser retrieves the user from gin context
func GetUser(c *gin.Context) *models.User {
	userInterface, exists := c.Get(UserContextKey)
	if !exists || userInterface == nil {
		return nil
	}
	user, ok := userInterface.(*models.User)
	if !ok {
		return nil
	}
	return user
}

// RequireAuth is a helper middleware that requires authentication
func RequireAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		user := GetUser(c)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
			c.Abort()
			return
		}
		c.Next()
	}
}

// RequireCapability creates a middleware that requires a specific capability
func RequireCapability(cap models.Capability) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := GetUser(c)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
			c.Abort()
			return
		}
		if !user.HasCapability(cap) {
			c.JSON(http.StatusForbidden, gin.H{
				"error":    "Access denied",
				"required": string(cap),
			})
			c.Abort()
			return
		}
		c.Next()
	}
}
