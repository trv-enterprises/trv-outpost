// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package middleware

import (
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// tsstoreSecretWebhookRE matches the secret-gated tsstore webhook
// receiver path `/api/webhooks/tsstore/<conn_id>/<secret>`. Anchored
// and segment-counted so the bare `/api/webhooks/tsstore/<conn_id>`
// (auth-required, legacy) doesn't accidentally inherit Public exemption.
var tsstoreSecretWebhookRE = regexp.MustCompile(`^/api/webhooks/tsstore/[^/]+/[^/]+/?$`)

const (
	// UserContextKey is the key used to store user in gin context.
	// Post-refactor this holds a JWT-derived *models.User shim, not
	// a freshly-fetched DB record. Handlers that need full fidelity
	// (admin mutations, audit fields) must re-fetch via userService.
	UserContextKey = "user"
	// ClaimsContextKey holds the parsed *auth.Claims. The right
	// surface for routine authz — DoesUserHavePriv reads from it.
	ClaimsContextKey = "claims"
)

// RouteCapability defines which capability is required for a route pattern
type RouteCapability struct {
	PathPrefix string             // Path prefix to match (e.g., "/api/dashboards")
	Method     string             // HTTP method (empty = all methods)
	Required   models.Capability  // Required capability
	WriteOnly  bool               // If true, only applies to write operations (POST, PUT, DELETE)
	Exact      bool               // If true, match `path == PathPrefix` (with optional trailing slash) instead of prefix. Use to gate a collection root (e.g. GET /api/users) without affecting nested paths (GET /api/users/:id).
	// PathPattern is an optional compiled regex evaluated *in addition
	// to* PathPrefix's prefix check. When set, the path must match
	// PathPrefix (prefix) AND PathPattern (anchored). Use this for
	// the rare case where Exact-vs-prefix isn't expressive enough —
	// e.g. distinguishing /api/webhooks/tsstore/<conn>/<secret>
	// (Public, secret-gated) from /api/webhooks/tsstore/<conn>
	// (auth-required). Both share a prefix.
	PathPattern *regexp.Regexp
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

// AuthMiddleware provides authentication and authorization. After
// the session-token refactor, every authenticated request carries
// our own access JWT — minted at /api/auth/session by trading any
// of the inbound credentials (Clerk JWT, API key, X-User-ID,
// ?user_id=) for a pair. Middleware here verifies the access
// token; the inbound channels live only at the bootstrap handler.
//
// userService stays so handlers needing a fully-populated *User
// (e.g. for admin operations that mutate the user record) can
// look it up from the JWT's UserID. Routine authz uses the JWT
// claims directly via DoesUserHavePriv.
type AuthMiddleware struct {
	userService *service.UserService
	sessions    *auth.SessionService
	apiKeys     *service.APIKeyService
	rules       []RouteCapability
}

// NewAuthMiddleware creates the session-token middleware.
//
// apiKeys is the only "back-channel" credential we still honor on
// every request: service principals (ts-store webhooks, dashboard-
// agent, scripts) send `Authorization: Bearer trve_…` directly
// rather than going through the bootstrap-then-session-token dance.
// The interactive (browser) auth flow goes through session tokens
// exclusively; API keys are explicitly the non-interactive shape.
// Pass nil if you genuinely want JWT-only.
func NewAuthMiddleware(
	userService *service.UserService,
	sessions *auth.SessionService,
	apiKeys *service.APIKeyService,
) *AuthMiddleware {
	return &AuthMiddleware{
		userService: userService,
		sessions:    sessions,
		apiKeys:     apiKeys,
		rules:       buildRouteRules(),
	}
}

// buildRouteRules defines which routes require which capabilities.
//
// Authorize() policy:
//   - Public:true rule matches → allow without auth (bootstrap
//     surfaces only).
//   - Explicit Required rule matches → require that capability.
//   - No rule matches → require CapabilityView. This is the
//     structural floor; everything that isn't an admin write needs
//     view at minimum.
//
// Why view-as-floor matters: webhook-only system users carry
// capabilities = [webhook] (no view). With view enforced
// implicitly, they can ONLY reach /api/webhooks/* — which has its
// own explicit Required:CapabilityWebhook rule. They can't snoop
// the dashboard. Kiosk system users carry [view] (or [view,
// webhook]) and work everywhere a read is expected.
//
// Practical consequence: the rules below don't enumerate view
// reads. They focus on the elevations (design, manage, webhook).
// Anything without a rule defaults to view.
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

		// Frigate proxy reads. Snapshot / thumbnail / clip / HLS
		// endpoints are loaded via `<img src=...>` / `<video src=...>`
		// in dashboard widgets — the browser fetches them as plain
		// anonymous GETs with no Authorization header, so the
		// auth-required default would 401 every widget on every
		// authenticated page. The sibling JSON endpoints (cameras /
		// events / reviews / info) are ALSO grouped here for
		// consistency: they describe what the media endpoints expose,
		// so the access posture is identical. POST stays gated by
		// the auth-required default — the only mutation here
		// (/reviews/viewed) needs a real user.
		//
		// Trade-off: any caller who knows a connection_id UUID can
		// read frigate media for that connection. The UUID is not
		// designed as a security boundary; this assumes the
		// deployment perimeter (e.g. tailnet, LAN, VPN) is the real
		// access control. Reconsider when we ship a public-facing
		// deployment.
		{PathPrefix: "/api/frigate/", Method: "GET", Public: true},

		// ts-store Alerts extension — read available to any
		// authenticated viewer; writes (create/delete a rule)
		// require Design. Matches the phase-2 decision: the
		// extension lives in Design mode, authoring is a Design
		// concern.
		{PathPrefix: "/api/tsstore-alerts", Method: "POST", Required: models.CapabilityDesign, WriteOnly: true},
		{PathPrefix: "/api/tsstore-alerts", Method: "DELETE", Required: models.CapabilityDesign, WriteOnly: true},

		// Secret-gated tsstore webhook receiver — the URL embeds a
		// per-connection random secret that the dashboard issues at
		// rule-creation time. Acts as the auth: handler rejects
		// unknown secrets as 404. Distinct from the bare
		// /api/webhooks/tsstore/<conn> path above (auth-required,
		// legacy). The pattern requires both <connection_id> and
		// <secret> path params, so it doesn't accidentally exempt
		// the legacy path from auth.
		{
			PathPrefix:  "/api/webhooks/tsstore/",
			PathPattern: tsstoreSecretWebhookRE,
			Method:      "POST",
			Public:      true,
		},

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

		// Control execution — its own capability, independent of
		// view/design/manage. A view-only kiosk (e.g. a lobby
		// display) can render dashboards but gets 403 when it tries
		// to fire a control; an interactive kiosk (e.g. the TV in
		// the kitchen) holds view+control. Designers and admins are
		// NOT implicitly granted control — they must hold it
		// explicitly. The boot migration backfills control on every
		// existing human user so today's clicks keep working.
		{PathPrefix: "/api/controls/", Method: "POST", Required: models.CapabilityControl, WriteOnly: true},

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

		// Settings — three rules with different posture per path/verb:
		//   1. GET /api/settings (collection root): Manage-only —
		//      listing every user-configurable setting is admin-tier.
		//   2. GET /api/settings/<key>: Public — View/Design code
		//      and the SPA bootstrap need to read individual runtime
		//      values (default_browser_user_guid, tile_font_size,
		//      default_dashboard_fit_mode, enabled_types, etc.)
		//      BEFORE identity is resolved. Under the auth-required
		//      default these would be 401, breaking the bootstrap
		//      Tier-3 admin-default fallback. Trailing slash on the
		//      prefix is intentional — `/api/settings` alone (no
		//      slash) keeps falling into rule (1).
		//   3. PUT /api/settings/<key>: Manage-only — the children
		//      need explicit gating because the Exact:true on rule
		//      (1) doesn't cover them, and we don't want any
		//      authenticated user mutating settings.
		{PathPrefix: "/api/settings", Method: "GET", Required: models.CapabilityManage, Exact: true},
		{PathPrefix: "/api/settings/", Method: "GET", Public: true},
		{PathPrefix: "/api/settings/", Method: "PUT", Required: models.CapabilityManage},

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
		// Two credential channels, dispatched by shape:
		//
		//   trve_…    → API key (long-lived, revocable). The
		//               credential IS the session — validated
		//               against the api_keys collection on every
		//               request, no bootstrap dance, no refresh.
		//               Used by ANY principal calling from outside
		//               a browser: ts-store webhook (system user),
		//               dashboard-agent CLI (system or human),
		//               kiosks, the user's own cron job script.
		//               Both human-minted keys (POST /api/api-keys)
		//               and admin-minted system-user keys (Manage →
		//               System Users → Generate) take this path
		//               identically.
		//   anything  → access JWT (short-lived; minted at
		//   else        /api/auth/session for interactive
		//               browser sessions only).
		//
		// Transport carriers, in order:
		//   1. Authorization: Bearer <token>   (fetch)
		//   2. ?st=<token>                     (EventSource / WS)
		//
		// API keys: the credential IS the session — revocation
		// happens by deleting the api_keys row, not by waiting
		// for an expiry. This is the standard service-principal
		// model (Stripe/GitHub-shape). Treating API keys as
		// "trade for a refresh JWT" would force admin-revoked
		// kiosks to wait out the refresh-token TTL before they
		// stop, which defeats the point of revocation.
		token := extractBearerToken(c)
		if token == "" {
			token = strings.TrimSpace(c.Query("st"))
		}
		if token == "" {
			// No credential — defer to Authorize(). Public:true rules
			// pass through; everything else gets 401.
			c.Next()
			return
		}

		// API-key shape: validate directly, no JWT involved.
		if strings.HasPrefix(token, "trve_") {
			if m.apiKeys == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "API keys not enabled"})
				c.Abort()
				return
			}
			key, err := m.apiKeys.Validate(c.Request.Context(), token)
			if err != nil || key == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid API key"})
				c.Abort()
				return
			}
			user, err := m.userService.GetUserByGUID(c.Request.Context(), key.UserGUID)
			if err != nil || user == nil {
				c.JSON(http.StatusUnauthorized, gin.H{"error": "API key owner not found"})
				c.Abort()
				return
			}
			if !user.Active {
				c.JSON(http.StatusForbidden, gin.H{"error": "API key owner inactive"})
				c.Abort()
				return
			}
			// Synthesize claims so downstream authz uses the same
			// shape regardless of which credential resolved. No
			// JWT minted — claims live only in the request context
			// for this single request.
			claims := &auth.Claims{
				UserID:        user.ID,
				GUID:          user.GUID,
				Capabilities:  user.Capabilities,
				Kind:          user.Kind,
				SourceChannel: "apikey",
				Type:          auth.TokenTypeAccess,
			}
			c.Set(ClaimsContextKey, claims)
			c.Set(UserContextKey, user)
			c.Next()
			return
		}

		// JWT shape: verify our access token.
		claims, err := m.sessions.VerifyAccessToken(token)
		if err != nil {
			if errors.Is(err, auth.ErrTokenExpired) {
				// Distinct status hint so the client knows to refresh
				// and retry instead of re-bootstrapping. apiClient's
				// 401-handler does the refresh round-trip on this.
				c.JSON(http.StatusUnauthorized, gin.H{
					"error": "Access token expired",
					"hint":  "refresh",
				})
				c.Abort()
				return
			}
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid access token"})
			c.Abort()
			return
		}

		c.Set(ClaimsContextKey, claims)
		c.Set(UserContextKey, claimsToUser(claims))
		c.Next()
	}
}

