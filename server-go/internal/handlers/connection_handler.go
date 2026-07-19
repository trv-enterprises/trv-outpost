// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
)

// connectionResponse wraps a connection with its registry capabilities
type connectionResponse struct {
	*models.Connection
	Capabilities *registry.Capabilities `json:"capabilities,omitempty"`
}

// enrichWithCapabilities wraps a sanitized connection with capabilities from the registry
func enrichWithCapabilities(ds *models.Connection) connectionResponse {
	resp := connectionResponse{Connection: ds}
	typeID := ds.GetEffectiveTypeID()
	if info, ok := registry.GetTypeInfo(typeID); ok {
		resp.Capabilities = &info.Capabilities
	}
	return resp
}

// ConnectionHandler handles connection HTTP requests
type ConnectionHandler struct {
	service *service.ConnectionService
}

// NewConnectionHandler creates a new connection handler
func NewConnectionHandler(service *service.ConnectionService) *ConnectionHandler {
	return &ConnectionHandler{
		service: service,
	}
}

// CreateConnection handles connection creation
// @Summary Create a new connection
// @Description Create a new data source (API, WebSocket, or File)
// @Tags connections
// @Accept json
// @Produce json
// @Param connection body models.CreateConnectionRequest true "Connection to create"
// @Success 201 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /connections [post]
func (h *ConnectionHandler) CreateConnection(c *gin.Context) {
	var req models.CreateConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	connection, err := h.service.CreateConnection(c.Request.Context(), &req)
	if err != nil {
		respondError(c, err)
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusCreated, enrichWithCapabilities(connection.SanitizeForAPI()))
}

// ListConnections handles connection listing
// @Summary List all connections
// @Description Retrieve connections with server-side filter, sort, and pagination. Accepts page/page_size (preferred) or legacy limit/offset.
// @Tags connections
// @Produce json
// @Param namespace query string false "Filter by namespace (empty = all namespaces)"
// @Param name query string false "Filter by name (case-insensitive substring)"
// @Param type query string false "Filter by connection type"
// @Param tags query []string false "Filter by tags (OR semantics, repeat param)"
// @Param sort query string false "Sort field (name, created_at, updated_at, type, namespace)"
// @Param direction query string false "Sort direction (asc, desc)"
// @Param include_usage query boolean false "Include per-connection component usage (count + navigable list); each row becomes {connection, component_usage, component_count}"
// @Param page query int false "Page number" default(1)
// @Param page_size query string false "Page size; 'all' or 0 returns up to 1000 in one response" default(20)
// @Success 200 {object} map[string]interface{}
// @Router /connections [get]
func (h *ConnectionHandler) ListConnections(c *gin.Context) {
	normalizeAllPageSize(c)

	var params models.ConnectionQueryParams
	if err := c.ShouldBindQuery(&params); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	// Back-compat: honor legacy limit/offset when page/page_size are absent
	// (existing API-key callers). offset → page; limit → page_size.
	if params.Page == 0 && params.PageSize == 0 {
		if lim := c.Query("limit"); lim != "" {
			if l, err := strconv.Atoi(lim); err == nil {
				params.PageSize = l
			}
		}
		if off := c.Query("offset"); off != "" {
			if o, err := strconv.Atoi(off); err == nil && params.PageSize > 0 {
				params.Page = (o / params.PageSize) + 1
			}
		}
	}

	// include_usage=true returns each row with its denormalized component
	// usage (count + navigable {id,name} list). Opt-in (heavier aggregation).
	if c.Query("include_usage") == "true" {
		rows, meta, err := h.service.ListConnectionsWithUsage(c.Request.Context(), params)
		if err != nil {
			respondError(c, err)
			return
		}
		out := make([]gin.H, len(rows))
		for i := range rows {
			conn := rows[i].Connection // value copy; sanitize before exposing
			out[i] = gin.H{
				"connection":      enrichWithCapabilities(conn.SanitizeForAPI()),
				"component_usage": rows[i].ComponentUsage,
				"component_count": rows[i].ComponentCount,
			}
		}
		c.JSON(http.StatusOK, gin.H{
			"connections": out,
			"total":       meta.Total,
			"page":        meta.Page,
			"page_size":   meta.PageSize,
			"has_more":    meta.HasMore,
		})
		return
	}

	resp, err := h.service.ListConnectionsPaged(c.Request.Context(), params)
	if err != nil {
		respondError(c, err)
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning.
	enrichedConnections := make([]connectionResponse, len(resp.Connections))
	for i, ds := range resp.Connections {
		enrichedConnections[i] = enrichWithCapabilities(ds.SanitizeForAPI())
	}

	c.JSON(http.StatusOK, gin.H{
		"connections": enrichedConnections,
		"total":       resp.Total,
		"page":        resp.Page,
		"page_size":   resp.PageSize,
		"has_more":    resp.HasMore,
	})
}

// GetConnection handles retrieving a single connection
// @Summary Get a connection by ID
// @Description Retrieve a single connection by its ID
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id} [get]
func (h *ConnectionHandler) GetConnection(c *gin.Context) {
	id := c.Param("id")

	connection, err := h.service.GetConnection(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusOK, enrichWithCapabilities(connection.SanitizeForAPI()))
}

