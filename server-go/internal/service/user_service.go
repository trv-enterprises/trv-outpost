// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// UserService handles user business logic
type UserService struct {
	repo       *repository.UserRepository
	apiKeyRepo *repository.APIKeyRepository
	configRepo *repository.ConfigRepository
}

// NewUserService creates a new user service. apiKeyRepo and configRepo are
// optional dependencies used for cascade-deletes on user removal; pass nil
// to skip the corresponding cascade (tests, partial wiring).
func NewUserService(repo *repository.UserRepository, apiKeyRepo *repository.APIKeyRepository, configRepo *repository.ConfigRepository) *UserService {
	return &UserService{repo: repo, apiKeyRepo: apiKeyRepo, configRepo: configRepo}
}

// CreateUser creates a new user
func (s *UserService) CreateUser(ctx context.Context, req *models.CreateUserRequest) (*models.User, error) {
	// Check name uniqueness
	existing, err := s.repo.GetByName(ctx, req.Name)
	if err != nil {
		return nil, fmt.Errorf("failed to check name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, errors.New("user with this name already exists")
	}

	// Set default capabilities if none provided
	capabilities := req.Capabilities
	if len(capabilities) == 0 {
		capabilities = []models.Capability{models.CapabilityView}
	}

	user := &models.User{
		ID:           uuid.New().String(),
		GUID:         uuid.New().String(),
		Name:         req.Name,
		Email:        req.Email,
		Capabilities: capabilities,
		Active:       true,
		Kind:         models.UserKindHuman,
	}

	if err := s.repo.Create(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	return user, nil
}

// CreateSystemUser creates a non-interactive service principal. It
// is a deliberately separate code path from CreateUser so the
// human-creation API can't be tricked into generating a system
// principal by stuffing a `kind` field into the request body.
//
// Capability policy:
//   - `view` is always granted (the floor — needed for /auth/me and
//     for any authenticated read the integration might need).
//   - `webhook` is granted unless the caller explicitly drops it.
//     This is the canonical privilege for inbound integrations; the
//     create-modal in the UI defaults it to on.
//   - `design` and `manage` are accepted if explicitly requested but
//     are not surfaced in the default UI. They exist so an operator
//     CAN broaden a system user if a future integration legitimately
//     needs them (e.g. a script that auto-creates dashboards), not
//     because they're routine.
//
// Pass capabilities=nil to get the default (view + webhook). Pass an
// explicit slice to override; "view" is always added if missing.
func (s *UserService) CreateSystemUser(ctx context.Context, name string, capabilities []models.Capability) (*models.User, error) {
	if name == "" {
		return nil, errors.New("system user name is required")
	}
	existing, err := s.repo.GetByName(ctx, name)
	if err != nil {
		return nil, fmt.Errorf("failed to check name uniqueness: %w", err)
	}
	if existing != nil {
		return nil, errors.New("user with this name already exists")
	}

	caps := capabilities
	if caps == nil {
		caps = []models.Capability{models.CapabilityView, models.CapabilityWebhook}
	}
	// Defense in depth: always include view, even if the caller's
	// list omitted it. A system user without view can't authenticate
	// past the route-rule check on /auth/me, which would make the
	// account useless. Dedupe + validate each entry against the
	// known capability set.
	caps = normalizeCapabilities(caps)

	user := &models.User{
		ID:           uuid.New().String(),
		GUID:         uuid.New().String(),
		Name:         name,
		Capabilities: caps,
		Active:       true,
		Kind:         models.UserKindSystem,
	}
	if err := s.repo.Create(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to create system user: %w", err)
	}
	return user, nil
}

// normalizeCapabilities deduplicates the slice, drops unknown values,
// and guarantees `view` is present. Order is stable for whichever
// values the caller supplied; `view` (when injected) goes first.
func normalizeCapabilities(in []models.Capability) []models.Capability {
	known := map[models.Capability]bool{
		models.CapabilityView:    true,
		models.CapabilityDesign:  true,
		models.CapabilityManage:  true,
		models.CapabilityWebhook: true,
	}
	seen := map[models.Capability]bool{}
	out := make([]models.Capability, 0, len(in)+1)
	if !containsCapability(in, models.CapabilityView) {
		out = append(out, models.CapabilityView)
		seen[models.CapabilityView] = true
	}
	for _, c := range in {
		if !known[c] || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out
}

func containsCapability(haystack []models.Capability, needle models.Capability) bool {
	for _, c := range haystack {
		if c == needle {
			return true
		}
	}
	return false
}

// ListSystemUsers returns every system principal in the deployment.
// Returned full record (no redaction) because callers are gated on
// Manage capability — same posture as ListUsers.
func (s *UserService) ListSystemUsers(ctx context.Context) ([]models.User, error) {
	users, err := s.repo.ListByKind(ctx, models.UserKindSystem)
	if err != nil {
		return nil, fmt.Errorf("failed to list system users: %w", err)
	}
	return users, nil
}

// GetUser retrieves a user by ID
func (s *UserService) GetUser(ctx context.Context, id string) (*models.User, error) {
	user, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return nil, errors.New("user not found")
	}
	return user, nil
}

// GetUserByGUID retrieves a user by GUID (for authentication)
func (s *UserService) GetUserByGUID(ctx context.Context, guid string) (*models.User, error) {
	user, err := s.repo.GetByGUID(ctx, guid)
	if err != nil {
		return nil, fmt.Errorf("failed to get user by GUID: %w", err)
	}
	return user, nil
}

// UpdateUser updates an existing user
func (s *UserService) UpdateUser(ctx context.Context, id string, req *models.UpdateUserRequest) (*models.User, error) {
	user, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("failed to get user: %w", err)
	}
	if user == nil {
		return nil, errors.New("user not found")
	}

	// Check name uniqueness if changing name
	if req.Name != nil && *req.Name != user.Name {
		existing, err := s.repo.GetByName(ctx, *req.Name)
		if err != nil {
			return nil, fmt.Errorf("failed to check name uniqueness: %w", err)
		}
		if existing != nil {
			return nil, errors.New("user with this name already exists")
		}
		user.Name = *req.Name
	}

	if req.Email != nil {
		user.Email = *req.Email
	}

	if req.Capabilities != nil {
		user.Capabilities = *req.Capabilities
	}

	if req.Active != nil {
		user.Active = *req.Active
	}

	if err := s.repo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user: %w", err)
	}

	// ClerkUserID is updated via a separate $set/$unset path so the
	// sparse-unique index doesn't reject an empty string. We do this
	// after the main update so the timestamp on the record reflects
	// both changes.
	if req.ClerkUserID != nil {
		if err := s.repo.SetClerkID(ctx, user.ID, *req.ClerkUserID); err != nil {
			return nil, fmt.Errorf("failed to update clerk_user_id: %w", err)
		}
		user.ClerkUserID = *req.ClerkUserID
	}

	return user, nil
}

