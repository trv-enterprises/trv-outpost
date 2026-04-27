// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// APIKeyHandler exposes API key management to authenticated browser
// callers. The agent/MCP path uses the validated key directly via the
// auth middleware — those callers never touch this handler.
type APIKeyHandler struct {
	service *service.APIKeyService
}

// NewAPIKeyHandler constructs a handler from the API key service.
func NewAPIKeyHandler(svc *service.APIKeyService) *APIKeyHandler {
	return &APIKeyHandler{service: svc}
}

// CreateAPIKey issues a new key for the calling user. The plaintext
// token is included in the response exactly once and never persisted —
// the UI must surface a "save this now, you can't see it again" warning.
// @Summary Create an API key for the calling user
// @Tags api-keys
// @Accept json
// @Produce json
// @Param body body models.CreateAPIKeyRequest true "Key parameters"
// @Success 201 {object} models.CreateAPIKeyResponse
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Router /api/api-keys [post]
func (h *APIKeyHandler) CreateAPIKey(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	var req models.CreateAPIKeyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	resp, err := h.service.Create(c.Request.Context(), user.GUID, &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, resp)
}

// ListMyAPIKeys returns the calling user's keys (active + revoked).
// Hashes are stripped at the service layer.
// @Summary List the calling user's API keys
// @Tags api-keys
// @Produce json
// @Success 200 {array} models.APIKey
// @Failure 401 {object} map[string]string
// @Router /api/api-keys [get]
func (h *APIKeyHandler) ListMyAPIKeys(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	keys, err := h.service.ListByUser(c.Request.Context(), user.GUID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, keys)
}

// ListAllAPIKeys is the admin view — every key in the deployment.
// Requires the manage capability (gated by the route middleware).
// @Summary List every API key in the deployment (admin)
// @Tags api-keys
// @Produce json
// @Success 200 {array} models.APIKey
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Router /api/api-keys/all [get]
func (h *APIKeyHandler) ListAllAPIKeys(c *gin.Context) {
	keys, err := h.service.ListAll(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, keys)
}

// RevokeAPIKey marks a key as revoked. Owners may revoke their own
// keys; admins (manage capability) may revoke anyone's via the same
// endpoint — ownership check is skipped when the caller has manage.
// @Summary Revoke an API key
// @Tags api-keys
// @Param id path string true "API key ID"
// @Success 204 "No Content"
// @Failure 401 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/api-keys/{id} [delete]
func (h *APIKeyHandler) RevokeAPIKey(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	requireOwner := user.GUID
	if user.HasCapability(models.CapabilityManage) {
		requireOwner = ""
	}
	err := h.service.Revoke(c.Request.Context(), c.Param("id"), requireOwner)
	if err != nil {
		if errors.Is(err, service.ErrAPIKeyNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "api key not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}
