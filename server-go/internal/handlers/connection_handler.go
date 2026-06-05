// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
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

// ConnectionHandler handles datasource HTTP requests
type ConnectionHandler struct {
	service *service.ConnectionService
}

// NewConnectionHandler creates a new datasource handler
func NewConnectionHandler(service *service.ConnectionService) *ConnectionHandler {
	return &ConnectionHandler{
		service: service,
	}
}

// CreateConnection handles datasource creation
// @Summary Create a new datasource
// @Description Create a new data source (API, WebSocket, or File)
// @Tags datasources
// @Accept json
// @Produce json
// @Param datasource body models.CreateConnectionRequest true "Datasource to create"
// @Success 201 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /datasources [post]
func (h *ConnectionHandler) CreateConnection(c *gin.Context) {
	var req models.CreateConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	datasource, err := h.service.CreateConnection(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusCreated, enrichWithCapabilities(datasource.SanitizeForAPI()))
}

// ListConnections handles datasource listing
// @Summary List all datasources
// @Description Retrieve all datasources with pagination and optional namespace/type/tag filters
// @Tags datasources
// @Produce json
// @Param limit query int false "Number of items per page" default(20)
// @Param offset query int false "Number of items to skip" default(0)
// @Param namespace query string false "Filter by namespace (empty = all namespaces)"
// @Param type query string false "Filter by datasource type (api, websocket, file)"
// @Param tags query []string false "Filter by tags (OR semantics, repeat param)"
// @Success 200 {object} map[string]interface{}
// @Router /datasources [get]
func (h *ConnectionHandler) ListConnections(c *gin.Context) {
	limit, _ := strconv.ParseInt(c.DefaultQuery("limit", "20"), 10, 64)
	offset, _ := strconv.ParseInt(c.DefaultQuery("offset", "0"), 10, 64)
	namespace := c.Query("namespace")
	typeFilter := c.Query("type")
	tags := c.QueryArray("tags")

	datasources, total, err := h.service.ListConnectionsFiltered(c.Request.Context(), namespace, typeFilter, tags, limit, offset)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	enrichedConnections := make([]connectionResponse, len(datasources))
	for i, ds := range datasources {
		enrichedConnections[i] = enrichWithCapabilities(ds.SanitizeForAPI())
	}

	c.JSON(http.StatusOK, gin.H{
		"connections": enrichedConnections,
		"total":       total,
		"limit":       limit,
		"offset":      offset,
	})
}

// GetConnection handles retrieving a single datasource
// @Summary Get a datasource by ID
// @Description Retrieve a single datasource by its ID
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id} [get]
func (h *ConnectionHandler) GetConnection(c *gin.Context) {
	id := c.Param("id")

	datasource, err := h.service.GetConnection(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusOK, enrichWithCapabilities(datasource.SanitizeForAPI()))
}

// UpdateConnection handles datasource updates
// @Summary Update a datasource
// @Description Update an existing datasource by ID
// @Tags datasources
// @Accept json
// @Produce json
// @Param id path string true "Datasource ID"
// @Param datasource body models.UpdateConnectionRequest true "Datasource updates"
// @Success 200 {object} models.Connection
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /datasources/{id} [put]
func (h *ConnectionHandler) UpdateConnection(c *gin.Context) {
	id := c.Param("id")

	var req models.UpdateConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	datasource, err := h.service.UpdateConnection(c.Request.Context(), id, &req)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
			return
		}
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	// Sanitize sensitive fields and enrich with capabilities before returning
	c.JSON(http.StatusOK, enrichWithCapabilities(datasource.SanitizeForAPI()))
}

// DeleteConnection handles datasource deletion. Returns 409 with a
// usage payload when components or devices still reference the
// connection — the frontend renders that into a clear "cannot delete"
// dialog with the offender list.
// @Summary Delete a datasource
// @Description Delete a datasource by ID
// @Tags datasources
// @Param id path string true "Datasource ID"
// @Success 204
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 409 {object} map[string]interface{}
// @Router /datasources/{id} [delete]
func (h *ConnectionHandler) DeleteConnection(c *gin.Context) {
	id := c.Param("id")

	usage, err := h.service.DeleteConnection(c.Request.Context(), id)
	if err != nil {
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

// TestConnection handles datasource connection testing
// @Summary Test a datasource connection
// @Description Test a datasource connection without saving it
// @Tags datasources
// @Accept json
// @Produce json
// @Param datasource body models.TestConnectionRequest true "Datasource configuration to test"
// @Success 200 {object} models.TestConnectionResponse
// @Failure 400 {object} map[string]interface{}
// @Router /datasources/test [post]
func (h *ConnectionHandler) TestConnection(c *gin.Context) {
	var req models.TestConnectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	response, err := h.service.TestConnection(c.Request.Context(), &req)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// CheckConnectionHealth handles health check for a specific datasource
// @Summary Check datasource health
// @Description Check the health of a specific datasource and update its status
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} models.HealthInfo
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/health [post]
func (h *ConnectionHandler) CheckConnectionHealth(c *gin.Context) {
	id := c.Param("id")

	health, err := h.service.CheckHealth(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, health)
}

// QueryConnection handles query execution for a datasource
// @Summary Execute a query against a datasource
// @Description Execute a query and return normalized results
// @Tags datasources
// @Accept json
// @Produce json
// @Param id path string true "Datasource ID"
// @Param query body models.QueryRequest true "Query to execute"
// @Success 200 {object} models.QueryResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/query [post]
func (h *ConnectionHandler) QueryConnection(c *gin.Context) {
	id := c.Param("id")

	var req models.QueryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	response, err := h.service.QueryConnection(c.Request.Context(), id, &req)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, response)
}

// GetConnectionSchema handles schema discovery for SQL datasources
// @Summary Get database schema for a SQL datasource
// @Description Retrieve tables and columns for SQL datasources. Only SQL-type datasources support this endpoint.
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} models.SchemaResponse
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/schema [get]
func (h *ConnectionHandler) GetConnectionSchema(c *gin.Context) {
	id := c.Param("id")

	response, err := h.service.GetSchema(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Description Retrieve all possible values for a specific label from a Prometheus datasource
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Param label path string true "Label name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/prometheus/labels/{label}/values [get]
func (h *ConnectionHandler) GetPrometheusLabelValues(c *gin.Context) {
	id := c.Param("id")
	label := c.Param("label")

	values, err := h.service.GetPrometheusLabelValues(c.Request.Context(), id, label)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/edgelake/databases [get]
func (h *ConnectionHandler) GetEdgeLakeDatabases(c *gin.Context) {
	id := c.Param("id")

	databases, err := h.service.GetEdgeLakeDatabases(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Param database query string true "Database name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/edgelake/tables [get]
func (h *ConnectionHandler) GetEdgeLakeTables(c *gin.Context) {
	id := c.Param("id")
	database := c.Query("database")

	if database == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "database query parameter is required"})
		return
	}

	tables, err := h.service.GetEdgeLakeTables(c.Request.Context(), id, database)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Param database query string true "Database name"
// @Param table query string true "Table name"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/edgelake/schema [get]
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
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Router /connections/{id}/mqtt/topics [get]
func (h *ConnectionHandler) GetMQTTTopics(c *gin.Context) {
	id := c.Param("id")

	topics, err := h.service.GetMQTTTopics(c.Request.Context(), id)
	if err != nil {
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
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
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
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
		if err.Error() == "datasource not found" {
			c.JSON(http.StatusNotFound, gin.H{"error": "Datasource not found"})
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, result)
}
