// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"crypto/rand"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
	"go.mongodb.org/mongo-driver/mongo"
	"golang.org/x/crypto/bcrypt"
)

// TokenScheme is the literal prefix every issued token starts with.
// Greppable, recognisable in logs, and gives us a clean reserved
// namespace if we ever introduce a second token format.
const TokenScheme = "trve_"

// PrefixLength is the number of plaintext base32 characters stored on
// the record (after the scheme prefix). 8 is short enough to be
// brute-resistant on its own and long enough to make the prefix-indexed
// lookup return a single candidate row in practice.
const PrefixLength = 8

// tokenRandomBytes is the size of the cryptographically-random payload
// embedded in a token. 32 bytes → 256 bits of entropy → 52 base32 chars,
// which we cap to 43 by trimming the base32 padding-free representation.
const tokenRandomBytes = 32

// ErrAPIKeyNotFound is returned when no record matches the lookup. The
// auth middleware maps this to a 401, never leaking which step failed.
var ErrAPIKeyNotFound = errors.New("api key not found")

// ErrAPIKeyRevoked is returned when a key matches but is no longer
// valid. Same 401 in the middleware — but useful for the admin UI.
var ErrAPIKeyRevoked = errors.New("api key revoked")

// ErrAPIKeyExpired is returned when a key has an ExpiresAt in the
// past. Same handling as Revoked.
var ErrAPIKeyExpired = errors.New("api key expired")

// ErrInvalidTokenFormat is returned when the presented string doesn't
// look like a `trve_<base32>` token. Saves a database round-trip when
// the caller is sending garbage.
var ErrInvalidTokenFormat = errors.New("invalid api key format")

// APIKeyService owns the lifecycle of API keys: generation, hashing,
// validation, revocation. Plaintext tokens never leave this layer
// except in the one-time CreateAPIKeyResponse.
type APIKeyService struct {
	repo *repository.APIKeyRepository
}

// NewAPIKeyService wires the repository.
func NewAPIKeyService(repo *repository.APIKeyRepository) *APIKeyService {
	return &APIKeyService{repo: repo}
}

// Create generates a new token, persists the bcrypt hash + plaintext
// prefix, and returns the plaintext token to the caller exactly once.
// Callers MUST surface the token to the user immediately and warn that
// it cannot be recovered later.
func (s *APIKeyService) Create(ctx context.Context, userGUID string, req *models.CreateAPIKeyRequest) (*models.CreateAPIKeyResponse, error) {
	name := strings.TrimSpace(req.Name)
	if name == "" {
		return nil, errors.New("name is required")
	}

	token, prefix, err := generateToken()
	if err != nil {
		return nil, fmt.Errorf("generating token: %w", err)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(token), bcrypt.DefaultCost)
	if err != nil {
		return nil, fmt.Errorf("hashing token: %w", err)
	}

	key := models.APIKey{
		ID:        uuid.New().String(),
		UserGUID:  userGUID,
		Name:      name,
		Prefix:    prefix,
		Hash:      string(hash),
		Created:   time.Now(),
		Revoked:   false,
		ExpiresAt: req.ExpiresAt,
	}
	if err := s.repo.Create(ctx, &key); err != nil {
		return nil, fmt.Errorf("persisting key: %w", err)
	}
	return &models.CreateAPIKeyResponse{
		APIKey: key,
		Token:  token,
	}, nil
}

// ListByUser returns every key the user has ever issued (active +
// revoked), newest first. Hashes are zeroed out before the response
// leaves the service so they can't be accidentally serialized.
func (s *APIKeyService) ListByUser(ctx context.Context, userGUID string) ([]models.APIKey, error) {
	keys, err := s.repo.FindByUserGUID(ctx, userGUID)
	if err != nil {
		return nil, err
	}
	for i := range keys {
		keys[i].Hash = ""
	}
	return keys, nil
}

// ListAll returns every key in the system, newest-first. For admin
// audit views. Hashes are stripped here too.
func (s *APIKeyService) ListAll(ctx context.Context) ([]models.APIKey, error) {
	keys, err := s.repo.List(ctx)
	if err != nil {
		return nil, err
	}
	for i := range keys {
		keys[i].Hash = ""
	}
	return keys, nil
}

