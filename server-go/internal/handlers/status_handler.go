// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/database"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
	"github.com/trv-enterprises/trve-dashboard/internal/version"
)

// StatusHandler handles the WebSocket status endpoint
type StatusHandler struct {
	mongodb       *database.MongoDB
	streamManager *streaming.Manager
	startTime     time.Time
	// connNameLookup resolves a connection id → display name for the stream
	// summary. Returns a map of all known connections so a single call covers
	// every active stream per status build (no per-stream Mongo round-trip).
	// Optional — nil leaves stream names empty (ids still shown).
	//
	// Takes the CALLER's context (#4): the lookup reads connections, so it
	// must run under their namespace grants. Handing it a background
	// context would return every connection's name across every namespace
	// (the authz fail-open invariant treats unstamped as internal).
	connNameLookup func(ctx context.Context) map[string]string
}

// NewStatusHandler creates a new status handler
func NewStatusHandler(mongodb *database.MongoDB, streamManager *streaming.Manager) *StatusHandler {
	return &StatusHandler{
		mongodb:       mongodb,
		streamManager: streamManager,
		startTime:     time.Now(),
	}
}

// SetConnectionNameLookup wires a resolver that maps connection id → name,
// used to label streams in the status summary. Inject it from main where the
// connection repo/service is available so the handler stays decoupled.
func (h *StatusHandler) SetConnectionNameLookup(lookup func(ctx context.Context) map[string]string) {
	h.connNameLookup = lookup
}

// ServiceStatus represents the health status of a service
type ServiceStatus struct {
	Status    string `json:"status"`
	LatencyMs int64  `json:"latency_ms"`
	Error     string `json:"error,omitempty"`
}

// StatusPayload is the complete status message
type StatusPayload struct {
	Timestamp   time.Time                `json:"timestamp"`
	Server      ServerInfo               `json:"server"`
	Runtime     RuntimeInfo              `json:"runtime"`
	Services    map[string]ServiceStatus `json:"services"`
	Connections ConnectionSummary        `json:"connections"`
	Streams     StreamSummary            `json:"streams"`
}

// RuntimeInfo holds instantaneous Go-runtime gauges. These are pure
// current-state numbers (no peaks/accumulators) — a ts-store remote
// attached to the status feed captures the series and recovers any
// high-water marks downstream. NumGoroutine is the primary concurrency
// signal; the memory fields come from a single runtime.ReadMemStats.
type RuntimeInfo struct {
	Goroutines  int    `json:"goroutines"`
	MaxProcs    int    `json:"max_procs"`
	NumCPU      int    `json:"num_cpu"`
	HeapAllocB  uint64 `json:"heap_alloc_bytes"`
	TotalAllocB uint64 `json:"total_alloc_bytes"`
	SysB        uint64 `json:"sys_bytes"`
	NumGC       uint32 `json:"num_gc"`
}

// ServerInfo contains server metadata
type ServerInfo struct {
	Version    string  `json:"version"`
	Build      string  `json:"build"`
	GitCommit  string  `json:"git_commit"`
	UptimeSecs float64 `json:"uptime_secs"`
}

// ConnectionSummary aggregates connection info
type ConnectionSummary struct {
	TotalClients    int                             `json:"total_clients"`
	TotalWebsockets int                             `json:"total_websockets"`
	ByType          map[string]int                  `json:"by_type"`
	Connections     []registry.ClientConnectionInfo `json:"connections"`
}

// StreamSummary aggregates stream info
type StreamSummary struct {
	ActiveCount int                    `json:"active_count"`
	Streams     []StreamInfo           `json:"streams"`
	Aggregators map[string]interface{} `json:"aggregators"`
}

// StreamInfo represents a single stream's status
type StreamInfo struct {
	ConnectionID    string `json:"connection_id"`
	ConnectionName  string `json:"connection_name"` // resolved display name; empty if unknown
	Connected       bool   `json:"connected"`
	SubscriberCount int    `json:"subscriber_count"`
	BufferCount     int    `json:"buffer_count"`
}

