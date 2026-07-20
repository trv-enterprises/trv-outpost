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
	"go.mongodb.org/mongo-driver/mongo"
)

// NamespaceHandler handles namespace HTTP requests.
type NamespaceHandler struct {
	service *service.NamespaceService
}

// NewNamespaceHandler creates a namespace handler.
func NewNamespaceHandler(svc *service.NamespaceService) *NamespaceHandler {
	return &NamespaceHandler{service: svc}
}

// CreateNamespace creates a new namespace.
// @Summary Create a namespace
// @Description Creates a namespace. The name must be a slug-safe string and globally unique; color defaults to the standard namespace color when omitted.
// @Tags namespaces
// @Accept json
// @Produce json
// @Param body body models.CreateNamespaceRequest true "Namespace to create"
// @Success 201 {object} models.Namespace
// @Failure 400 {object} map[string]string
// @Router /namespaces [post]
func (h *NamespaceHandler) CreateNamespace(c *gin.Context) {
	var req models.CreateNamespaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ns, err := h.service.Create(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, ns)
}

// GetNamespace retrieves a namespace by ID.
// @Summary Get a namespace
// @Description Retrieves a single namespace record (name, description, color) by its ID.
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 200 {object} models.Namespace
// @Failure 404 {object} map[string]string
// @Router /namespaces/{id} [get]
func (h *NamespaceHandler) GetNamespace(c *gin.Context) {
	ns, err := h.service.GetByID(c.Request.Context(), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	if ns == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
		return
	}
	c.JSON(http.StatusOK, ns)
}

// ListNamespaces lists the namespaces visible to the caller (granted
// only, for restricted users — issue #4). scope=all returns the full
// catalog for admin surfaces and requires the manage capability; the
// route-rule table can't see query params, so the elevation is checked
// here.
// @Summary List namespaces
// @Description Lists the namespaces visible to the caller — restricted users see only their granted namespaces. Pass scope=all to list every namespace regardless of grants; that elevation requires the manage capability and returns 403 without it.
// @Tags namespaces
// @Produce json
// @Param scope query string false "Set to 'all' to list every namespace regardless of the caller's grants (requires manage capability)"
// @Success 200 {object} models.NamespaceListResponse
// @Failure 403 {object} map[string]interface{}
// @Router /namespaces [get]
func (h *NamespaceHandler) ListNamespaces(c *gin.Context) {
	if c.Query("scope") == "all" {
		user := middleware.GetUser(c)
		if user == nil || !user.HasManageAccess() {
			c.JSON(http.StatusForbidden, gin.H{"error": "manage capability required for scope=all"})
			return
		}
		resp, err := h.service.ListAll(c.Request.Context())
		if err != nil {
			respondError(c, err)
			return
		}
		c.JSON(http.StatusOK, resp)
		return
	}
	resp, err := h.service.List(c.Request.Context())
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, resp)
}

// GetNamespaceUsers lists the users granted access to this namespace
// (#4). Restricted users only — unrestricted users implicitly see
// every namespace, so listing them here would be noise (the page
// states this). Manage-gated by the route table.
// @Summary List users with access to a namespace
// @Description Lists the restricted users holding an explicit grant on this namespace. Unrestricted users implicitly see every namespace and are not included.
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 200 {object} map[string]interface{} "{ users: [...] }"
// @Failure 404 {object} map[string]string
// @Router /namespaces/{id}/users [get]
func (h *NamespaceHandler) GetNamespaceUsers(c *gin.Context) {
	users, err := h.service.UsersWithAccess(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
			return
		}
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{"users": users})
}

// UpdateNamespace updates a namespace by ID.
// @Summary Update a namespace
// @Description Updates a namespace's name, description, or color. Renaming cascades the new slug into every connection, component, and dashboard tagged with the old slug, and into user namespace grants. The default namespace cannot be renamed (409).
// @Tags namespaces
// @Accept json
// @Produce json
// @Param id path string true "Namespace ID"
// @Param body body models.UpdateNamespaceRequest true "Fields to update"
// @Success 200 {object} models.Namespace
// @Failure 400 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /namespaces/{id} [put]
func (h *NamespaceHandler) UpdateNamespace(c *gin.Context) {
	var req models.UpdateNamespaceRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	ns, err := h.service.Update(c.Request.Context(), c.Param("id"), &req)
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
			return
		}
		if errors.Is(err, service.ErrDefaultNamespaceImmutable) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ns)
}

// DeleteNamespace deletes a namespace, returning 409 with usage counts
// if any records still reference it.
// @Summary Delete a namespace
// @Description Deletes a namespace only if nothing references it — when connections, components, or dashboards still use it, responds 409 with per-type usage counts. The default namespace can never be deleted (409). On success, the namespace is also removed from every user's grants.
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 204 "No Content"
// @Failure 404 {object} map[string]string
// @Failure 409 {object} map[string]interface{}
// @Router /namespaces/{id} [delete]
func (h *NamespaceHandler) DeleteNamespace(c *gin.Context) {
	usage, err := h.service.Delete(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, mongo.ErrNoDocuments) {
			c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
			return
		}
		if errors.Is(err, service.ErrDefaultNamespaceImmutable) {
			c.JSON(http.StatusConflict, gin.H{"error": err.Error()})
			return
		}
		if errors.Is(err, service.ErrNamespaceInUse) {
			c.JSON(http.StatusConflict, gin.H{
				"error": err.Error(),
				"usage": usage,
			})
			return
		}
		respondError(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// GetUsage returns usage counts for a namespace. The :id path param is
// the namespace ID (UUID), not its slug — the service looks up the slug
// internally so callers don't need to know the ID→slug mapping.
// @Summary Get namespace usage counts
// @Description Returns per-entity-type counts (connections, components, dashboards) of records in this namespace. The path parameter is the namespace ID (UUID), not its slug.
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 200 {object} models.NamespaceUsage
// @Router /namespaces/{id}/usage [get]
func (h *NamespaceHandler) GetUsage(c *gin.Context) {
	ns, err := h.service.GetByID(c.Request.Context(), c.Param("id"))
	if err != nil {
		respondError(c, err)
		return
	}
	if ns == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
		return
	}
	usage, err := h.service.Usage(c.Request.Context(), ns.Name)
	if err != nil {
		respondError(c, err)
		return
	}
	c.JSON(http.StatusOK, usage)
}
