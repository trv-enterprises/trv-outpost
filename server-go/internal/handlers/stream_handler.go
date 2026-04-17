// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
)

// StreamHandler handles SSE streaming for socket datasources
type StreamHandler struct {
	manager *streaming.Manager
}

// NewStreamHandler creates a new stream handler
func NewStreamHandler(manager *streaming.Manager) *StreamHandler {
	return &StreamHandler{
		manager: manager,
	}
}

// StreamDatasource streams data from a socket datasource via SSE
// @Summary Stream data from a socket datasource
// @Description Opens an SSE connection to stream real-time data from a socket datasource
// @Tags datasources
// @Produce text/event-stream
// @Param id path string true "Datasource ID"
// @Success 200 {string} string "SSE stream"
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /datasources/{id}/stream [get]
func (h *StreamHandler) StreamDatasource(c *gin.Context) {
	datasourceID := c.Param("id")
	if datasourceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "datasource ID is required"})
		return
	}

	// Check if this is a streaming datasource (socket or tsstore)
	isStreaming, err := h.manager.IsStreamingDatasource(c.Request.Context(), datasourceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !isStreaming {
		c.JSON(http.StatusBadRequest, gin.H{"error": "datasource does not support streaming (must be socket or tsstore type)"})
		return
	}

	// Parse optional topic filters for MQTT datasources
	// Accepts comma-separated MQTT topic patterns (e.g., "sensors/temp/#,home/+/status")
	topicFilters := streaming.ParseTopicFilters(c.Query("topics"))
	if len(topicFilters) > 0 {
		log.Printf("[StreamHandler] Topic filters for datasource %s: %v", datasourceID, topicFilters)
	}

	// Subscribe to the stream — for MQTT, this subscribes only to the requested topics
	// at the broker level and routes only matching records to this channel
	var recordCh chan models.Record
	if len(topicFilters) > 0 {
		recordCh = h.manager.SubscribeWithTopics(c.Request.Context(), datasourceID, topicFilters)
	} else {
		recordCh = h.manager.SubscribeAndGetChannel(c.Request.Context(), datasourceID)
	}
	if recordCh == nil {
		log.Printf("[StreamHandler] Subscribe error for %s", datasourceID)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to subscribe to stream"})
		return
	}

	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no") // Disable nginx buffering

	// Disable the server's global WriteTimeout (30s) for this response —
	// it's set on http.Server for safety against slow-body handlers, but
	// SSE is intentionally long-lived. Without this, the connection dies
	// after 30s and the browser repeatedly logs "can't establish a
	// connection" errors during the auto-reconnect loop.
	if rc := http.NewResponseController(c.Writer); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	log.Printf("[StreamHandler] SSE connection opened for datasource %s", datasourceID)

	// Flush a connected event immediately so the browser's EventSource
	// fires `onopen` right away. Without this, `onopen` doesn't fire
	// until the first record or heartbeat (up to 30s later for an idle
	// stream), which looks like a very long "Connecting → Connected" gap
	// in the frontend logs.
	fmt.Fprintf(c.Writer, "event: connected\ndata: {\"timestamp\":%d}\n\n", time.Now().Unix())
	c.Writer.Flush()

	// Send buffered records first (initial state) — already topic-filtered for MQTT
	bufferedRecords := h.manager.GetBufferFiltered(datasourceID, topicFilters)
	if len(bufferedRecords) > 0 {
		for _, record := range bufferedRecords {
			data, err := json.Marshal(record)
			if err != nil {
				continue
			}
			fmt.Fprintf(c.Writer, "event: record\ndata: %s\n\n", data)
		}
		log.Printf("[StreamHandler] Sent %d buffered records", len(bufferedRecords))
		c.Writer.Flush()
	}

	// Create ticker for heartbeat
	heartbeatTicker := time.NewTicker(30 * time.Second)
	defer heartbeatTicker.Stop()

	// Stream records to client — filtering already handled upstream for MQTT
	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			log.Printf("[StreamHandler] Client disconnected from datasource %s", datasourceID)
			h.manager.Unsubscribe(datasourceID, recordCh)
			return

		case record, ok := <-recordCh:
			if !ok {
				log.Printf("[StreamHandler] Stream channel closed for datasource %s", datasourceID)
				return
			}

			data, err := json.Marshal(record)
			if err != nil {
				log.Printf("[StreamHandler] Error marshaling record: %v", err)
				continue
			}

			fmt.Fprintf(c.Writer, "event: record\ndata: %s\n\n", data)
			c.Writer.Flush()

		case <-heartbeatTicker.C:
			fmt.Fprintf(c.Writer, "event: heartbeat\ndata: {\"timestamp\":%d}\n\n", time.Now().Unix())
			c.Writer.Flush()
		}
	}
}

// GetStreamStatus returns status information for a stream
// @Summary Get stream status
// @Description Get status information for an active stream
// @Tags datasources
// @Produce json
// @Param id path string true "Datasource ID"
// @Success 200 {object} streaming.StreamStatus
// @Failure 404 {object} map[string]interface{}
// @Router /datasources/{id}/stream/status [get]
func (h *StreamHandler) GetStreamStatus(c *gin.Context) {
	datasourceID := c.Param("id")
	if datasourceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "datasource ID is required"})
		return
	}

	status := h.manager.GetStreamStatus(datasourceID)
	if status == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "stream not found"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"datasource_id":    status.DatasourceID,
		"connected":        status.Connected,
		"subscriber_count": status.SubscriberCount,
		"buffer_count":     status.BufferCount,
		"last_error":       errorToString(status.LastError),
	})
}