// DeleteUser deletes a user and cascades to per-user records that are
// otherwise orphaned by the deletion: API keys (any number, active or
// revoked) and per-user app_config rows. Cascade is intentional — the
// admin UI warns up-front that delete is destructive — so the user
// can't accidentally leave live API tokens that resolve to a missing
// user_id (auth-middleware lookup would either silently succeed or
// 500 depending on resolver behavior, both bad).
func (s *UserService) DeleteUser(ctx context.Context, id string) error {
	user, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return fmt.Errorf("failed to find user: %w", err)
	}
	if user == nil {
		return fmt.Errorf("user not found")
	}

	// Cascade: API keys are keyed by user GUID, not the Mongo _id.
	if s.apiKeyRepo != nil {
		keys, err := s.apiKeyRepo.FindByUserGUID(ctx, user.GUID)
		if err != nil {
			return fmt.Errorf("failed to list api keys for cascade: %w", err)
		}
		for _, k := range keys {
			if err := s.apiKeyRepo.Delete(ctx, k.ID); err != nil {
				return fmt.Errorf("failed to cascade-delete api key %s: %w", k.ID, err)
			}
		}
	}

	// Cascade: per-user app_config rows.
	if s.configRepo != nil {
		if err := s.configRepo.DeleteUserConfig(ctx, id); err != nil {
			return fmt.Errorf("failed to cascade-delete user config: %w", err)
		}
	}

	if err := s.repo.Delete(ctx, id); err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}
	return nil
}

// ListUsers returns a paginated list of users
func (s *UserService) ListUsers(ctx context.Context, page, pageSize int) (*models.UserListResponse, error) {
	users, total, err := s.repo.List(ctx, page, pageSize)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}

	return &models.UserListResponse{
		Users:    users,
		Total:    total,
		Page:     page,
		PageSize: pageSize,
	}, nil
}

// GetCapabilities returns the self-info response for a user. This is
// what the SPA bootstrap calls via /api/auth/me — it carries enough
// to render the header user pill, persist identity to localStorage,
// and gate Design/Manage UI without any further user lookups.
func (s *UserService) GetCapabilities(ctx context.Context, user *models.User) *models.UserCapabilitiesResponse {
	return &models.UserCapabilitiesResponse{
		UserID:       user.ID,
		GUID:         user.GUID,
		Name:         user.Name,
		Active:       user.Active,
		Capabilities: user.Capabilities,
		CanDesign:    user.HasDesignAccess(),
		CanManage:    user.HasManageAccess(),
	}
}

// SeedPseudoUsers creates or updates the pseudo users on startup
func (s *UserService) SeedPseudoUsers(ctx context.Context) error {
	for _, pu := range models.PseudoUsers {
		user := &models.User{
			ID:           uuid.NewString(),
			GUID:         pu.GUID,
			Name:         pu.Name,
			Capabilities: pu.Capabilities,
			Active:       true,
			Created:      time.Now(),
			Updated:      time.Now(),
		}

		if err := s.repo.UpsertByName(ctx, user); err != nil {
			return fmt.Errorf("failed to seed user %s: %w", pu.Name, err)
		}
	}
	return nil
}

// GetUserCount returns the total number of users
func (s *UserService) GetUserCount(ctx context.Context) (int64, error) {
	return s.repo.Count(ctx)
}
