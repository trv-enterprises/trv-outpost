// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
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
	userService     *service.UserService
	apiKeyService   *service.APIKeyService
	identityVerifier auth.IdentityVerifier   // nil when Clerk/OIDC mode is disabled
	userRepo        *repository.UserRepository // for ResolveUserByVerifiedIdentity
	rules           []RouteCapability
}

// NewAuthMiddleware creates a new auth middleware. The API key service
// is required for production. The identityVerifier is optional —
// nil means "no external IdP configured, fall through to API-key /
// X-User-ID legacy auth." When non-nil, Bearer tokens that don't look
// like API keys are dispatched to the verifier (Clerk JWTs today,
// generic OIDC in v0.11). userRepo is used by the verified-identity
// resolution path.
func NewAuthMiddleware(
	userService *service.UserService,
	apiKeyService *service.APIKeyService,
	identityVerifier auth.IdentityVerifier,
	userRepo *repository.UserRepository,
) *AuthMiddleware {
	return &AuthMiddleware{
		userService:      userService,
		apiKeyService:    apiKeyService,
		identityVerifier: identityVerifier,
		userRepo:         userRepo,
		rules:            buildRouteRules(),
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
//  1. `Authorization: Bearer <token>` — dispatched by token shape:
//     a) `trve_…` → API key (validated by APIKeyService).
//     b) anything else → Clerk JWT (validated by IdentityVerifier
//        when configured; otherwise rejected as 401).
//  2. `?token=<token>` query param — fallback for EventSource, which
//     can't set custom headers. Same shape-based dispatch as the
//     Bearer header: `trve_…` → API key, anything else → JWT.
//     Bypassed when the request also has an Authorization header
//     (header wins).
//  3. `X-User-ID` header — legacy identity assertion. Still useful
//     for migration and dev (`npm run dev` user switcher). Trust
//     model: anyone who knows a GUID becomes that user. Use a real
//     auth path in production.
//  4. `?user_id=<guid>` query param — same trust as #3, kept for
//     EventSource on legacy deployments.
//  5. None of the above — continue unauthenticated. Route
//     authorization decides whether the unauthenticated path is
//     acceptable for the requested endpoint.
//
// Multiple credentials at once: precedence order applies; later
// channels are ignored if an earlier one validates. A failed Bearer
// returns 401 immediately rather than falling through — the caller
// asked for Bearer auth and got it wrong.
func (m *AuthMiddleware) Authenticate() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 1. Authorization: Bearer …
		if token := extractBearerToken(c); token != "" {
			m.authenticateBearer(c, token)
			return
		}

		// 2. ?token=<token> — query-param fallback for EventSource.
		// Accept both API keys and (when configured) JWTs; dispatch
		// by token shape inside authenticateBearer.
		if qToken := strings.TrimSpace(c.Query("token")); qToken != "" {
			if looksLikeAPIKey(qToken) || m.identityVerifier != nil {
				m.authenticateBearer(c, qToken)
				return
			}
		}

		// 3 & 4. Legacy X-User-ID header / ?user_id query param
		guid := c.GetHeader(AuthHeader)
		if guid == "" {
			guid = c.Query(AuthQueryParam)
		}
		if guid == "" {
			// 5. No credentials — let route authorization decide.
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

// authenticateBearer dispatches a Bearer token to the right validator
// based on its shape. Aborts the request with 401/403 on failure.
func (m *AuthMiddleware) authenticateBearer(c *gin.Context, token string) {
	if looksLikeAPIKey(token) {
		m.authenticateAPIKey(c, token)
		return
	}
	// Anything that isn't an API key gets routed to the configured
	// IdP verifier. If no verifier is configured, this is a 401 —
	// arbitrary opaque tokens are not honored.
	if m.identityVerifier == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "No identity provider configured for this token type"})
		c.Abort()
		return
	}
	m.authenticateIdP(c, token)
}

// authenticateAPIKey validates a `trve_…` token and sets the user
// context. Used by dashboard-agent, MCP clients, and scripts.
func (m *AuthMiddleware) authenticateAPIKey(c *gin.Context, token string) {
	if m.apiKeyService == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "API keys are not enabled"})
		c.Abort()
		return
	}
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
}

// authenticateIdP validates a JWT against the configured identity
// verifier (Clerk today) and resolves to a dashboard User using the
// hybrid Clerk-ID-then-email JIT-link policy.
func (m *AuthMiddleware) authenticateIdP(c *gin.Context, token string) {
	identity, err := m.identityVerifier.VerifyToken(c.Request.Context(), token)
	if err != nil {
		// Don't leak verifier internals to the caller — this is a
		// classic 401 either way.
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid session token"})
		c.Abort()
		return
	}

	user, err := auth.ResolveUserByVerifiedIdentity(c.Request.Context(), m.userRepo, identity)
	if err != nil {
		if errors.Is(err, auth.ErrUserNotAuthorized) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "Account not authorized for this deployment",
				"hint":  "An admin must create a matching user record before you can sign in.",
			})
			c.Abort()
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to authenticate"})
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

// looksLikeAPIKey is the cheap dispatch test for distinguishing a
// dashboard API key from anything else (currently always a Clerk JWT
// when an IdP is configured). API keys are exactly `trve_<base32>`;
// JWTs are dot-delimited base64. Easy and unambiguous.
func looksLikeAPIKey(token string) bool {
	return strings.HasPrefix(token, "trve_")
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
