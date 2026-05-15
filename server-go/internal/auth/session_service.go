// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package auth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// Default TTLs when admin settings are missing or unreadable. Per
// Tom 2026-05-15: tokens already issued keep their original exp
// regardless of setting changes — only fresh issuance reads current
// policy.
const (
	DefaultAccessTokenTTL  = 15 * time.Minute
	DefaultRefreshTokenTTL = 7 * 24 * time.Hour

	// Bounds enforced by the settings handler. Listed here so the
	// session service has a stable reference for clamping; the
	// admin settings handler should clamp too (defense in depth).
	MinAccessTokenTTL  = 1 * time.Minute
	MaxAccessTokenTTL  = 1 * time.Hour
	MinRefreshTokenTTL = 1 * time.Hour
	MaxRefreshTokenTTL = 30 * 24 * time.Hour

	// Cache TTL on the in-memory settings cache. Issuance is on the
	// request hot path; we don't want to round-trip to Mongo for
	// every token mint. 30s is short enough that admin changes take
	// effect promptly on the human timescale.
	settingsCacheTTL = 30 * time.Second

	// Admin-settings keys. Same naming convention as the rest of
	// the settings ledger.
	SettingAccessTTLKey  = "auth.access_token_ttl_seconds"
	SettingRefreshTTLKey = "auth.refresh_token_ttl_seconds"
)

// settingsReader is the narrow shape SessionService needs from the
// settings service. Defined here so the auth package isn't tied to
// *service.SettingsService — keeps it testable and avoids import
// cycles (service already imports models; if auth grew a hard dep
// on service we'd have to be careful).
type settingsReader interface {
	GetSetting(ctx context.Context, key string) (*models.ConfigItem, error)
}

// TokenPair is the return shape from IssueTokenPair / RefreshTokenPair.
// Callers (the auth_session_handler) split these onto the wire — the
// access token goes in the JSON body; the refresh token goes into an
// httpOnly cookie.
type TokenPair struct {
	AccessToken    string
	RefreshToken   string
	AccessClaims   *Claims
	RefreshClaims  *Claims
	AccessExpires  time.Time
	RefreshExpires time.Time
}

// SessionService is the single funnel for token issuance. Holds the
// signer (which holds the secret), the revoked-families repo (for
// rotation/replay), and the settings reader (for TTL policy).
//
// Concurrent-safe. The internal cache is mutex-guarded.
type SessionService struct {
	signer        *TokenSigner
	revokedRepo   *repository.RevokedFamiliesRepository
	settings      settingsReader
	cacheMu       sync.RWMutex
	cachedAccess  ttlCache
	cachedRefresh ttlCache
}

type ttlCache struct {
	value     time.Duration
	expiresAt time.Time
}

// NewSessionService builds the service. Settings reader may be nil
// during tests / bootstrap-with-no-settings — in that case TTL
// reads fall through to the defaults.
func NewSessionService(signer *TokenSigner, revoked *repository.RevokedFamiliesRepository, settings settingsReader) *SessionService {
	return &SessionService{
		signer:      signer,
		revokedRepo: revoked,
		settings:    settings,
	}
}

// IssueTokenPair mints a fresh access + refresh pair for a user. New
// family_id, so this starts a new refresh chain.
//
// sourceChannel identifies which IdP minted the inbound credential
// (e.g. "clerk", "apikey", "x-user-id"). Recorded on the access
// token's claims for audit; not used for authz.
func (s *SessionService) IssueTokenPair(ctx context.Context, user *models.User, sourceChannel string) (*TokenPair, error) {
	if user == nil {
		return nil, fmt.Errorf("issue token pair: nil user")
	}

	accessTTL := s.accessTTL(ctx)
	refreshTTL := s.refreshTTL(ctx)

	accessToken, accessClaims, err := s.signer.IssueAccess(user, accessTTL, sourceChannel)
	if err != nil {
		return nil, fmt.Errorf("issue access: %w", err)
	}
	refreshToken, refreshClaims, err := s.signer.IssueRefresh(user, refreshTTL, "")
	if err != nil {
		return nil, fmt.Errorf("issue refresh: %w", err)
	}

	return &TokenPair{
		AccessToken:    accessToken,
		RefreshToken:   refreshToken,
		AccessClaims:   accessClaims,
		RefreshClaims:  refreshClaims,
		AccessExpires:  accessClaims.ExpiresAt.Time,
		RefreshExpires: refreshClaims.ExpiresAt.Time,
	}, nil
}

