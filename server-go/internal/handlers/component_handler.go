// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/connection"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// ComponentHandler handles component-related HTTP requests
type ComponentHandler struct {
	service *service.ComponentService
	// connectionService powers the execute-by-reference data endpoint
	// (#23): the handler loads the stored component and runs its query
	// through the same service path as /api/connections/:id/query.
	connectionService *service.ConnectionService
}

// NewComponentHandler creates a new component handler
func NewComponentHandler(service *service.ComponentService, connectionService *service.ConnectionService) *ComponentHandler {
	return &ComponentHandler{
		service:           service,
		connectionService: connectionService,
	}
}

// CreateComponent creates a new component
// @Summary Create a new component
// @Description Create a new component (chart, control, or display) with optional data source binding and visualization config. Creates as version 1 with status "final".
// @Tags components
// @Accept json
// @Produce json
// @Param component body models.CreateComponentRequest true "Component data"
// @Success 201 {object} models.Component
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components [post]
func (h *ComponentHandler) CreateComponent(c *gin.Context) {
	var req models.CreateComponentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	component, err := h.service.CreateComponent(c.Request.Context(), &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "already exists") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusCreated, component)
}

// GetComponent retrieves the latest version of a component by ID
// @Summary Get a component
// @Description Get the latest version of a component by ID
// @Tags components
// @Produce json
// @Param id path string true "Component ID"
// @Success 200 {object} models.Component
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id} [get]
func (h *ComponentHandler) GetComponent(c *gin.Context) {
	id := c.Param("id")

	component, err := h.service.GetComponent(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, component)
}

// buildComponentDataQuery assembles the query to execute for an
// execute-by-reference data request: the component's STORED query config
// plus only the reserved runtime keys from the client (dashboard_variable,
// range). Stored positional params can never be overridden by the caller.
//
// An EMPTY Raw is valid, not an error: some connection types define the whole
// query in the connection itself (an API connection's URL is the endpoint; a
// streaming tsstore connection's transport is the source), so the stored
// query_config legitimately carries `raw: ""`. The adapter decides what an
// empty raw means for its type. We only require that a QueryConfig exists at
// all; the handler separately requires the component to have a connection.
func buildComponentDataQuery(component *models.Component, req *models.ComponentDataRequest) (models.Query, error) {
	if component.QueryConfig == nil {
		return models.Query{}, errors.New("component has no stored query config")
	}

	params := make(map[string]interface{}, len(component.QueryConfig.Params)+2)
	for k, v := range component.QueryConfig.Params {
		params[k] = v
	}
	if req.DashboardVariable != nil {
		params[connection.DashboardVariableParam] = req.DashboardVariable
	}
	if req.Range != nil {
		params[connection.RangeParam] = req.Range
	}

	return models.Query{
		Raw:    component.QueryConfig.Raw,
		Type:   models.QueryType(component.QueryConfig.Type),
		Params: params,
	}, nil
}