// HandleStatusWebSocket provides a WebSocket endpoint for status monitoring
// @Summary Subscribe to server status via WebSocket
// @Description WebSocket endpoint that pushes server status at specified intervals
// @Tags system
// @Param interval query string false "Update interval (e.g., '5s', '1s'). Default: 5s, Min: 1s, 0 means one-shot"
// @Success 101 {string} string "Switching Protocols"
// @Router /ws/status [get]
func (h *StatusHandler) HandleStatusWebSocket(c *gin.Context) {
	// Parse interval parameter
	intervalStr := c.DefaultQuery("interval", "5s")

	var interval time.Duration
	var oneShot bool

	if intervalStr == "0" {
		oneShot = true
	} else {
		parsed, err := time.ParseDuration(intervalStr)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid interval format"})
			return
		}

		// Enforce minimum interval of 1 second
		if parsed < time.Second {
			parsed = time.Second
		}
		interval = parsed
	}

	// Upgrade to WebSocket
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool {
			return true
		},
	}

	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Printf("[StatusHandler] Failed to upgrade connection: %v\n", err)
		return
	}
	defer conn.Close()

	// The status loop below runs for the life of THIS handler, so the
	// request context stays valid — and it carries the caller's
	// namespace grants, which the connection-name lookup needs (#4).
	ctx := c.Request.Context()

	// Register this connection with the client registry
	clientRegistry := registry.GetClientRegistry()
	clientID := clientRegistry.Register(registry.ConnectionTypeStatusMonitor, map[string]interface{}{
		"interval": intervalStr,
		"one_shot": oneShot,
	})
	defer clientRegistry.Unregister(clientID)

	fmt.Printf("[StatusHandler] Status WebSocket connected (client: %d, interval: %s)\n", clientID, intervalStr)

	// Send initial status
	status := h.buildStatus(ctx)
	if err := h.sendStatus(conn, status); err != nil {
		fmt.Printf("[StatusHandler] Error sending initial status: %v\n", err)
		return
	}

	// If one-shot, close connection
	if oneShot {
		fmt.Printf("[StatusHandler] One-shot mode, closing connection\n")
		return
	}

	// Start ticker for periodic updates
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	// Monitor for client disconnect
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				return
			}
		}
	}()

	// Main loop
	for {
		select {
		case <-ticker.C:
			status := h.buildStatus(ctx)
			if err := h.sendStatus(conn, status); err != nil {
				fmt.Printf("[StatusHandler] Error sending status: %v\n", err)
				return
			}

		case <-done:
			fmt.Printf("[StatusHandler] Client %d disconnected\n", clientID)
			return
		}
	}
}

// GetStats returns a one-shot snapshot of current server state as JSON.
// Same payload as the WS status feed (reuses buildStatus) — pure
// instantaneous gauges, no peaks/accumulators. Scriptable/curl-friendly
// counterpart to the realtime WS feed.
// @Summary Get current server stats
// @Description One-shot snapshot of current-state server gauges: goroutine count, runtime memory, inbound connection counts by type, outbound stream summary, service health, and uptime.
// @Tags system
// @Produce json
// @Success 200 {object} StatusPayload
// @Router /stats [get]
func (h *StatusHandler) GetStats(c *gin.Context) {
	c.JSON(http.StatusOK, h.buildStatus(c.Request.Context()))
}

// GoroutineGroup is a count of goroutines sharing the same identifying frame.
type GoroutineGroup struct {
	Func  string `json:"func"`  // the identifying function (creator or current top user frame)
	Count int    `json:"count"` // how many goroutines map to it
}

// GetGoroutines returns an accounting of the live goroutines grouped by the
// function that created them (runtime.GoroutineProfile gives each record's
// creation + current stack). This answers "what are the N goroutines doing?"
// without a full pprof stack dump. Cost is a single GoroutineProfile call
// (a brief stop-the-world proportional to goroutine count) — fine on demand,
// NOT something to put on the 2s status tick.
// @Summary Get a goroutine accounting
// @Description Groups all live goroutines by their creating function with counts. On-demand diagnostic — not part of the status tick.
// @Tags system
// @Produce json
// @Success 200 {object} map[string]interface{}
// @Router /stats/goroutines [get]
func (h *StatusHandler) GetGoroutines(c *gin.Context) {
	// Size the buffer with headroom; GoroutineProfile returns ok=false if the
	// buffer was too small (goroutines spawned between sizing and reading), so
	// retry with the freshly-reported count until it fits.
	var records []runtime.StackRecord
	n, _ := runtime.GoroutineProfile(nil)
	for {
		records = make([]runtime.StackRecord, n+16)
		got, done := runtime.GoroutineProfile(records)
		if done {
			records = records[:got]
			break
		}
		n = got
	}

	byFunc := make(map[string]int)
	for i := range records {
		frames := runtime.CallersFrames(records[i].Stack())
		// Walk to the deepest user frame that isn't pure runtime plumbing —
		// that's the most informative label for "what is this goroutine".
		label := "unknown"
		for {
			frame, more := frames.Next()
			if frame.Function != "" && !strings.HasPrefix(frame.Function, "runtime.") {
				label = frame.Function
			}
			if !more {
				break
			}
		}
		byFunc[label]++
	}

	groups := make([]GoroutineGroup, 0, len(byFunc))
	for fn, count := range byFunc {
		groups = append(groups, GoroutineGroup{Func: fn, Count: count})
	}
	sort.Slice(groups, func(i, j int) bool {
		if groups[i].Count != groups[j].Count {
			return groups[i].Count > groups[j].Count
		}
		return groups[i].Func < groups[j].Func
	})

	c.JSON(http.StatusOK, gin.H{
		"total":  len(records),
		"groups": groups,
	})
}

