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
	// CapabilityWebhook allows the caller to POST to /api/webhooks/*
	// endpoints. Deliberately a narrow, single-purpose privilege
	// granted by default to system users (and only to system users,
	// today). Splitting it out from view/design/manage means the
	// contract for webhook endpoints is self-documenting and a
	// future operator can revoke an integration's ability to surface
	// alerts without disturbing anything else.
	CapabilityWebhook Capability = "webhook"
	// CapabilityControl allows the caller to execute control commands
	// (button presses, slider changes, toggle flips). Independent of
	// view/design/manage: a kiosk-system-user with view+control can
	// interact with controls without elevation; a public-display
	// kiosk with view alone can render dashboards but the server
	// 403s every /api/controls/:id/execute call. Designers and
	// admins are NOT implicitly granted control — they must hold it
	// explicitly. The boot-time migration backfills control on every
	// existing human user so today's behaviour is preserved.
	CapabilityControl Capability = "control"
)

// UserKind discriminates real humans from non-interactive service
// principals (system users). Kind=="system" users cannot sign in via
// the IdP / Clerk path; they exist only so admins can generate API
// keys that aren't bound to a real person's account lifecycle. Used
// today by the ts-store webhook receiver — an admin creates one
// system user per integration, generates a key, hands it to the
// external service.
type UserKind string

const (
	UserKindHuman  UserKind = "human"
	UserKindSystem UserKind = "system"
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
	// Kind discriminates humans from system principals. Defaults to
	// "human" on every existing record (the migration sets it when
	// the field is missing). Anything other than "human" is treated
	// as a system user — no interactive sign-in path, IdP/Clerk
	// rejects, exists only for API-key issuance.
	Kind         UserKind     `json:"kind,omitempty" bson:"kind,omitempty"`
	// ClerkUserID links this dashboard user to a Clerk identity. Set on
	// first sign-in via JIT-link from email match, or by an admin from
	// the Users page. Subsequent sign-ins resolve via this field
	// directly so an email change in Clerk doesn't break the link.
	// Empty when the deployment isn't using Clerk or the user hasn't
	// signed in via Clerk yet.
	ClerkUserID  string       `json:"clerk_user_id,omitempty" bson:"clerk_user_id,omitempty"`
	// AssistantBudgetOverride raises (or lowers) this user's daily
	// Dashboard Assistant token caps relative to the global
	// assistant.daily_token_budget. Nil = no override (use global caps).
	// Set by an admin from the AI API Usage page. See the type for scope
	// semantics.
	AssistantBudgetOverride *AssistantBudgetOverride `json:"assistant_budget_override,omitempty" bson:"assistant_budget_override,omitempty"`
	Created      time.Time    `json:"created" bson:"created"`
	Updated      time.Time    `json:"updated" bson:"updated"`
}

// AssistantBudgetOverride is a per-user daily-token-cap override for the
// Dashboard Assistant. When present and applicable, its Input/Output
// values replace the global assistant.daily_token_budget caps for that
// user (per axis; a zero axis falls back to the global cap for that axis).
//
// Scope controls how long it applies:
//   - "ongoing": applies every day until an admin changes/removes it.
//   - "today":   applies only on the UTC date in EffectiveDate; once the
//     date rolls past, the override is inert (the user reverts to global
//     caps). The stale record is harmless and can be cleared lazily.
type AssistantBudgetOverride struct {
	Input         int64  `json:"input" bson:"input"`                                       // daily input-token cap; 0 = use global
	Output        int64  `json:"output" bson:"output"`                                     // daily output-token cap; 0 = use global
	Scope         string `json:"scope" bson:"scope"`                                       // "today" | "ongoing"
	EffectiveDate string `json:"effective_date,omitempty" bson:"effective_date,omitempty"` // UTC YYYY-MM-DD; required when Scope=="today"
	SetBy         string `json:"set_by,omitempty" bson:"set_by,omitempty"`                 // admin GUID who set it (audit)
}

// Budget-override scope constants.
const (
	BudgetScopeToday   = "today"
	BudgetScopeOngoing = "ongoing"
)

// AppliesOn reports whether this override is in force on the given UTC
// day (format "2006-01-02"). Ongoing always applies; today-scoped
// applies only on its EffectiveDate.
func (o *AssistantBudgetOverride) AppliesOn(utcDay string) bool {
	if o == nil {
		return false
	}
	switch o.Scope {
	case BudgetScopeOngoing:
		return true
	case BudgetScopeToday:
		return o.EffectiveDate == utcDay
	default:
		return false
	}
}

// IsSystem reports whether this user is a non-interactive service
// principal. Empty Kind is treated as human (back-compat with records
// that pre-date the field — the migration fixes them up but reads
// shouldn't depend on the migration having run).
func (u *User) IsSystem() bool {
	return u.Kind == UserKindSystem
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

// HasControlAccess checks if user can execute control commands.
// Independent from view/design/manage by design — see
// CapabilityControl godoc.
func (u *User) HasControlAccess() bool {
	return u.HasCapability(CapabilityControl)
}

// UserCapabilitiesResponse is returned by /api/auth/me endpoint.
// This is the SPA bootstrap's primary "who am I" payload — adding
// fields here is preferable to introducing a parallel self-info
// endpoint. The GUID is included so the client can set the header
// user pill and persist the identity to localStorage without a
// follow-up lookup.
// @Description Current user's identity, capabilities, and access permissions
type UserCapabilitiesResponse struct {
	UserID       string       `json:"user_id"` // Mongo _id of the user record
	GUID         string       `json:"guid"`    // Auth-header GUID; what the SPA persists
	Name         string       `json:"name"`
	Active       bool         `json:"active"`
	Capabilities []Capability `json:"capabilities"`
	CanDesign    bool         `json:"can_design"`
	CanManage    bool         `json:"can_manage"`
	// CanControl mirrors HasControlAccess(); separate from CanDesign /
	// CanManage because control is its own axis and not implied by
	// either elevation.
	CanControl   bool         `json:"can_control"`
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
		Capabilities: []Capability{CapabilityView, CapabilityDesign, CapabilityManage, CapabilityControl},
	},
	{
		Name:         "Designer",
		GUID:         "designer-00000000-0000-0000-0000-000000000002",
		Capabilities: []Capability{CapabilityView, CapabilityDesign, CapabilityControl},
	},
	{
		Name:         "Support",
		GUID:         "support-00000000-0000-0000-0000-000000000003",
		Capabilities: []Capability{CapabilityView, CapabilityControl},
	},
}
