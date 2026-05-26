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

// SnippetHandler exposes the generic snippets API. A snippet belongs to
// a host surface ("context") — e.g. "edgelake-terminal" today, potentially
// "mqtt-publisher" or "sql-adhoc" later. User snippets are private to
// the owner; global snippets are visible to everyone and editable only
// by users with Manage capability.
type SnippetHandler struct {
	service *service.SnippetService
}

// NewSnippetHandler constructs the handler.
func NewSnippetHandler(svc *service.SnippetService) *SnippetHandler {
	return &SnippetHandler{service: svc}
}

// ListSnippets godoc
// @Summary List snippets visible to the caller for a given host surface
// @Description Returns the merged set of user-scoped snippets owned by the caller plus all global snippets, filtered to the requested `context` (e.g. `edgelake-terminal`). Each record carries a `can_edit` flag derived from the caller's capabilities — global snippets are only editable by users with Manage capability.
// @Tags snippets
// @Produce json
// @Param context query string true "Host surface key (e.g. edgelake-terminal)"
// @Success 200 {object} models.SnippetListResponse
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Router /api/snippets [get]
func (h *SnippetHandler) ListSnippets(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	contextKey := c.Query("context")
	if contextKey == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "context query parameter required"})
		return
	}
	rows, err := h.service.List(c.Request.Context(), user, contextKey)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if rows == nil {
		rows = []models.SnippetResponse{}
	}
	c.JSON(http.StatusOK, models.SnippetListResponse{Snippets: rows})
}

// CreateSnippet godoc
// @Summary Create a snippet
// @Description Create a user snippet (default) or a global snippet (requires Manage capability). The `scope` field is immutable after creation — promote a user snippet to global by deleting and re-creating.
// @Tags snippets
// @Accept json
// @Produce json
// @Param body body models.CreateSnippetRequest true "Snippet payload"
// @Success 201 {object} models.Snippet
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Router /api/snippets [post]
func (h *SnippetHandler) CreateSnippet(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	var req models.CreateSnippetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	sn, err := h.service.Create(c.Request.Context(), user, &req)
	if err != nil {
		h.writeError(c, err)
		return
	}
	c.JSON(http.StatusCreated, sn)
}

// UpdateSnippet godoc
// @Summary Update a snippet
// @Description Edit title, command, and tags. Owner can edit user snippets; Manage capability required to edit globals.
// @Tags snippets
// @Accept json
// @Produce json
// @Param id path string true "Snippet ID"
// @Param body body models.UpdateSnippetRequest true "Snippet payload"
// @Success 200 {object} models.Snippet
// @Failure 400 {object} map[string]string
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/snippets/{id} [put]
func (h *SnippetHandler) UpdateSnippet(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	var req models.UpdateSnippetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	sn, err := h.service.Update(c.Request.Context(), user, c.Param("id"), &req)
	if err != nil {
		h.writeError(c, err)
		return
	}
	c.JSON(http.StatusOK, sn)
}

// DeleteSnippet godoc
// @Summary Delete a snippet
// @Description Same ownership and capability rules as update.
// @Tags snippets
// @Param id path string true "Snippet ID"
// @Success 204 "No Content"
// @Failure 401 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /api/snippets/{id} [delete]
func (h *SnippetHandler) DeleteSnippet(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}
	if err := h.service.Delete(c.Request.Context(), user, c.Param("id")); err != nil {
		h.writeError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

func (h *SnippetHandler) writeError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrSnippetNotFound):
		c.JSON(http.StatusNotFound, gin.H{"error": "snippet not found"})
	case errors.Is(err, service.ErrSnippetForbidden), errors.Is(err, service.ErrSnippetGlobalManage):
		c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
	case errors.Is(err, service.ErrSnippetInvalidScope), errors.Is(err, service.ErrSnippetInvalidField):
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
	default:
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
	}
}
