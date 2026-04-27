// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package models

import (
	"time"
)

// Capability represents a user capability/permission
type Capability string

const (
	// CapabilityView allows access to View mode - all users have this
	CapabilityView Capability = "view"
	// CapabilityDesign allows access to Design mode
	CapabilityDesign Capability = "design"
	// CapabilityManage allows access to Manage mode
	CapabilityManage Capability = "manage"
)

// User represents a user in the system
// @Description User account with authentication and capabilities
type User struct {
	ID           string       `json:"id" bson:"_id"`
	GUID         string       `json:"guid" bson:"guid"`                   // UUID for authentication header
	Name         string       `json:"name" bson:"name"`                   // Display name
	Email        string       `json:"email,omitempty" bson:"email"`       // Optional email
	Capabilities []Capability `json:"capabilities" bson:"capabilities"`   // User capabilities
	Active       bool         `json:"active" bson:"active"`               // Whether user is active
	// ClerkUserID links this dashboard user to a Clerk identity. Set on
	// first sign-in via JIT-link from email match, or by an admin from
	// the Users page. Subsequent sign-ins resolve via this field
	// directly so an email change in Clerk doesn't break the link.
	// Empty when the deployment isn't using Clerk or the user hasn't
	// signed in via Clerk yet.
	ClerkUserID  string       `json:"clerk_user_id,omitempty" bson:"clerk_user_id,omitempty"`
	Created      time.Time    `json:"created" bson:"created"`
	Updated      time.Time    `json:"updated" bson:"updated"`
}

// HasCapability checks if user has a specific capability
func (u *User) HasCapability(cap Capability) bool {
	for _, c := range u.Capabilities {
		if c == cap {
			return true
		}
	}
	return false
}

// HasDesignAccess checks if user can access Design mode
func (u *User) HasDesignAccess() bool {
	return u.HasCapability(CapabilityDesign)
}

// HasManageAccess checks if user can access Manage mode
func (u *User) HasManageAccess() bool {
	return u.HasCapability(CapabilityManage)
}

// UserCapabilitiesResponse is returned by /api/auth/me endpoint
// @Description Current user's capabilities and access permissions
type UserCapabilitiesResponse struct {
	UserID       string       `json:"user_id"`
	Name         string       `json:"name"`
	Capabilities []Capability `json:"capabilities"`
	CanDesign    bool         `json:"can_design"`
	CanManage    bool         `json:"can_manage"`
}

// CreateUserRequest represents a request to create a user
// @Description Request body for creating a new user
type CreateUserRequest struct {
	Name         string       `json:"name" binding:"required"`
	Email        string       `json:"email,omitempty"`
	Capabilities []Capability `json:"capabilities,omitempty"`
}

// UpdateUserRequest represents a request to update a user
// @Description Request body for updating an existing user
type UpdateUserRequest struct {
	Name         *string       `json:"name,omitempty"`
	Email        *string       `json:"email,omitempty"`
	Capabilities *[]Capability `json:"capabilities,omitempty"`
	Active       *bool         `json:"active,omitempty"`
	// ClerkUserID lets an admin manually link or re-link a user to a
	// Clerk identity. Send "" to clear the link. Most deployments
	// won't need this — first sign-in JIT-links automatically — but
	// it's available for cases where the email in Clerk has drifted
	// from what's stored on the User record.
	ClerkUserID  *string       `json:"clerk_user_id,omitempty"`
}

// UserListResponse represents a paginated list of users
// @Description Response containing a list of users with pagination
type UserListResponse struct {
	Users    []User `json:"users"`
	Total    int64  `json:"total"`
	Page     int    `json:"page"`
	PageSize int    `json:"page_size"`
}

// PseudoUsers defines the default pseudo users to seed
var PseudoUsers = []struct {
	Name         string
	GUID         string
	Capabilities []Capability
}{
	{
		Name:         "Admin",
		GUID:         "admin-00000000-0000-0000-0000-000000000001",
		Capabilities: []Capability{CapabilityView, CapabilityDesign, CapabilityManage},
	},
	{
		Name:         "Designer",
		GUID:         "designer-00000000-0000-0000-0000-000000000002",
		Capabilities: []Capability{CapabilityView, CapabilityDesign},
	},
	{
		Name:         "Support",
		GUID:         "support-00000000-0000-0000-0000-000000000003",
		Capabilities: []Capability{CapabilityView},
	},
}