// UpdateConnection handles connection updates
// @Summary Update a connection
// @Description Update an existing connection by ID
// @Tags connections
// @Accept json
// @Produce json
// @Param id path string true "Connection ID"
// @Param connection body models.UpdateConnectionRequest true "Connection updates"
// @Success 200 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /connections/{id} [put]
func (h *ConnectionHandler) UpdateConnection(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	connection, err := h.service.UpdateConnection(c.Request.Context(), id, &req)
	if err != nil {
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		respondError(c, err)
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusOK, enrichWithCapabilities(connection.SanitizeForAPI()))
}

// DeleteConnection handles connection deletion. Returns 409 with a
// usage payload when components or devices still reference the
// connection — the frontend renders that into a clear "cannot delete"
// dialog with the offender list.
// @Summary Delete a connection
// @Description Delete a connection by ID
// @Tags connections
// @Param id path string true "Connection ID"
// @Success 204
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 409 {object} map[string]interface{}
// @Router /connections/{id} [delete]
func (h *ConnectionHandler) DeleteConnection(c *gin.Context) {
	id := c.Param("id")

	usage, err := h.service.DeleteConnection(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if errors.Is(err, service.ErrConnectionInUse) {
			c.JSON(http.StatusConflict, gin.H{
				"error": err.Error(),
				"usage": usage,
			})
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.Status(http.StatusNoContent)
}

// TestConnection handles connection connection testing
// @Summary Test a connection connection
// @Description Test a connection connection without saving it
// @Tags connections
// @Accept json
// @Produce json
// @Param connection body models.TestConnectionRequest true "Connection configuration to test"
// @Success 200 {object} models.TestConnectionResponse
// @Failure 400 {object} map[string]interface{}
// @Router /connections/test [post]
func (h *ConnectionHandler) TestConnection(c *gin.Context) {
	var req models.TestConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	response, err := h.service.TestConnection(c.Request.Context(), &req)
	if err != nil {
		respondError(c, err)
		return
	}

	c.JSON(http.StatusOK, response)
}

// CheckConnectionHealth handles health check for a specific connection
// @Summary Check connection health
// @Description Check the health of a specific connection and update its status
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} models.HealthInfo
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/health [post]
func (h *ConnectionHandler) CheckConnectionHealth(c *gin.Context) {
	id := c.Param("id")

	health, err := h.service.CheckHealth(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, health)
}

// QueryConnection handles query execution for a connection
// @Summary Execute a query against a connection
// @Description Execute a query and return normalized results
// @Tags connections
// @Accept json
// @Produce json
// @Param id path string true "Connection ID"
// @Param query body models.QueryRequest true "Query to execute"
// @Success 200 {object} models.QueryResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/query [post]
func (h *ConnectionHandler) QueryConnection(c *gin.Context) {
	id := c.Param("id")

	var req models.QueryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Stamp the authenticated caller so the service can enforce
	// design/manage for raw queries against guarded (SQL/EdgeLake)
	// connections (#23). View users are refused with 403 here; they
	// run stored queries via /api/components/:id/data instead.
	ctx := service.WithQueryCaller(c.Request.Context(), middleware.GetUser(c))
	response, err := h.service.QueryConnection(ctx, id, &req)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if errors.Is(err, service.ErrQueryForbidden) {
			c.JSON(http.StatusForbidden, gin.H{"error": err.Error()})
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetConnectionSchema handles schema discovery for SQL connections
// @Summary Get database schema for a SQL connection
// @Description Retrieve tables and columns for SQL connections. Only SQL-type connections support this endpoint.
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} models.SchemaResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/schema [get]
func (h *ConnectionHandler) GetConnectionSchema(c *gin.Context) {
	id := c.Param("id")

	response, err := h.service.GetSchema(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetVariableValues lists the distinct values of a column on a connection, used
// to populate a dashboard-variable picker.
// @Summary List distinct column values for a dashboard-variable picker
// @Description Returns the distinct values of a column (SQL/EdgeLake via GROUP BY). Column + table from query params; limit optional.
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Param column query string true "Column whose distinct values to list"
// @Param table query string false "Source table (required for SQL/EdgeLake)"
// @Param limit query int false "Max distinct values (default 1000)"
// @Param capture_seconds query int false "Streaming capture window"
// @Success 200 {object} models.VariableValuesResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/variable-values [get]
func (h *ConnectionHandler) GetVariableValues(c *gin.Context) {
	id := c.Param("id")

	req := &models.VariableValuesRequest{
		Column:   c.Query("column"),
		Table:    c.Query("table"),
		Database: c.Query("database"),
		Field:    c.Query("field"),
	}
	if v := c.Query("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			req.Limit = n
		}
	}
	if v := c.Query("capture_seconds"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			req.CaptureSeconds = n
		}
	}

	response, err := h.service.GetVariableValues(c.Request.Context(), id, req)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// SaveDiscoveredValues persists a client-side-captured distinct-value list onto
// a connection (one column), for the dashboard-variable dropdown.
// @Summary Save discovered dashboard-variable values for a connection column
// @Description Stores a column's distinct values on the connection (streams/sockets have no engine-side DISTINCT, so values are captured client-side at authoring time). Design capability required.
// @Tags connections
// @Accept json
// @Produce json
// @Param id path string true "Connection ID"
// @Param request body models.SaveDiscoveredValuesRequest true "Column + values"
// @Success 200 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/discovered-values [put]
func (h *ConnectionHandler) SaveDiscoveredValues(c *gin.Context) {
	id := c.Param("id")

	var req models.SaveDiscoveredValuesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	conn, err := h.service.SaveDiscoveredValues(c.Request.Context(), id, req.Column, models.DiscoveredValueList{
		Values:  req.Values,
		Partial: req.Partial,
	})
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, conn)
}

// GetPrometheusLabelValues retrieves possible values for a Prometheus label
// @Summary Get values for a Prometheus label
// @Description Retrieve all possible values for a specific label from a Prometheus connection
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Param label path string true "Label name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/prometheus/labels/{label}/values [get]
func (h *ConnectionHandler) GetPrometheusLabelValues(c *gin.Context) {
	id := c.Param("id")
	label := c.Param("label")

	values, err := h.service.GetPrometheusLabelValues(c.Request.Context(), id, label)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"label":  label,
		"values": values,
	})
}