// Revoke flips the revoked flag on a key. Idempotent — revoking a
// revoked key returns nil. Returns ErrAPIKeyNotFound if the key
// doesn't exist or doesn't belong to the requesting user (when
// requireOwner is set).
func (s *APIKeyService) Revoke(ctx context.Context, id, requireOwnerGUID string) error {
	key, err := s.repo.FindByID(ctx, id)
	if err != nil {
		return err
	}
	if key == nil {
		return ErrAPIKeyNotFound
	}
	if requireOwnerGUID != "" && key.UserGUID != requireOwnerGUID {
		// Same error as not-found so a non-owner can't probe for
		// the existence of other users' keys.
		return ErrAPIKeyNotFound
	}
	if key.Revoked {
		return nil
	}
	if err := s.repo.Revoke(ctx, id); err != nil {
		if err == mongo.ErrNoDocuments {
			return ErrAPIKeyNotFound
		}
		return err
	}
	return nil
}

// Validate is the auth middleware's hot path. Given the raw
// `trve_<base32>` token from the Authorization header, it:
//
//  1. Parses the format (cheap, fails fast on garbage).
//  2. Pulls candidate rows by plaintext prefix (indexed lookup,
//     usually returns 0 or 1 row).
//  3. bcrypt-compares each candidate against the presented token.
//  4. Rejects revoked or expired matches.
//  5. Asynchronously updates LastUsed (best-effort; never blocks).
//
// Returns the matched APIKey (with Hash zeroed) on success.
func (s *APIKeyService) Validate(ctx context.Context, token string) (*models.APIKey, error) {
	if !strings.HasPrefix(token, TokenScheme) {
		return nil, ErrInvalidTokenFormat
	}
	body := strings.TrimPrefix(token, TokenScheme)
	if len(body) < PrefixLength {
		return nil, ErrInvalidTokenFormat
	}
	prefix := body[:PrefixLength]

	candidates, err := s.repo.FindByPrefix(ctx, prefix)
	if err != nil {
		return nil, err
	}
	if len(candidates) == 0 {
		return nil, ErrAPIKeyNotFound
	}

	now := time.Now()
	tokenBytes := []byte(token)
	for i := range candidates {
		c := &candidates[i]
		if c.Revoked {
			continue
		}
		if c.ExpiresAt != nil && c.ExpiresAt.Before(now) {
			continue
		}
		if err := bcrypt.CompareHashAndPassword([]byte(c.Hash), tokenBytes); err == nil {
			// Best-effort touch — failure here must not break auth.
			go func(id string) {
				_ = s.repo.TouchLastUsed(context.Background(), id)
			}(c.ID)
			c.Hash = ""
			return c, nil
		}
	}

	// At least one candidate existed but none matched cleanly.
	// Distinguish revoked/expired vs. hash mismatch only when there's
	// exactly one candidate — the common case — so the admin UI can
	// surface a useful reason.
	if len(candidates) == 1 {
		c := &candidates[0]
		if c.Revoked {
			return nil, ErrAPIKeyRevoked
		}
		if c.ExpiresAt != nil && c.ExpiresAt.Before(now) {
			return nil, ErrAPIKeyExpired
		}
	}
	return nil, ErrAPIKeyNotFound
}

// generateToken produces a `trve_<43-char-base32>` token. Returns the
// full token string and the plaintext prefix that callers persist on
// the record for indexed lookup.
func generateToken() (token, prefix string, err error) {
	buf := make([]byte, tokenRandomBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	// Padding-free, lowercase base32 — readable, copy-paste-friendly,
	// no `=` characters to confuse URL-encoded contexts.
	encoded := strings.ToLower(strings.TrimRight(
		base32.StdEncoding.EncodeToString(buf),
		"=",
	))
	if len(encoded) < PrefixLength {
		return "", "", errors.New("token encoding too short")
	}
	return TokenScheme + encoded, encoded[:PrefixLength], nil
}
