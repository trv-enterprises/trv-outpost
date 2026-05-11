// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// AuthHandler handles authentication endpoints
type AuthHandler struct {
	userService *service.UserService
}

// NewAuthHandler creates a new auth handler
func NewAuthHandler(userService *service.UserService) *AuthHandler {
	return &AuthHandler{userService: userService}
}

// GetMe returns the current user's capabilities
// @Summary Get current user capabilities
// @Description Returns the authenticated user's ID, name, and capabilities
// @Tags Auth
// @Produce json
// @Success 200 {object} models.UserCapabilitiesResponse
// @Failure 401 {object} map[string]string
// @Router /auth/me [get]
func (h *AuthHandler) GetMe(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}

	response := h.userService.GetCapabilities(c.Request.Context(), user)
	c.JSON(http.StatusOK, response)
}

// ListUsers returns all users (admin only)
// @Summary List all users
// @Description Returns a paginated list of all users
// @Tags Users
// @Produce json
// @Param page query int false "Page number" default(1)
// @Param page_size query int false "Page size" default(10)
// @Success 200 {object} models.UserListResponse
// @Failure 403 {object} map[string]string
// @Router /users [get]
func (h *AuthHandler) ListUsers(c *gin.Context) {
	page := 1
	pageSize := 10

	if p := c.Query("page"); p != "" {
		if parsed, err := parseIntFromQuery(p); err == nil && parsed > 0 {
			page = parsed
		}
	}
	if ps := c.Query("page_size"); ps != "" {
		if parsed, err := parseIntFromQuery(ps); err == nil && parsed > 0 {
			pageSize = parsed
		}
	}

	response, err := h.userService.ListUsers(c.Request.Context(), page, pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetUser returns a specific user by ID. Manage-only. There is no
// self-management UI today, so non-Manage callers have no business
// reading another user's record — and they get their own identity
// via /api/auth/me, which carries everything the SPA bootstrap and
// header pill need (id, guid, name, capabilities).
// @Summary Get user by ID (admin only)
// @Description Returns a user by their ID. Requires Manage capability.
// @Tags Users
// @Produce json
// @Param id path string true "User ID"
// @Success 200 {object} models.User
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /users/{id} [get]
func (h *AuthHandler) GetUser(c *gin.Context) {
	id := c.Param("id")

	user, err := h.userService.GetUser(c.Request.Context(), id)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, user)
}

// GetUserByGUID resolves a single user record from a GUID.
// Manage-only — same reasoning as GetUser. The SPA bootstrap uses
// /api/auth/me for self-info, so this endpoint is only ever called
// from admin Manage UIs.
// @Summary Get user by GUID (admin only)
// @Description Returns a user by their GUID. Requires Manage capability.
// @Tags Users
// @Produce json
// @Param guid path string true "User GUID"
// @Success 200 {object} models.User
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /users/by-guid/{guid} [get]
func (h *AuthHandler) GetUserByGUID(c *gin.Context) {
	guid := c.Param("guid")

	user, err := h.userService.GetUserByGUID(c.Request.Context(), guid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if user == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}

	c.JSON(http.StatusOK, user)
}

// CreateUser creates a new user
// @Summary Create a new user
// @Description Creates a new user account
// @Tags Users
// @Accept json
// @Produce json
// @Param user body models.CreateUserRequest true "User data"
// @Success 201 {object} models.User
// @Failure 400 {object} map[string]string
// @Router /users [post]
func (h *AuthHandler) CreateUser(c *gin.Context) {
	var req models.CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := h.userService.CreateUser(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, user)
}

// UpdateUser updates an existing user
// @Summary Update a user
// @Description Updates an existing user's information
// @Tags Users
// @Accept json
// @Produce json
// @Param id path string true "User ID"
// @Param user body models.UpdateUserRequest true "User data"
// @Success 200 {object} models.User
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /users/{id} [put]
func (h *AuthHandler) UpdateUser(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	user, err := h.userService.UpdateUser(c.Request.Context(), id, &req)
	if err != nil {
		if err.Error() == "user not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, user)
}

// DeleteUser deletes a user
// @Summary Delete a user
// @Description Deletes a user account
// @Tags Users
// @Param id path string true "User ID"
// @Success 204 "No Content"
// @Failure 404 {object} map[string]string
// @Router /users/{id} [delete]
func (h *AuthHandler) DeleteUser(c *gin.Context) {
	id := c.Param("id")

	if err := h.userService.DeleteUser(c.Request.Context(), id); err != nil {
		if err.Error() == "user not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// parseIntFromQuery parses an integer from a query string
func parseIntFromQuery(s string) (int, error) {
	return strconv.Atoi(s)
}
