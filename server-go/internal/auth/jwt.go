// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TokenType discriminates the two JWT kinds we issue. Access tokens
// are short-lived and carry full identity + capability claims; they
// are what every authenticated request presents. Refresh tokens are
// longer-lived, carry a family id for rotation/replay detection, and
// only ever travel to the /api/auth/refresh endpoint (typically via
// an httpOnly cookie).
type TokenType string

const (
	TokenTypeAccess  TokenType = "access"
	TokenTypeRefresh TokenType = "refresh"
)

// Claims is the JWT payload for both token types. Single struct rather
// than two — simpler signing, and the unused fields are absent from
// the wire because the `omitempty` tags drop them. Capabilities and
// Kind are only meaningful on access tokens. FamilyID is only
// meaningful on refresh tokens.
type Claims struct {
	jwt.RegisteredClaims

	// Type discriminates access vs refresh. Mismatched usage (e.g.
	// presenting a refresh token at a normal API endpoint) fails
	// verification with ErrWrongTokenType.
	Type TokenType `json:"typ"`

	// UserID is the dashboard's internal user record id (Mongo _id).
	UserID string `json:"uid"`

	// GUID is the user's external identifier — used for path-param
	// authz (`SelfOnly` predicates compare against GUID), URL params,
	// and back-compat with the legacy X-User-ID header world.
	GUID string `json:"gid"`

	// Capabilities are stamped at issuance and carried in every
	// access token. Per Tom 2026-05-15: short list, no scope today,
	// "does the user have this priv" is a synchronous claim check.
	// Absent on refresh tokens (refresh has no privilege to grant on
	// its own — it only mints new access tokens).
	Capabilities []models.Capability `json:"caps,omitempty"`

	// Kind tracks whether this token represents a human or a system
	// principal. Lets handlers refuse interactive operations for
	// service principals without an extra DB lookup. Absent on
	// refresh tokens.
	Kind models.UserKind `json:"kind,omitempty"`

	// SourceChannel records how the session was bootstrapped — which
	// IdP minted the inbound credential. Informational only (logs,
	// audit), never load-bearing for authz.
	SourceChannel string `json:"src,omitempty"`

	// FamilyID groups a refresh chain. Every refresh rotates the
	// refresh token (new jti) but keeps the family. Reusing an old
	// refresh after rotation invalidates the whole family — this is
	// the standard stolen-refresh-detection pattern. Absent on
	// access tokens.
	FamilyID string `json:"fam,omitempty"`
}

// Valid extends the default RegisteredClaims validation with a Type
// check so a misused refresh token fails the same way an expired
// token does.
//
// Note: golang-jwt/v5 calls Valid() via its own validator only when
// the parser is set to use a custom validator. We call it explicitly
// from VerifyToken after parsing.
func (c *Claims) ValidateType(expected TokenType) error {
	if c.Type != expected {
		return fmt.Errorf("%w: have %q, want %q", ErrWrongTokenType, c.Type, expected)
	}
	return nil
}

// HasCapability is the single primitive every authz check eventually
// reaches. Wraps a linear scan over the (short) capability list. Use
// the package-level DoesUserHavePriv when you have a *Claims directly
// — it handles nil/expired-token cases too.
func (c *Claims) HasCapability(needed models.Capability) bool {
	for _, cap := range c.Capabilities {
		if cap == needed {
			return true
		}
	}
	return false
}

// TokenSigner mints and verifies tokens. Holds the secret so callers
// don't have to thread it through every issuance path. Concurrent-safe
// (the underlying jwt.SigningMethod is stateless).
type TokenSigner struct {
	secret []byte
	issuer string
}

// NewTokenSigner builds a signer from a raw secret string. Returns an
// error when the secret is shorter than 32 bytes — HS256 with a weak
// secret is silently broken; surfacing it at boot is friendlier than
// a 3am token-forgery incident.
func NewTokenSigner(secret, issuer string) (*TokenSigner, error) {
	if len(secret) < 32 {
		return nil, fmt.Errorf("%w: JWT secret must be at least 32 bytes (got %d)", ErrWeakSecret, len(secret))
	}
	if issuer == "" {
		issuer = "trv-outpost"
	}
	return &TokenSigner{secret: []byte(secret), issuer: issuer}, nil
}