// ListActiveStreams returns a list of all active streams
// @Summary List active streams
// @Description Get a list of all active streaming connections
// @Tags datasources
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Router /datasources/streams [get]
func (h *StreamHandler) ListActiveStreams(c *gin.Context) {
	streamIDs := h.manager.ListStreams()

	streams := make([]gin.H, 0, len(streamIDs))
	for _, id := range streamIDs {
		status := h.manager.GetStreamStatus(id)
		if status != nil {
			streams = append(streams, gin.H{
				"datasource_id":    status.DatasourceID,
				"connected":        status.Connected,
				"subscriber_count": status.SubscriberCount,
				"buffer_count":     status.BufferCount,
			})
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"streams": streams,
		"count":   len(streams),
	})
}

// StreamAggregatedRequest represents the request body for aggregated streaming
type StreamAggregatedRequest struct {
	Interval     int      `json:"interval" binding:"required"`      // Bucket interval in seconds
	Function     string   `json:"function" binding:"required"`      // avg, min, max, sum, count
	ValueCols    []string `json:"value_cols" binding:"required"`    // Columns to aggregate
	TimestampCol string   `json:"timestamp_col" binding:"required"` // Timestamp column
	SeriesCol    string   `json:"series_col"`                       // Column to partition by (e.g., "location") - optional
}

// StreamAggregatedDatasource streams time-bucketed aggregated data via SSE
// @Summary Stream aggregated data from a socket datasource
// @Description Opens an SSE connection to stream time-bucketed aggregated data
// @Tags datasources
// @Accept json
// @Produce text/event-stream
// @Param id path string true "Datasource ID"
// @Param config body StreamAggregatedRequest true "Aggregation configuration"
// @Success 200 {string} string "SSE stream"
// @Failure 400 {object} map[string]interface{}
// @Failure 404 {object} map[string]interface{}
// @Failure 500 {object} map[string]interface{}
// @Router /datasources/{id}/stream/aggregated [post]
func (h *StreamHandler) StreamAggregatedDatasource(c *gin.Context) {
	datasourceID := c.Param("id")
	if datasourceID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "datasource ID is required"})
		return
	}

	// Parse aggregation config from request body
	var req StreamAggregatedRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}

	// Validate function
	validFunctions := map[string]bool{"avg": true, "min": true, "max": true, "sum": true, "count": true}
	if !validFunctions[req.Function] {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid function, must be: avg, min, max, sum, or count"})
		return
	}

	// Check if this is a streaming datasource (socket or tsstore)
	isStreaming, err := h.manager.IsStreamingDatasource(c.Request.Context(), datasourceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if !isStreaming {
		c.JSON(http.StatusBadRequest, gin.H{"error": "datasource does not support streaming (must be socket or tsstore type)"})
		return
	}

	// Ensure the raw stream is active (subscribes to start it if needed)
	rawCh := h.manager.SubscribeAndGetChannel(c.Request.Context(), datasourceID)
	if rawCh == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to start stream"})
		return
	}
	// We don't need the raw channel, just need the stream active
	h.manager.Unsubscribe(datasourceID, rawCh)

	// Create bucket config
	bucketConfig := streaming.BucketConfig{
		DatasourceID: datasourceID,
		Interval:     req.Interval,
		Function:     req.Function,
		ValueCols:    req.ValueCols,
		TimestampCol: req.TimestampCol,
		SeriesCol:    req.SeriesCol,
	}

	// Subscribe to aggregated stream
	registry := streaming.GetRegistry()
	aggCh, configKey := registry.Subscribe(bucketConfig)

	log.Printf("[StreamHandler] SSE aggregated connection opened for datasource %s (config: %s)", datasourceID, configKey[:8])

	// Set SSE headers
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")

	// Disable the global WriteTimeout for SSE — see comment in the
	// non-aggregated StreamDatasource handler above for details.
	if rc := http.NewResponseController(c.Writer); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	// Send initial config acknowledgment
	configData, _ := json.Marshal(gin.H{
		"datasource_id": datasourceID,
		"config_key":    configKey[:8],
		"interval":      req.Interval,
		"function":      req.Function,
		"value_cols":    req.ValueCols,
		"timestamp_col": req.TimestampCol,
		"series_col":    req.SeriesCol,
	})
	fmt.Fprintf(c.Writer, "event: config\ndata: %s\n\n", configData)
	c.Writer.Flush()

	// Create ticker for heartbeat
	heartbeatTicker := time.NewTicker(30 * time.Second)
	defer heartbeatTicker.Stop()

	// Stream aggregated records to client
	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			log.Printf("[StreamHandler] Client disconnected from aggregated stream %s", configKey[:8])
			registry.Unsubscribe(configKey, aggCh)
			return

		case record, ok := <-aggCh:
			if !ok {
				log.Printf("[StreamHandler] Aggregated stream channel closed %s", configKey[:8])
				return
			}

			data, err := json.Marshal(record)
			if err != nil {
				log.Printf("[StreamHandler] Error marshaling aggregated record: %v", err)
				continue
			}

			fmt.Fprintf(c.Writer, "event: bucket\ndata: %s\n\n", data)
			c.Writer.Flush()

		case <-heartbeatTicker.C:
			fmt.Fprintf(c.Writer, "event: heartbeat\ndata: {\"timestamp\":%d}\n\n", time.Now().Unix())
			c.Writer.Flush()
		}
	}
}

// GetAggregatorStats returns statistics about active aggregators
// @Summary Get aggregator statistics
// @Description Get statistics about active bucket aggregators
// @Tags datasources
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Router /datasources/aggregators [get]
func (h *StreamHandler) GetAggregatorStats(c *gin.Context) {
	registry := streaming.GetRegistry()
	stats := registry.Stats()
	c.JSON(http.StatusOK, stats)
}

func errorToString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
