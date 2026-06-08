// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
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
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 200 {object} models.Namespace
// @Failure 404 {object} map[string]string
// @Router /namespaces/{id} [get]
func (h *NamespaceHandler) GetNamespace(c *gin.Context) {
	ns, err := h.service.GetByID(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if ns == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
		return
	}
	c.JSON(http.StatusOK, ns)
}

// ListNamespaces lists all namespaces.
// @Summary List namespaces
// @Tags namespaces
// @Produce json
// @Success 200 {object} models.NamespaceListResponse
// @Router /namespaces [get]
func (h *NamespaceHandler) ListNamespaces(c *gin.Context) {
	resp, err := h.service.List(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, resp)
}

// UpdateNamespace updates a namespace by ID.
// @Summary Update a namespace
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
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// GetUsage returns usage counts for a namespace. The :id path param is
// the namespace ID (UUID), not its slug — the service looks up the slug
// internally so callers don't need to know the ID→slug mapping.
// @Summary Get namespace usage counts
// @Tags namespaces
// @Produce json
// @Param id path string true "Namespace ID"
// @Success 200 {object} models.NamespaceUsage
// @Router /namespaces/{id}/usage [get]
func (h *NamespaceHandler) GetUsage(c *gin.Context) {
	ns, err := h.service.GetByID(c.Request.Context(), c.Param("id"))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if ns == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "namespace not found"})
		return
	}
	usage, err := h.service.Usage(c.Request.Context(), ns.Name)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, usage)
}