// claimsToUser builds a lightweight *User from JWT claims. Routine
// authz uses claims directly; this exists for handlers/code that
// still consume *User (e.g. legacy helpers, audit logging). Fields
// that aren't in the JWT (CreatedAt, Email, etc.) are zero — if a
// handler needs them, re-fetch from userService.
func claimsToUser(claims *auth.Claims) *models.User {
	if claims == nil {
		return nil
	}
	return &models.User{
		ID:           claims.UserID,
		GUID:         claims.GUID,
		Active:       true, // verified-token implies active at issuance
		Kind:         claims.Kind,
		Capabilities: claims.Capabilities,
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

		// "No explicit rule" no longer means "any authenticated user."
		// It means "authenticated user with the view capability."
		// Routes that don't declare a specific Required end up here:
		// they're reads, and reads require view. Webhook-only system
		// principals (capabilities = [webhook]) intentionally cannot
		// reach these routes — they should ONLY hit /api/webhooks/*,
		// which has its own explicit Required:CapabilityWebhook rule.
		// Kiosk system users (capabilities = [view] or [view, webhook])
		// fit cleanly.
		if requiredCap == "" {
			requiredCap = models.CapabilityView
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
		if !routeRuleMatches(rule, path, method) {
			continue
		}
		return true
	}
	return false
}

// routeRuleMatches centralises the path/method match logic so the
// Public exemption and the capability-lookup paths agree. Returns
// true iff path satisfies the rule's PathPrefix (Exact or prefix)
// AND its optional PathPattern AND its optional Method.
func routeRuleMatches(rule RouteCapability, path, method string) bool {
	var prefixOK bool
	if rule.Exact {
		prefixOK = path == rule.PathPrefix || path == rule.PathPrefix+"/"
	} else {
		prefixOK = strings.HasPrefix(path, rule.PathPrefix)
	}
	if !prefixOK {
		return false
	}
	if rule.PathPattern != nil && !rule.PathPattern.MatchString(path) {
		return false
	}
	if rule.Method != "" && rule.Method != method {
		return false
	}
	return true
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

// GetUser retrieves the user from gin context. Lightweight shim
// built from JWT claims — for code that needs full DB fidelity,
// re-fetch via userService.GetUser(ctx, GetUser(c).ID).
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

// GetClaims retrieves the parsed JWT claims from gin context. The
// right surface for routine authz: every authz check on a route
// after Authenticate() can read claims here and pass them to
// auth.DoesUserHavePriv.
func GetClaims(c *gin.Context) *auth.Claims {
	v, exists := c.Get(ClaimsContextKey)
	if !exists || v == nil {
		return nil
	}
	claims, ok := v.(*auth.Claims)
	if !ok {
		return nil
	}
	return claims
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
