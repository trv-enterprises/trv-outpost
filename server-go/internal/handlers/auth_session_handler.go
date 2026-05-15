// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/auth"
	"github.com/trv-enterprises/trve-dashboard/internal/auth/idp"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// AuthSessionHandler is the single bootstrap entry point. Every
// inbound credential (Clerk JWT, API key, X-User-ID, ?user_id=)
// arrives here once and is traded for our own access+refresh JWT
// pair. After this exchange, every other route only knows about our
// access token; the inbound channels are walled off to this handler.
type AuthSessionHandler struct {
	sessions     *auth.SessionService
	idps         *idp.Registry
	users        *service.UserService
	refreshCookie RefreshCookieConfig
}

// RefreshCookieConfig holds the cookie-shape policy. Refresh tokens
// ride an httpOnly cookie (XSS-immune); access tokens go in the
// JSON body (JS-readable for the apiClient to stamp on each call).
// Operators tune these via config — secure=true on HTTPS deploys,
// SameSite=Strict in production, Lax for dev so dev-server reloads
// don't lose the cookie.
type RefreshCookieConfig struct {
	Name     string // default "trve_refresh"
	Path     string // default "/api/auth"
	Domain   string // "" → host-only; set in multi-subdomain deployments
	Secure   bool   // true on HTTPS; false on plain HTTP dev / homelab
	SameSite http.SameSite
}

// DefaultRefreshCookie returns a sensible default cookie config.
// Path is scoped to /api/auth so the browser doesn't send the
// refresh cookie on every API call — only on /auth/session and
// /auth/refresh, the only routes that look at it.
func DefaultRefreshCookie() RefreshCookieConfig {
	return RefreshCookieConfig{
		Name:     "trve_refresh",
		Path:     "/api/auth",
		Secure:   false, // overridden in main.go when running behind HTTPS
		SameSite: http.SameSiteLaxMode,
	}
}

// NewAuthSessionHandler wires the bootstrap handler.
func NewAuthSessionHandler(sessions *auth.SessionService, idps *idp.Registry, users *service.UserService, cookie RefreshCookieConfig) *AuthSessionHandler {
	if cookie.Name == "" {
		cookie = DefaultRefreshCookie()
	}
	return &AuthSessionHandler{sessions: sessions, idps: idps, users: users, refreshCookie: cookie}
}

// SessionResponse is the JSON body returned by /api/auth/session and
// /api/auth/refresh. Refresh token does NOT appear here — it's set
// on an httpOnly cookie by the same response.
type SessionResponse struct {
	AccessToken    string                          `json:"access_token"`
	ExpiresAt      time.Time                       `json:"expires_at"`
	User           *models.UserCapabilitiesResponse `json:"user"`
}

// CreateSession handles POST /api/auth/session. Walks the IdP
// registry, finds the inbound credential, mints a token pair.
// Public:true at the middleware layer (this is the only route that
// can accept legacy inbound channels).
//
// @Summary Bootstrap a session from any supported inbound credential
// @Tags auth
// @Accept json
// @Produce json
// @Success 200 {object} SessionResponse
// @Failure 401 {object} map[string]string
// @Router /auth/session [post]
func (h *AuthSessionHandler) CreateSession(c *gin.Context) {
	user, provider, err := h.idps.Resolve(c.Request.Context(), c)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication failed", "detail": err.Error()})
		return
	}
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "No supported credential presented"})
		return
	}
	source := ""
	if provider != nil {
		source = provider.Name()
	}
	pair, err := h.sessions.IssueTokenPair(c.Request.Context(), user, source)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to issue tokens"})
		return
	}
	h.setRefreshCookie(c, pair.RefreshToken, pair.RefreshExpires)
	c.JSON(http.StatusOK, h.buildSessionResponse(pair, user))
}