// RefreshTokenPair validates an incoming refresh token, checks the
// family hasn't been revoked, and mints a new pair carrying the
// same family_id forward. Standard rotation: the old refresh token
// is effectively dead after this (its jti changes), and presenting
// it again triggers ErrRefreshReplay → family revocation.
//
// On any failure (expired, revoked, wrong type, malformed), the
// caller should clear the client's stored refresh token and force
// re-bootstrap via /auth/session.
//
// UserLookup is the narrow shape we need to re-fetch the user
// record at refresh time — capabilities may have changed since the
// access token was last issued, so refresh re-loads the user and
// stamps current capabilities onto the new access token. Without
// this, a demoted user keeps their old capabilities until their
// refresh expires, which can be days. Implemented by
// service.UserService.GetUser.
type UserLookup interface {
	GetUser(ctx context.Context, id string) (*models.User, error)
}

func (s *SessionService) RefreshTokenPair(ctx context.Context, rawRefresh string, users UserLookup) (*TokenPair, error) {
	claims, err := s.signer.VerifyToken(rawRefresh, TokenTypeRefresh)
	if err != nil {
		return nil, err // bubble ErrInvalidToken / ErrTokenExpired / ErrWrongTokenType verbatim
	}

	// Family revocation check.
	if s.revokedRepo != nil {
		revoked, err := s.revokedRepo.IsRevoked(ctx, claims.FamilyID)
		if err != nil {
			return nil, fmt.Errorf("check revoked family: %w", err)
		}
		if revoked {
			return nil, ErrRefreshRevoked
		}
	}

	// Re-fetch user so capability changes are picked up on the new
	// access token. If the user has been deactivated since the
	// refresh was issued, refuse.
	user, err := users.GetUser(ctx, claims.UserID)
	if err != nil {
		return nil, fmt.Errorf("lookup user: %w", err)
	}
	if user == nil || !user.Active {
		return nil, ErrUserNotActive
	}

	accessTTL := s.accessTTL(ctx)
	refreshTTL := s.refreshTTL(ctx)

	accessToken, accessClaims, err := s.signer.IssueAccess(user, accessTTL, "refresh")
	if err != nil {
		return nil, fmt.Errorf("issue access: %w", err)
	}
	// Carry family_id forward — same chain, new jti. A future request
	// presenting the OLD refresh (same family, older jti) would be
	// caught by jti tracking; today we revoke at family granularity
	// which is sufficient given short access TTLs.
	newRefresh, newRefreshClaims, err := s.signer.IssueRefresh(user, refreshTTL, claims.FamilyID)
	if err != nil {
		return nil, fmt.Errorf("issue refresh: %w", err)
	}

	return &TokenPair{
		AccessToken:    accessToken,
		RefreshToken:   newRefresh,
		AccessClaims:   accessClaims,
		RefreshClaims:  newRefreshClaims,
		AccessExpires:  accessClaims.ExpiresAt.Time,
		RefreshExpires: newRefreshClaims.ExpiresAt.Time,
	}, nil
}

// VerifyAccessToken validates an access token and returns its claims.
// Thin pass-through to the signer with the type lock pinned to
// access — refresh tokens presented at normal API endpoints fail
// the same way bad signatures do.
func (s *SessionService) VerifyAccessToken(raw string) (*Claims, error) {
	return s.signer.VerifyToken(raw, TokenTypeAccess)
}