// GetComponentData executes a component's STORED query and returns the data.
// Execute-by-reference (#23): view mode calls this with runtime values only —
// the query text never crosses the wire, so a tampering client has nothing to
// inject. Variable/range substitution happens server-side exactly as on the
// raw /query path.
// @Summary Execute a component's stored query
// @Description Runs the component's stored query_config against its connection, merging only the reserved runtime values (dashboard_variable, range) from the request. The optional connection_id override (dashboard connection-swap) must reference a connection of the same type as the stored one.
// @Tags components
// @Accept json
// @Produce json
// @Param id path string true "Component ID"
// @Param request body models.ComponentDataRequest false "Runtime values"
// @Success 200 {object} models.QueryResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /components/{id}/data [post]
func (h *ComponentHandler) GetComponentData(c *gin.Context) {
	id := c.Param("id")

	var req models.ComponentDataRequest
	if c.Request.ContentLength > 0 {
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
	}

	component, err := h.service.GetComponent(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	if component.ConnectionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Component has no connection configured"})
		return
	}

	// Resolve the effective connection. A connection-swap override is only
	// honored when it names an existing connection of the SAME type as the
	// stored one — a view user must not be able to point a stored query at
	// an arbitrary other-dialect connection.
	connectionID := component.ConnectionID
	if req.ConnectionID != "" && req.ConnectionID != component.ConnectionID {
		stored, err := h.connectionService.GetConnection(c.Request.Context(), component.ConnectionID)
		if err != nil || stored == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Component's connection not found"})
			return
		}
		target, err := h.connectionService.GetConnection(c.Request.Context(), req.ConnectionID)
		if err != nil || target == nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Connection override not found"})
			return
		}
		if target.Type != stored.Type {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Connection override type does not match the component's connection type"})
			return
		}
		connectionID = req.ConnectionID
	}

	query, err := buildComponentDataQuery(component, &req)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Trusted internal call: the query text came from the STORED component,
	// not the client, so it's exempt from the raw-query capability gate
	// (the verb guard still applies). This is what lets view users run
	// their dashboards' SQL/EdgeLake components without design.
	ctx := service.WithTrustedQuery(c.Request.Context())
	response, err := h.connectionService.QueryConnection(ctx, connectionID, &models.QueryRequest{Query: query})
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetComponentVersion retrieves a specific version of a component
// @Summary Get a specific component version
// @Description Get a specific version of a component by ID and version number
// @Tags components
// @Produce json
// @Param id path string true "Component ID"
// @Param version path int true "Version number"
// @Success 200 {object} models.Component
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/versions/{version} [get]
func (h *ComponentHandler) GetComponentVersion(c *gin.Context) {
	id := c.Param("id")
	versionStr := c.Param("version")

	version, err := strconv.Atoi(versionStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid version number"})
		return
	}

	component, err := h.service.GetComponentVersion(c.Request.Context(), id, version)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, component)
}

// ListComponentVersions retrieves all versions of a component
// @Summary List component versions
// @Description Get all versions of a component by ID
// @Tags components
// @Produce json
// @Param id path string true "Component ID"
// @Success 200 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/versions [get]
func (h *ComponentHandler) ListComponentVersions(c *gin.Context) {
	id := c.Param("id")

	versions, err := h.service.ListComponentVersions(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"versions": versions})
}

// GetComponentVersionInfo retrieves version metadata for delete dialogs
// @Summary Get component version info
// @Description Get version metadata for a component (version count, has draft, etc.)
// @Tags components
// @Produce json
// @Param id path string true "Component ID"
// @Success 200 {object} models.ComponentVersionInfo
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/version-info [get]
func (h *ComponentHandler) GetComponentVersionInfo(c *gin.Context) {
	id := c.Param("id")

	info, err := h.service.GetVersionInfo(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, info)
}

// GetComponentDraft retrieves the draft version of a component
// @Summary Get component draft
// @Description Get the draft version of a component (if exists)
// @Tags components
// @Produce json
// @Param id path string true "Component ID"
// @Success 200 {object} models.Component
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/draft [get]
func (h *ComponentHandler) GetComponentDraft(c *gin.Context) {
	id := c.Param("id")

	component, err := h.service.GetComponentDraft(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no draft found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "No draft found for component"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, component)
}

// ListComponents retrieves a list of components with pagination
// @Summary List components
// @Description Get a paginated list of components (latest version of each) with optional filtering
// @Tags components
// @Produce json
// @Param name query string false "Filter by name (case-insensitive word-prefix match — `ts` matches `TS-Store` but not `Lights`)"
// @Param chart_type query string false "Filter by chart sub-type"
// @Param component_type query string false "Filter by component type (chart, control, display)"
// @Param status query string false "Filter by status (draft, final)"
// @Param connection_id query string false "Filter by data source ID"
// @Param tag query string false "Filter by tag"
// @Param sort query string false "Sort field (name, updated, created, component_type, chart_type, status, namespace)"
// @Param direction query string false "Sort direction (asc, desc)"
// @Param include_usage query boolean false "Include per-component dashboard usage (count + navigable list); returns ComponentUsageListResponse shape"
// @Param page query int false "Page number" default(1)
// @Param page_size query string false "Page size; 'all' or 0 returns up to 1000 in one response" default(20)
// @Success 200 {object} models.ComponentListResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components [get]
func (h *ComponentHandler) ListComponents(c *gin.Context) {
	normalizeAllPageSize(c)
	var params models.ComponentQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// include_usage=true returns each row with its denormalized dashboard
	// usage (count + navigable {id,name} list), so the components list page
	// doesn't fetch every dashboard client-side. Heavier aggregation; opt-in.
	if c.Query("include_usage") == "true" {
		response, err := h.service.ListComponentsWithUsage(c.Request.Context(), params)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, response)
		return
	}

	response, err := h.service.ListComponents(c.Request.Context(), params)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetComponentSummaries retrieves lightweight component summaries for card display