// Refresh handles POST /api/auth/refresh. Reads the refresh token
// from the cookie, mints a rotated pair. On any failure clears
// the cookie so the client knows it has to re-bootstrap.
//
// @Summary Refresh access token using the refresh-cookie
// @Tags auth
// @Produce json
// @Success 200 {object} SessionResponse
// @Failure 401 {object} map[string]string
// @Router /auth/refresh [post]
func (h *AuthSessionHandler) Refresh(c *gin.Context) {
	raw, err := c.Cookie(h.refreshCookie.Name)
	if err != nil || raw == "" {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "No refresh cookie"})
		return
	}
	pair, err := h.sessions.RefreshTokenPair(c.Request.Context(), raw, h.users)
	if err != nil {
		h.clearRefreshCookie(c)
		status := http.StatusUnauthorized
		msg := "Refresh failed"
		switch {
		case errors.Is(err, auth.ErrTokenExpired):
			msg = "Refresh token expired"
		case errors.Is(err, auth.ErrRefreshRevoked):
			msg = "Refresh token revoked"
		case errors.Is(err, auth.ErrUserNotActive):
			msg = "User no longer active"
		}
		c.JSON(status, gin.H{"error": msg})
		return
	}
	user, _ := h.users.GetUser(c.Request.Context(), pair.AccessClaims.UserID)
	h.setRefreshCookie(c, pair.RefreshToken, pair.RefreshExpires)
	c.JSON(http.StatusOK, h.buildSessionResponse(pair, user))
}

// Logout revokes the refresh-token family and clears the cookie.
// Optional but a clean affordance — without it, the only way to
// drop a session is to wait for refresh-token expiry.
//
// @Summary Revoke the current session
// @Tags auth
// @Success 204
// @Router /auth/logout [post]
func (h *AuthSessionHandler) Logout(c *gin.Context) {
	raw, _ := c.Cookie(h.refreshCookie.Name)
	if raw != "" {
		// Best-effort decode — we want the family_id even if the
		// token is expired. ParseWithClaims will give us claims back
		// on an exp failure (just sets the err), but going through
		// VerifyToken with the right type gives us standardized
		// errors. Even an invalid token: clear the cookie and call it
		// a success — the user wanted out.
		if claims, _ := h.sessions.PeekClaims(raw); claims != nil && claims.FamilyID != "" {
			_ = h.sessions.RevokeFamily(c.Request.Context(), claims.FamilyID, "logout", claims.GUID)
		}
	}
	h.clearRefreshCookie(c)
	c.Status(http.StatusNoContent)
}

func (h *AuthSessionHandler) buildSessionResponse(pair *auth.TokenPair, user *models.User) *SessionResponse {
	resp := &SessionResponse{
		AccessToken: pair.AccessToken,
		ExpiresAt:   pair.AccessExpires,
	}
	if user != nil {
		resp.User = &models.UserCapabilitiesResponse{
			UserID:       user.ID,
			GUID:         user.GUID,
			Name:         user.Name,
			Active:       user.Active,
			Capabilities: user.Capabilities,
			CanDesign:    user.HasCapability(models.CapabilityDesign),
			CanManage:    user.HasCapability(models.CapabilityManage),
		}
	}
	return resp
}

func (h *AuthSessionHandler) setRefreshCookie(c *gin.Context, token string, expires time.Time) {
	maxAge := int(time.Until(expires).Seconds())
	if maxAge < 0 {
		maxAge = 0
	}
	c.SetSameSite(h.refreshCookie.SameSite)
	c.SetCookie(
		h.refreshCookie.Name,
		token,
		maxAge,
		h.refreshCookie.Path,
		h.refreshCookie.Domain,
		h.refreshCookie.Secure,
		true, // httpOnly — JS can't touch it
	)
}

func (h *AuthSessionHandler) clearRefreshCookie(c *gin.Context) {
	c.SetSameSite(h.refreshCookie.SameSite)
	c.SetCookie(
		h.refreshCookie.Name,
		"",
		-1,
		h.refreshCookie.Path,
		h.refreshCookie.Domain,
		h.refreshCookie.Secure,
		true,
	)
}
