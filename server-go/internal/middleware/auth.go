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
	Exact      bool               // If true, match `path == PathPrefix` (with optional trailing slash) instead of prefix. Use to gate a collection root (e.g. GET /api/users) without affecting nested paths (GET /api/users/:id).
	// Public marks a route as exempt from the deployment-wide
	// "authentication required" default. Set this only for genuine
	// pre-auth surfaces — endpoints that must answer before a user
	// has identity, e.g. /api/auth/me (so the bootstrap can learn
	// "you have no identity, render the sign-in stub") and the
	// Clerk-publishable-key discovery on /api/config/system.
	// Every other endpoint inherits the secure default: no creds
	// → 401.
	Public bool
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

// buildRouteRules defines which routes require which capabilities.
//
// Authorize() now enforces "authenticated user required" as the
// deployment-wide default: any /api/* route without an explicit
// Public:true exemption requires the caller to have presented a
// valid credential (Clerk JWT, API key, or X-User-ID). Per-capability
// rules in this slice add the next layer — e.g. POST/PUT/DELETE on
// most routes require Design or Manage on top of "authenticated."
//
// The `view` capability is the floor: every user record we accept
// at creation time carries view (UserService.CreateUser /
// CreateSystemUser both inject it). So "authenticated" effectively
// means "view." We don't need a per-route View rule — the structural
// default does the work.
func buildRouteRules() []RouteCapability {
	return []RouteCapability{
		// PUBLIC routes — exempt from the auth-required default.
		// Only used for endpoints that must answer pre-identity.
		//
		// /api/auth/me: the SPA bootstrap calls this to ask the
		// server "who am I?" — it has to be reachable before
		// identity is resolved so the bootstrap can learn the
		// answer (or learn "no creds, render sign-in stub").
		//
		// /api/config/system: Clerk publishable key discovery
		// happens before sign-in. The response is whitelisted via
		// publicSystemConfigKeys (config_service.go) so the
		// exemption only exposes layout-dimensions + Clerk key,
		// never arbitrary system settings.
		//
		// /api/health: liveness probe. No identity required.
		{PathPrefix: "/api/auth/me", Method: "GET", Public: true, Exact: true},
		{PathPrefix: "/api/config/system", Method: "GET", Public: true, Exact: true},
		{PathPrefix: "/api/health", Method: "GET", Public: true, Exact: true},

		// Design mode routes - require design capability for write operations
		// Read operations are allowed for VIEW users so they can see dashboards

		// Connections - design required for write
		{PathPrefix: "/api/connections", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/connections", Method: "PUT", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/connections", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// Components - design required for write
		{PathPrefix: "/api/components", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/components", Method: "PUT", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/components", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

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

		// Users — every read and write requires Manage. There is no
		// self-management UI today, so non-Manage callers have no
		// reason to hit any `/api/users/*` endpoint. The SPA bootstrap
		// uses /api/auth/me for self-info (it carries id/guid/name/
		// capabilities), so locking the whole group is safe.
		{PathPrefix: "/api/users", Method: "GET", Required: models.CapabilityManage},

		// Settings — listing every user-configurable setting is admin-
		// only. Per-key reads (`/api/settings/:key`) stay open because
		// View/Design code legitimately reads individual runtime values
		// (tile_font_size, default_dashboard_fit_mode, enabled_types,
		// etc.) on every page load.
		{PathPrefix: "/api/settings", Method: "GET", Required: models.CapabilityManage, Exact: true},

		// System users — every operation is admin-only. These records
		// drive inbound-integration auth (e.g. ts-store webhook
		// receiver), so the full surface (list, create, delete, generate
		// key) is gated end-to-end.
		{PathPrefix: "/api/system-users", Required: models.CapabilityManage},

		// Inbound webhooks — gated on the dedicated webhook
		// capability. Making this an explicit rule (rather than
		// relying on "no rule = any authenticated caller") means the
		// contract is self-documenting: only principals carrying
		// `webhook` can POST to /api/webhooks/*. System users get
		// the capability at creation time; humans don't get it by
		// default. To revoke an integration without deleting it,
		// remove `webhook` from the system user's capabilities.
		{PathPrefix: "/api/webhooks", Required: models.CapabilityWebhook},
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
		// System users may only authenticate via API key. Allowing
		// a bare X-User-ID claim for a system principal would let
		// any unauthenticated caller impersonate the service.
		if user.IsSystem() {
			c.JSON(http.StatusForbidden, gin.H{"error": "System users must authenticate via API key"})
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
	// System users have no interactive sign-in path. An IdP token
	// resolving to a system user means the IdP linkage is wrong;
	// reject before we let it impersonate a service principal.
	if user.IsSystem() {
		c.JSON(http.StatusForbidden, gin.H{"error": "System users cannot sign in interactively"})
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

// Authorize checks if the current user has permission for the route.
//
// Policy:
//   - Explicit Public:true rule matches → allow without auth.
//   - Explicit capability rule matches → require that capability
//     (which implies the caller is authenticated).
//   - No rule matches → require the caller is authenticated, no
//     specific capability needed. This is the deployment-wide
//     "auth required by default" floor. Routes that genuinely need
//     to answer pre-auth (the bootstrap surface) must declare
//     themselves with Public:true.
func (m *AuthMiddleware) Authorize() gin.HandlerFunc {
	return func(c *gin.Context) {
		path := c.Request.URL.Path
		method := c.Request.Method

		// Public exemption — answer the route regardless of auth.
		if m.matchesPublic(path, method) {
			c.Next()
			return
		}

		// Find required capability for this route. Returns "" when
		// no rule matches; we treat that as "authenticated user
		// required, no specific capability."
		requiredCap := m.getRequiredCapability(path, method)

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

		// No specific capability needed beyond "authenticated."
		// Every user we accept at creation time carries view (the
		// floor), so this branch covers the common case: a logged-in
		// user reading whatever they're entitled to read.
		if requiredCap == "" {
			c.Next()
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

// matchesPublic reports whether the given path/method is exempt from
// the auth-required default — i.e. matches a rule with Public:true.
// Same matching semantics as getRequiredCapability (Exact vs prefix,
// optional method filter).
func (m *AuthMiddleware) matchesPublic(path, method string) bool {
	for _, rule := range m.rules {
		if !rule.Public {
			continue
		}
		var matches bool
		if rule.Exact {
			matches = path == rule.PathPrefix || path == rule.PathPrefix+"/"
		} else {
			matches = strings.HasPrefix(path, rule.PathPrefix)
		}
		if matches && (rule.Method == "" || rule.Method == method) {
			return true
		}
	}
	return false
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
		var matches bool
		if rule.Exact {
			// Exact-match rules gate the collection root (e.g.
			// GET /api/users) without affecting nested paths
			// (GET /api/users/:id). Trailing slash is tolerated so
			// /api/users/ behaves the same as /api/users.
			matches = path == rule.PathPrefix || path == rule.PathPrefix+"/"
		} else {
			matches = strings.HasPrefix(path, rule.PathPrefix)
		}
		if matches {
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
