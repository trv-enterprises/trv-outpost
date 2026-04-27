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
	repo *repository.UserRepository
}

// NewUserService creates a new user service
func NewUserService(repo *repository.UserRepository) *UserService {
	return &UserService{repo: repo}
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
	}

	if err := s.repo.Create(ctx, user); err != nil {
		return nil, fmt.Errorf("failed to create user: %w", err)
	}

	return user, nil
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

// DeleteUser deletes a user
func (s *UserService) DeleteUser(ctx context.Context, id string) error {
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

// GetCapabilities returns the capabilities response for a user
func (s *UserService) GetCapabilities(ctx context.Context, user *models.User) *models.UserCapabilitiesResponse {
	return &models.UserCapabilitiesResponse{
		UserID:       user.ID,
		Name:         user.Name,
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