// PeekClaims parses a refresh token WITHOUT enforcing expiry.
// Used by Logout to recover the family_id from an expired-but-
// otherwise-valid refresh token so we can still revoke the family.
// Never use this for authz — callers must not treat the returned
// claims as authenticating anything.
func (s *SessionService) PeekClaims(rawRefresh string) (*Claims, error) {
	claims, err := s.signer.VerifyToken(rawRefresh, TokenTypeRefresh)
	if err == nil || errors.Is(err, ErrTokenExpired) {
		return claims, nil
	}
	return nil, err
}

// RevokeFamily marks a refresh-token family as poisoned. Subsequent
// /auth/refresh calls in that family fail with ErrRefreshRevoked.
// Used at sign-out and on admin force-logout. The expiresAt should
// be set to "the latest plausible exp of any descendant token" —
// callers can compute it from "now + max refresh TTL." Past that
// point the TTL index sweeps the row away.
func (s *SessionService) RevokeFamily(ctx context.Context, familyID, reason, userGUID string) error {
	if s.revokedRepo == nil {
		return errors.New("revoked-families repo not configured")
	}
	expiresAt := time.Now().Add(s.refreshTTL(ctx)).Add(1 * time.Hour) // tiny safety margin
	return s.revokedRepo.Revoke(ctx, familyID, reason, userGUID, expiresAt)
}

// accessTTL reads the current admin-configured TTL with caching.
// Falls back to default on any read error / missing setting / out-
// of-range value (defense in depth — the admin handler clamps too).
func (s *SessionService) accessTTL(ctx context.Context) time.Duration {
	return s.cachedTTL(ctx, &s.cachedAccess, SettingAccessTTLKey, DefaultAccessTokenTTL, MinAccessTokenTTL, MaxAccessTokenTTL)
}

func (s *SessionService) refreshTTL(ctx context.Context) time.Duration {
	return s.cachedTTL(ctx, &s.cachedRefresh, SettingRefreshTTLKey, DefaultRefreshTokenTTL, MinRefreshTokenTTL, MaxRefreshTokenTTL)
}

func (s *SessionService) cachedTTL(ctx context.Context, cache *ttlCache, key string, def, min, max time.Duration) time.Duration {
	// Fast path under RLock.
	s.cacheMu.RLock()
	if !cache.expiresAt.IsZero() && time.Now().Before(cache.expiresAt) {
		v := cache.value
		s.cacheMu.RUnlock()
		return v
	}
	s.cacheMu.RUnlock()

	// Slow path: settings read + cache repopulate under write lock.
	s.cacheMu.Lock()
	defer s.cacheMu.Unlock()
	// Double-check after acquiring the write lock — another goroutine
	// may have refreshed while we were waiting.
	if !cache.expiresAt.IsZero() && time.Now().Before(cache.expiresAt) {
		return cache.value
	}

	ttl := def
	if s.settings != nil {
		if item, err := s.settings.GetSetting(ctx, key); err == nil && item != nil {
			if secs, ok := coerceSeconds(item.Value); ok {
				candidate := time.Duration(secs) * time.Second
				if candidate >= min && candidate <= max {
					ttl = candidate
				}
			}
		}
	}
	cache.value = ttl
	cache.expiresAt = time.Now().Add(settingsCacheTTL)
	return ttl
}

// coerceSeconds handles the interface{} shape of ConfigItem.Value.
// Admin can save the value as a JSON number (float64 in Go) or as
// a string (Carbon NumberInput sometimes serializes both ways). Be
// forgiving about both.
func coerceSeconds(v interface{}) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int32:
		return int64(x), true
	case int64:
		return x, true
	case float32:
		return int64(x), true
	case float64:
		return int64(x), true
	}
	return 0, false
}

// ErrRefreshRevoked fires when a refresh-token's family has been
// poisoned (explicit revocation or replay detection). Client
// should clear stored tokens and re-bootstrap.
var ErrRefreshRevoked = errors.New("refresh token family revoked")

// ErrUserNotActive fires when refresh succeeds cryptographically
// but the underlying user has been deactivated. Same client
// response as ErrRefreshRevoked.
var ErrUserNotActive = errors.New("user not active")