// IssueAccess mints a fresh access token. The caller is responsible
// for choosing the TTL (read from settings by SessionService) — Issue
// stays unaware of policy.
func (s *TokenSigner) IssueAccess(user *models.User, ttl time.Duration, sourceChannel string) (string, *Claims, error) {
	now := time.Now()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        uuid.New().String(),
			Issuer:    s.issuer,
			Subject:   user.GUID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			NotBefore: jwt.NewNumericDate(now),
		},
		Type:          TokenTypeAccess,
		UserID:        user.ID,
		GUID:          user.GUID,
		Capabilities:  user.Capabilities,
		Kind:          user.Kind,
		SourceChannel: sourceChannel,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	if err != nil {
		return "", nil, fmt.Errorf("sign access token: %w", err)
	}
	return signed, claims, nil
}

// IssueRefresh mints a fresh refresh token. familyID groups the
// refresh-rotation chain — first issuance creates a new family;
// subsequent refreshes carry the same family forward. Refresh tokens
// carry no capabilities — they only authorize calling /auth/refresh.
func (s *TokenSigner) IssueRefresh(user *models.User, ttl time.Duration, familyID string) (string, *Claims, error) {
	if familyID == "" {
		familyID = uuid.New().String()
	}
	now := time.Now()
	claims := &Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			ID:        uuid.New().String(),
			Issuer:    s.issuer,
			Subject:   user.GUID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
			NotBefore: jwt.NewNumericDate(now),
		},
		Type:     TokenTypeRefresh,
		UserID:   user.ID,
		GUID:     user.GUID,
		FamilyID: familyID,
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(s.secret)
	if err != nil {
		return "", nil, fmt.Errorf("sign refresh token: %w", err)
	}
	return signed, claims, nil
}

// VerifyToken parses and validates a token. Returns the *Claims on
// success. expected may be empty to accept either type — callers that
// know what they expect (middleware wants access, refresh handler
// wants refresh) should pass the explicit type for the tighter check.
//
// Errors are wrapped so callers can match on ErrInvalidToken /
// ErrTokenExpired / ErrWrongTokenType.
func (s *TokenSigner) VerifyToken(raw string, expected TokenType) (*Claims, error) {
	parsed, err := jwt.ParseWithClaims(raw, &Claims{}, func(t *jwt.Token) (interface{}, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("%w: unexpected signing method %v", ErrInvalidToken, t.Header["alg"])
		}
		return s.secret, nil
	})
	// Pull claims out even when parsing errored — jwt v5 still
	// populates them on expiry, and PeekClaims (used by Logout to
	// recover family_id from an expired refresh) needs them.
	// `parsed` itself may be nil for malformed tokens (e.g. an API
	// key shaped `trve_…` that isn't dot-delimited JWT) — guard
	// before touching it, otherwise we panic and return 500 instead
	// of the intended 401.
	var claims *Claims
	if parsed != nil {
		claims, _ = parsed.Claims.(*Claims)
	}
	if err != nil {
		// Detect expiry explicitly so the middleware can hint
		// "refresh and retry" instead of treating it the same as a
		// bad signature.
		if errors.Is(err, jwt.ErrTokenExpired) {
			return claims, ErrTokenExpired
		}
		return nil, fmt.Errorf("%w: %v", ErrInvalidToken, err)
	}
	if parsed == nil || claims == nil || !parsed.Valid {
		return nil, ErrInvalidToken
	}
	if expected != "" {
		if err := claims.ValidateType(expected); err != nil {
			return nil, err
		}
	}
	return claims, nil
}

// DoesUserHavePriv is the single authz primitive Tom asked for
// (2026-05-15). Every authz decision in the codebase routes through
// here: "does this caller hold this privilege?" Returns false for any
// reason the answer isn't a definitive yes — nil claims, missing
// capability, otherwise unknown caller. Doesn't hit the DB; the
// signed claims ARE the source of truth at request time.
//
// Callers that need different semantics (e.g. "self-only" path-param
// checks) build them on top of this primitive plus the request shape.
func DoesUserHavePriv(claims *Claims, needed models.Capability) bool {
	if claims == nil {
		return false
	}
	return claims.HasCapability(needed)
}

// ErrInvalidToken is declared in verifier.go and shared across this
// package — both the external-IdP verifiers and our internal token
// signer treat any non-specific verification failure as the same
// 401-shape error.

// ErrTokenExpired is returned when the token parsed cleanly but its
// exp claim is in the past. Distinct from ErrInvalidToken because
// the client's correct response is to refresh, not to re-bootstrap.
var ErrTokenExpired = errors.New("token expired")

// ErrWrongTokenType fires when a caller presents a refresh token at
// a route expecting an access token (or vice versa).
var ErrWrongTokenType = errors.New("wrong token type")

// ErrWeakSecret guards the signer constructor against operators
// configuring a JWT secret that's too short to be safe with HS256.
var ErrWeakSecret = errors.New("jwt secret too weak")
