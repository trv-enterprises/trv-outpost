// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/authz"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/repository"
)

// GrantsInvalidator lets the user service drop cached namespace
// grants when a user record changes (issue #4). Satisfied by
// *authz.Resolver; an interface here avoids a service→authz→service
// import knot and keeps tests trivial.
type GrantsInvalidator interface {
	Invalidate(guid string)
}

// UserService handles user business logic
type UserService struct {
	repo       *repository.UserRepository
	apiKeyRepo *repository.APIKeyRepository
	configRepo *repository.ConfigRepository
	// grantsInvalidator is optional (nil in tests/partial wiring);
	// set via SetGrantsInvalidator after the authz resolver exists.
	grantsInvalidator GrantsInvalidator
}

// NewUserService creates a new user service. apiKeyRepo and configRepo are
// optional dependencies used for cascade-deletes on user removal; pass nil
// to skip the corresponding cascade (tests, partial wiring).
func NewUserService(repo *repository.UserRepository, apiKeyRepo *repository.APIKeyRepository, configRepo *repository.ConfigRepository) *UserService {
	return &UserService{repo: repo, apiKeyRepo: apiKeyRepo, configRepo: configRepo}
}

// SetGrantsInvalidator wires the namespace-grants cache invalidation
// hook (issue #4). Called once at startup after the authz resolver is
// constructed (the resolver depends on this service, so it can't be a
// constructor arg).
func (s *UserService) SetGrantsInvalidator(inv GrantsInvalidator) {
	s.grantsInvalidator = inv
}

// invalidateGrants drops the cached grants for a user, if wired.
func (s *UserService) invalidateGrants(guid string) {
	if s.grantsInvalidator != nil {
		s.grantsInvalidator.Invalidate(guid)
	}
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
		ID:                   uuid.New().String(),
		GUID:                 uuid.New().String(),
		Name:                 req.Name,
		Email:                req.Email,
		Capabilities:         capabilities,
		Active:               true,
		Kind:                 models.UserKindHuman,
		NamespacesRestricted: req.NamespacesRestricted,
		AllowedNamespaces:    normalizeNamespaceGrants(req.AllowedNamespaces),
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
// Capability policy (post-v0.17.0):
//   - When capabilities=nil: default to [view, webhook]. This is the
//     kiosk-shaped principal — can display dashboards AND receive
//     inbound webhook posts. Most common case in the admin UI.
//   - When capabilities is explicit: take it verbatim (after dedupe
//     and known-value filtering). Webhook-only principals (e.g.
//     ts-store webhook receivers) carry just [webhook] — they can
//     POST to /api/webhooks/* but cannot snoop the dashboard's read
//     surface. Kiosk-only principals carry just [view].
//   - `design` and `manage` on a system principal are accepted if
//     explicitly requested; not surfaced in the default UI. Useful
//     for scripts that legitimately need to mutate, not routine.
//
// The pre-v0.17.0 "always inject view" behavior was load-bearing
// only because the route-rule table didn't enforce view explicitly;
// the new structural floor (Authorize() requires view on any route
// without an explicit Required) means we can drop the injection.
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
	// Dedupe + drop unknown values, but do NOT inject view —
	// webhook-only system users (ts-store) deliberately lack it.
	caps = normalizeCapabilitiesNoForceView(caps)
	if len(caps) == 0 {
		return nil, errors.New("system user must have at least one capability")
	}

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

// normalizeCapabilitiesNoForceView dedupes + filters to known values
// WITHOUT injecting view. Used for system users where webhook-only
// principals deliberately lack view (so they can ONLY hit
// /api/webhooks/*, not snoop the read surface).
func normalizeCapabilitiesNoForceView(in []models.Capability) []models.Capability {
	known := map[models.Capability]bool{
		models.CapabilityView:    true,
		models.CapabilityDesign:  true,
		models.CapabilityManage:  true,
		models.CapabilityWebhook: true,
	}
	seen := map[models.Capability]bool{}
	out := make([]models.Capability, 0, len(in))
	for _, c := range in {
		if !known[c] || seen[c] {
			continue
		}
		seen[c] = true
		out = append(out, c)
	}
	return out
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

	if req.NamespacesRestricted != nil {
		user.NamespacesRestricted = *req.NamespacesRestricted
	}
	if req.AllowedNamespaces != nil {
		user.AllowedNamespaces = normalizeNamespaceGrants(*req.AllowedNamespaces)
	}

	if err := s.repo.Update(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to update user: %w", err)
	}

	// Grant/capability edits must take effect on the user's next
	// request, not after the grants-cache TTL (issue #4).
	s.invalidateGrants(user.GUID)

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
	s.invalidateGrants(user.GUID)
	return nil
}

// normalizeNamespaceGrants dedupes and drops empty entries from a
// grant list. Nil in, nil out.
func normalizeNamespaceGrants(namespaces []string) []string {
	if namespaces == nil {
		return nil
	}
	seen := make(map[string]struct{}, len(namespaces))
	out := make([]string, 0, len(namespaces))
	for _, ns := range namespaces {
		if ns == "" {
			continue
		}
		if _, dup := seen[ns]; dup {
			continue
		}
		seen[ns] = struct{}{}
		out = append(out, ns)
	}
	return out
}

// ListUsers returns a paginated list of users
func (s *UserService) ListUsers(ctx context.Context, params models.UserQueryParams) (*models.UserListResponse, error) {
	if params.Page < 1 {
		params.Page = 1
	}
	params.PageSize, _ = models.ClampPageSize(params.PageSize, 10)

	users, total, err := s.repo.List(ctx, params)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}

	return &models.UserListResponse{
		Users:    users,
		Total:    total,
		Page:     params.Page,
		PageSize: params.PageSize,
		HasMore:  models.ComputeHasMore(params.Page, params.PageSize, len(users), total),
	}, nil
}

// GetCapabilities returns the self-info response for a user. This is
// what the SPA bootstrap calls via /api/auth/me — it carries enough
// to render the header user pill, persist identity to localStorage,
// and gate Design/Manage UI without any further user lookups.
func (s *UserService) GetCapabilities(ctx context.Context, user *models.User) *models.UserCapabilitiesResponse {
	// Namespace grants: the caller here is usually the JWT claims shim
	// (no grants fields), but the auth middleware has already resolved
	// grants onto the request context — read them from there so /me
	// always reflects the live grant state (issue #4).
	restricted := user.NamespacesRestricted
	allowed := user.AllowedNamespaces
	if _, g, ok := authz.FromContext(ctx); ok {
		restricted = g.Restricted
		allowed, _ = g.List()
		sort.Strings(allowed)
	}
	return &models.UserCapabilitiesResponse{
		UserID:               user.ID,
		GUID:                 user.GUID,
		Name:                 user.Name,
		Active:               user.Active,
		Capabilities:         user.Capabilities,
		CanDesign:            user.HasDesignAccess(),
		CanManage:            user.HasManageAccess(),
		CanControl:           user.HasControlAccess(),
		NamespacesRestricted: restricted,
		AllowedNamespaces:    allowed,
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