// @Summary Get component summaries
// @Description Get lightweight component summaries for card-based selection UI
// @Tags components
// @Produce json
// @Param limit query int false "Maximum number of summaries" default(50)
// @Success 200 {array} models.ComponentSummary
// @Failure 500 {object} map[string]interface{}
// @Router /components/summaries [get]
func (h *ComponentHandler) GetComponentSummaries(c *gin.Context) {
	limit := int64(50)
	if l := c.Query("limit"); l != "" {
		if parsed, err := strconv.ParseInt(l, 10, 64); err == nil && parsed > 0 {
			limit = parsed
		}
	}

	summaries, err := h.service.GetComponentSummaries(c.Request.Context(), limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"summaries": summaries})
}

// UpdateComponent updates the latest version of a component in-place
// @Summary Update a component
// @Description Update the latest version of a component in-place (for manual edits)
// @Tags components
// @Accept json
// @Produce json
// @Param id path string true "Component ID"
// @Param component body models.UpdateComponentRequest true "Component update data"
// @Success 200 {object} models.Component
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id} [put]
func (h *ComponentHandler) UpdateComponent(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateComponentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	component, err := h.service.UpdateComponent(c.Request.Context(), id, &req)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.Contains(err.Error(), "not found") {
			status = http.StatusNotFound
		} else if strings.Contains(err.Error(), "already exists") {
			status = http.StatusBadRequest
		}
		c.JSON(status, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, component)
}

// DeleteComponent deletes all versions of a component. Returns 409
// with a usage payload when dashboards still reference the component.
// @Summary Delete a component
// @Description Delete all versions of a component by ID
// @Tags components
// @Param id path string true "Component ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 409 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id} [delete]
func (h *ComponentHandler) DeleteComponent(c *gin.Context) {
	id := c.Param("id")

	usage, err := h.service.DeleteComponent(c.Request.Context(), id)
	if err != nil {
		if errors.Is(err, service.ErrComponentInUse) {
			c.JSON(http.StatusConflict, gin.H{
				"error": err.Error(),
				"usage": usage,
			})
			return
		}
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// DeleteComponentVersion deletes a specific version of a component
// @Summary Delete a component version
// @Description Delete a specific version of a component
// @Tags components
// @Param id path string true "Component ID"
// @Param version path int true "Version number"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/versions/{version} [delete]
func (h *ComponentHandler) DeleteComponentVersion(c *gin.Context) {
	id := c.Param("id")
	versionStr := c.Param("version")

	version, err := strconv.Atoi(versionStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid version number"})
		return
	}

	err = h.service.DeleteComponentVersion(c.Request.Context(), id, version)
	if err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "Component version not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// DeleteComponentDraft deletes only the draft version of a component
// @Summary Delete component draft
// @Description Delete the draft version of a component (if exists)
// @Tags components
// @Param id path string true "Component ID"
// @Success 204
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /components/{id}/draft [delete]
func (h *ComponentHandler) DeleteComponentDraft(c *gin.Context) {
	id := c.Param("id")

	err := h.service.DeleteComponentDraft(c.Request.Context(), id)
	if err != nil {
		if strings.Contains(err.Error(), "no draft found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "No draft found for component"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}
