// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// SystemUserHandler manages non-interactive service principals.
// Routes are Manage-only (gated by the auth middleware). The handler
// reuses UserService.CreateSystemUser / ListSystemUsers / DeleteUser
// and APIKeyService.Create to mint keys for the system principal —
// no new key-storage code, the existing trve_<base32> token shape
// works unchanged for inbound webhook callers.
type SystemUserHandler struct {
	users   *service.UserService
	apiKeys *service.APIKeyService
}

// NewSystemUserHandler wires the user + api-key services together
// for the small set of admin-only operations the System Users page
// exposes.
func NewSystemUserHandler(users *service.UserService, apiKeys *service.APIKeyService) *SystemUserHandler {
	return &SystemUserHandler{users: users, apiKeys: apiKeys}
}

// CreateSystemUserRequest is the body of POST /api/system-users.
// Display name is required; capabilities are optional. When omitted,
// the service grants the default set (view + webhook) — the canonical
// set for inbound integrations. To grant a broader set (design,
// manage), pass an explicit list. Email and ClerkUserID are not
// accepted on this route because system principals do not sign in
// interactively.
type CreateSystemUserRequest struct {
	Name         string              `json:"name" binding:"required"`
	Capabilities []models.Capability `json:"capabilities,omitempty"`
}

// CreateSystemUser provisions a new system principal.
// @Summary Create a system user (admin only)
// @Description Creates a non-interactive service principal. Capabilities default to ["view","webhook"] when omitted. Mint an API key via /api/system-users/:id/api-keys to authenticate inbound webhooks as this user.
// @Tags SystemUsers
// @Accept json
// @Produce json
// @Param body body CreateSystemUserRequest true "System user parameters"
// @Success 201 {object} models.User
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Router /system-users [post]
func (h *SystemUserHandler) CreateSystemUser(c *gin.Context) {
	var req CreateSystemUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	user, err := h.users.CreateSystemUser(c.Request.Context(), req.Name, req.Capabilities)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, user)
}

// ListSystemUsers returns every system principal in the deployment.
// @Summary List system users (admin only)
// @Tags SystemUsers
// @Produce json
// @Success 200 {array} models.User
// @Failure 403 {object} map[string]string
// @Router /system-users [get]
func (h *SystemUserHandler) ListSystemUsers(c *gin.Context) {
	users, err := h.users.ListSystemUsers(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// DeleteSystemUser removes a system principal. Cascades via the
// existing UserService.DeleteUser, which also wipes any API keys
// owned by the user — so an admin deleting a system user
// effectively revokes every key that integration was using.
// @Summary Delete a system user (admin only)
// @Tags SystemUsers
// @Param id path string true "System user ID (Mongo _id)"
// @Success 204 "No Content"
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /system-users/{id} [delete]
func (h *SystemUserHandler) DeleteSystemUser(c *gin.Context) {
	id := c.Param("id")
	// Guard rail: refuse to delete a record that isn't actually a
	// system user, so this route can't double as a back-door human-
	// user delete that bypasses any future per-kind UI constraints.
	user, err := h.users.GetUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !user.IsSystem() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a system user"})
		return
	}
	if err := h.users.DeleteUser(c.Request.Context(), id); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// CreateSystemUserAPIKey mints a new trve_<base32> API key whose
// owner is the named system user. Plaintext token is returned once
// and never again. Use for inbound-webhook receivers where the
// external service (e.g. ts-store) needs a stable bearer token.
// @Summary Mint an API key for a system user (admin only)
// @Tags SystemUsers
// @Accept json
// @Produce json
// @Param id path string true "System user ID (Mongo _id)"
// @Param body body models.CreateAPIKeyRequest true "Key parameters (just a label)"
// @Success 201 {object} models.CreateAPIKeyResponse
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /system-users/{id}/api-keys [post]
func (h *SystemUserHandler) CreateSystemUserAPIKey(c *gin.Context) {
	id := c.Param("id")
	user, err := h.users.GetUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !user.IsSystem() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a system user"})
		return
	}
	var req models.CreateAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, err := h.apiKeys.Create(c.Request.Context(), user.GUID, &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, resp)
}

// ListSystemUserAPIKeys returns the keys owned by a specific system
// user. Bcrypt hashes are stripped at the service layer.
// @Summary List API keys for a system user (admin only)
// @Tags SystemUsers
// @Produce json
// @Param id path string true "System user ID (Mongo _id)"
// @Success 200 {array} models.APIKey
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /system-users/{id}/api-keys [get]
func (h *SystemUserHandler) ListSystemUserAPIKeys(c *gin.Context) {
	id := c.Param("id")
	user, err := h.users.GetUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !user.IsSystem() {
		c.JSON(http.StatusBadRequest, gin.H{"error": "not a system user"})
		return
	}
	keys, err := h.apiKeys.ListByUser(c.Request.Context(), user.GUID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, keys)
}