// buildStatus creates a complete status payload
func (h *StatusHandler) buildStatus(ctx context.Context) *StatusPayload {
	now := time.Now()

	// Get version info
	versionInfo := version.Info()

	// Build server info
	serverInfo := ServerInfo{
		Version:    versionInfo["version"],
		Build:      versionInfo["build"],
		GitCommit:  versionInfo["git_commit"],
		UptimeSecs: now.Sub(h.startTime).Seconds(),
	}

	// Instantaneous runtime gauges. NumGoroutine is a cheap atomic read;
	// ReadMemStats is a single (sub-millisecond) pull. No peaks/accumulators —
	// current state only.
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)
	runtimeInfo := RuntimeInfo{
		Goroutines:  runtime.NumGoroutine(),
		MaxProcs:    runtime.GOMAXPROCS(0),
		NumCPU:      runtime.NumCPU(),
		HeapAllocB:  mem.HeapAlloc,
		TotalAllocB: mem.TotalAlloc,
		SysB:        mem.Sys,
		NumGC:       mem.NumGC,
	}

	// Check service health
	services := make(map[string]ServiceStatus)
	services["mongodb"] = h.checkMongoDB()

	// Get connection stats from client registry
	clientRegistry := registry.GetClientRegistry()
	connStats := clientRegistry.GetStats()
	allConnections := clientRegistry.GetAllConnections()

	connectionSummary := ConnectionSummary{
		TotalClients:    connStats.TotalClients,
		TotalWebsockets: connStats.TotalClients,
		ByType:          connStats.ByType,
		Connections:     allConnections,
	}

	// Get stream info from StreamManager
	streamSummary := h.buildStreamSummary(ctx)

	return &StatusPayload{
		Timestamp:   now,
		Server:      serverInfo,
		Runtime:     runtimeInfo,
		Services:    services,
		Connections: connectionSummary,
		Streams:     streamSummary,
	}
}

// checkMongoDB pings MongoDB and returns status with latency
func (h *StatusHandler) checkMongoDB() ServiceStatus {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	start := time.Now()
	err := h.mongodb.Client.Ping(ctx, nil)
	latency := time.Since(start)

	if err != nil {
		return ServiceStatus{
			Status:    "unhealthy",
			LatencyMs: latency.Milliseconds(),
			Error:     err.Error(),
		}
	}

	return ServiceStatus{
		Status:    "healthy",
		LatencyMs: latency.Milliseconds(),
	}
}

// buildStreamSummary gathers stream information
func (h *StatusHandler) buildStreamSummary(ctx context.Context) StreamSummary {
	streamIDs := h.streamManager.ListStreams()

	// Resolve id → name once for all streams in this build (nil-safe).
	var nameByID map[string]string
	if h.connNameLookup != nil {
		nameByID = h.connNameLookup(ctx)
	}

	streams := make([]StreamInfo, 0, len(streamIDs))
	for _, id := range streamIDs {
		status := h.streamManager.GetStreamStatus(id)
		if status != nil {
			streams = append(streams, StreamInfo{
				ConnectionID:    status.ConnectionID,
				ConnectionName:  nameByID[status.ConnectionID],
				Connected:       status.Connected,
				SubscriberCount: status.SubscriberCount,
				BufferCount:     status.BufferCount,
			})
		}
	}

	// Get aggregator stats
	aggRegistry := streaming.GetRegistry()
	aggStats := aggRegistry.Stats()

	return StreamSummary{
		ActiveCount: len(streams),
		Streams:     streams,
		Aggregators: aggStats,
	}
}

// sendStatus sends a status payload over WebSocket
func (h *StatusHandler) sendStatus(conn *websocket.Conn, status *StatusPayload) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	return conn.WriteMessage(websocket.TextMessage, data)
}