// GetEdgeLakeDatabases retrieves databases from an EdgeLake data source
// @Summary Get databases from an EdgeLake data source
// @Description Retrieve all database names from an EdgeLake node's blockchain registry
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/edgelake/databases [get]
func (h *ConnectionHandler) GetEdgeLakeDatabases(c *gin.Context) {
	id := c.Param("id")

	databases, err := h.service.GetEdgeLakeDatabases(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"databases": databases,
	})
}

// GetEdgeLakeTables retrieves tables for a database from an EdgeLake data source
// @Summary Get tables from an EdgeLake data source
// @Description Retrieve table names for a specific database from an EdgeLake node
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Param database query string true "Database name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/edgelake/tables [get]
func (h *ConnectionHandler) GetEdgeLakeTables(c *gin.Context) {
	id := c.Param("id")
	database := c.Query("database")

	if database == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "database query parameter is required"})
		return
	}

	tables, err := h.service.GetEdgeLakeTables(c.Request.Context(), id, database)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"database": database,
		"tables":   tables,
	})
}

// GetEdgeLakeSchema retrieves column schema for a table from an EdgeLake data source
// @Summary Get table schema from an EdgeLake data source
// @Description Retrieve column names and types for a specific table from an EdgeLake node
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Param database query string true "Database name"
// @Param table query string true "Table name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/edgelake/schema [get]
func (h *ConnectionHandler) GetEdgeLakeSchema(c *gin.Context) {
	id := c.Param("id")
	database := c.Query("database")
	table := c.Query("table")

	if database == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "database query parameter is required"})
		return
	}
	if table == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "table query parameter is required"})
		return
	}

	columns, err := h.service.GetEdgeLakeSchema(c.Request.Context(), id, database, table)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"database": database,
		"table":    table,
		"columns":  columns,
	})
}

// GetMQTTTopics discovers available topics from an MQTT broker
// @Summary Get topics from an MQTT broker
// @Description Subscribe briefly to discover available topics on an MQTT broker
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/mqtt/topics [get]
func (h *ConnectionHandler) GetMQTTTopics(c *gin.Context) {
	id := c.Param("id")

	topics, err := h.service.GetMQTTTopics(c.Request.Context(), id)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"topics": topics,
	})
}

// SampleMQTTTopic subscribes to a single MQTT topic and returns the message schema
// @Summary Sample a single MQTT topic
// @Description Subscribe to a topic and return the first message's schema (columns and sample values)
// @Tags connections
// @Produce json
// @Param id path string true "Connection ID"
// @Param topic query string true "MQTT topic to sample"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/mqtt/sample [get]
func (h *ConnectionHandler) SampleMQTTTopic(c *gin.Context) {
	id := c.Param("id")
	topic := c.Query("topic")
	if topic == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "topic query parameter is required"})
		return
	}

	result, err := h.service.SampleMQTTTopic(c.Request.Context(), id, topic)
	if err != nil {
		// #4: a namespace-grant miss is a 403, not a bad request.
		if respondIfNamespaceForbidden(c, err) {
			return
		}
		if err.Error() == "connection not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Connection not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}
