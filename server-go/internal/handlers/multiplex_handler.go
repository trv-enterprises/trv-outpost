// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/trv-enterprises/trve-dashboard/internal/middleware"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/service"
	"github.com/trv-enterprises/trve-dashboard/internal/streaming"
)

// MultiplexHandler carries every raw streaming subscription a single
// browser tab needs over ONE long-lived SSE connection, tagging each
// frame with the streamKey it belongs to. This exists to defeat the
// browser's 6-per-origin HTTP/1.1 connection cap (issue #187): the old
// StreamConnection path opens one SSE socket per distinct connection, so
// a dashboard spanning >5 connections exhausts the pool and every
// remaining request (tile queries, backfills) queues forever.
//
// Stage 1 (this file) multiplexes RAW connection streams only. The
// aggregated path (POST /stream/aggregated) is folded in as Stage 2.
//
// EventSource is GET-only and its URL can't change on a live connection,
// but a tab's set of active panels changes as they mount/unmount. So the
// pipe is opened with a GET and the subscription set is mutated with a
// companion one-shot POST (which pools/multiplexes fine and holds no
// slot). See UpdateMultiplexSubscriptions.
type MultiplexHandler struct {
	manager     *streaming.Manager
	connections *service.ConnectionService

	mu       sync.Mutex
	sessions map[string]*muxSession
}

// NewMultiplexHandler creates the multiplex SSE handler.
func NewMultiplexHandler(manager *streaming.Manager, connections *service.ConnectionService) *MultiplexHandler {
	return &MultiplexHandler{
		manager:     manager,
		connections: connections,
		sessions:    make(map[string]*muxSession),
	}
}

// muxFrame is one tagged message written onto the multiplex SSE stream.
// event mirrors the single-stream event names ("record", "connected",
// "subscribed") so the client dispatch logic stays familiar; data is the
// already-serialized JSON payload.
type muxFrame struct {
	event string
	data  string
}

// muxSubscription is one active subscription within a session — either a
// raw connection stream or an aggregated (time-bucketed) stream. For
// aggregated subs, aggConfigKey is set and unsubscribe goes through the
// AggregatorRegistry instead of the raw manager.
type muxSubscription struct {
	key    string
	connID string
	// managerKey is the upstream stream key returned by the manager —
	// the bare connection id, or "<connID>/<hash>" for a per-component
	// store channel (#248 PR 2). Unsubscribe must use it, not connID.
	managerKey   string
	topics       []string
	ch           chan models.Record
	cancel       context.CancelFunc
	aggConfigKey string // non-empty when this is an aggregated subscription
}

// muxSession holds the per-tab state: the fan-in channel every
// subscription pump writes into, and the set of active subscriptions.
// The SSE writer loop in StreamMultiplex is the sole reader of frames.
type muxSession struct {
	id     string
	userID string

	frames chan muxFrame

	mu   sync.Mutex
	subs map[string]*muxSubscription // streamKey -> subscription
	// ctx is the SSE request context; when it fires (client gone) the
	// session tears down every subscription. Add/remove deltas that
	// arrive after this is done are rejected.
	ctx  context.Context
	done bool
}

// checkAccess enforces the caller's namespace grants on a connection
// before a subscription is opened, mirroring StreamHandler.checkStreamAccess.
// Returns false after writing the response when access is denied.
func (h *MultiplexHandler) checkAccess(c *gin.Context, connectionID string) bool {
	if h.connections == nil {
		return true // partial wiring (tests) — no grants to enforce
	}
	if _, err := h.connections.GetConnection(c.Request.Context(), connectionID); err != nil {
		if strings.Contains(err.Error(), "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": "connection not found"})
			return false
		}
		respondError(c, err)
		return false
	}
	return true
}

// StreamMultiplex opens the single per-tab SSE pipe.
// @Summary Open a multiplexed SSE stream
// @Description Opens ONE long-lived Server-Sent-Events connection that carries tagged frames for every raw connection stream this browser tab subscribes to. Subscriptions are mutated via POST /streams/multiplex/{sid}/subs. Defeats the browser 6-per-origin HTTP/1.1 cap (issue #187). The first frame is `event: session` with the session id to use for subscription updates.
// @Tags streams
// @Produce text/event-stream
// @Success 200 {string} string "SSE stream"
// @Failure 401 {object} map[string]string
// @Router /streams/multiplex [get]
func (h *MultiplexHandler) StreamMultiplex(c *gin.Context) {
	user := middleware.GetUser(c)
	if user == nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Authentication required"})
		return
	}

	sid := uuid.NewString()
	sess := &muxSession{
		id:     sid,
		userID: user.ID,
		frames: make(chan muxFrame, 256),
		subs:   make(map[string]*muxSubscription),
		ctx:    c.Request.Context(),
	}

	h.mu.Lock()
	h.sessions[sid] = sess
	h.mu.Unlock()

	// SSE headers + long-lived write deadline disable, matching the
	// single-stream and events handlers.
	c.Header("Content-Type", "text/event-stream")
	c.Header("Cache-Control", "no-cache")
	c.Header("Connection", "keep-alive")
	c.Header("X-Accel-Buffering", "no")
	if rc := http.NewResponseController(c.Writer); rc != nil {
		_ = rc.SetWriteDeadline(time.Time{})
	}

	// Announce the session id first so the client knows where to POST
	// subscription deltas. Uses a dedicated event so it can't be
	// confused with a data record.
	fmt.Fprintf(c.Writer, "event: session\ndata: {\"sid\":%q}\n\n", sid)
	c.Writer.Flush()
	log.Printf("[Multiplex] SSE opened sid=%s user=%s", sid, user.ID)

	heartbeat := time.NewTicker(30 * time.Second)
	defer heartbeat.Stop()

	clientGone := c.Request.Context().Done()
	for {
		select {
		case <-clientGone:
			log.Printf("[Multiplex] SSE closed sid=%s", sid)
			h.teardownSession(sid)
			return

		case fr := <-sess.frames:
			fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", fr.event, fr.data)
			c.Writer.Flush()

		case <-heartbeat.C:
			fmt.Fprintf(c.Writer, "event: heartbeat\ndata: {\"timestamp\":%d}\n\n", time.Now().Unix())
			c.Writer.Flush()
		}
	}
}

// MultiplexSubsRequest is the add/remove delta body for a session's
// subscription set. keys in remove are streamKeys previously added.
type MultiplexSubsRequest struct {
	Add    []MultiplexAddSub `json:"add"`
	Remove []string          `json:"remove"`
}

// MultiplexAddSub describes one subscription to open. Key is the
// client-chosen streamKey the tagged frames will carry back (the client
// keys its fan-out on it); ConnectionID identifies the upstream. Topics
// is a comma-separated MQTT filter list (raw subs only, optional). Store
// selects the per-component store channel on an endpoint-scoped tsstore
// connection (#248 PR 2) — empty for every other subscription, and ignored
// (the pin wins) on a pinned connection. When Agg is set, this is an
// aggregated (time-bucketed) subscription and Topics is ignored.
type MultiplexAddSub struct {
	Key          string              `json:"key"`
	ConnectionID string              `json:"connection_id"`
	Topics       string              `json:"topics"`
	Store        string              `json:"store,omitempty"`
	Agg          *MultiplexAggConfig `json:"agg,omitempty"`
}

// MultiplexAggConfig is the time-bucket aggregation config for an
// aggregated multiplex subscription. Mirrors StreamAggregatedRequest —
// two charts with matching params share one server-side aggregator (and,
// now, ride the same multiplex pipe instead of a dedicated stream each).
type MultiplexAggConfig struct {
	Interval     int      `json:"interval"`
	Function     string   `json:"function"`
	ValueCols    []string `json:"value_cols"`
	TimestampCol string   `json:"timestamp_col"`
	SeriesCol    string   `json:"series_col"`
}

// UpdateMultiplexSubscriptions mutates a session's subscription set.
// @Summary Update multiplex subscriptions
// @Description Add or remove subscriptions on an open multiplex SSE session (opened via GET /streams/multiplex). Each add is a raw connection stream, or an aggregated (time-bucketed) stream when `agg` is set. Each added subscription is namespace-grant checked (issue #4). Raw subscriptions replay their buffered records as tagged frames; every add emits a `subscribed` frame. This is a one-shot request; it holds no connection-pool slot.
// @Tags streams
// @Accept json
// @Produce json
// @Param sid path string true "Session ID from the `session` frame"
// @Param body body MultiplexSubsRequest true "Add/remove deltas"
// @Success 200 {object} map[string]interface{}
// @Failure 400 {object} map[string]string
// @Failure 403 {object} map[string]string
// @Failure 404 {object} map[string]string
// @Router /streams/multiplex/{sid}/subs [post]
func (h *MultiplexHandler) UpdateMultiplexSubscriptions(c *gin.Context) {
	sid := c.Param("sid")

	h.mu.Lock()
	sess := h.sessions[sid]
	h.mu.Unlock()
	if sess == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "multiplex session not found (reopen the stream)"})
		return
	}

	var req MultiplexSubsRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}

	// Removes first, so a re-add of the same key in one delta reopens cleanly.
	for _, key := range req.Remove {
		h.removeSub(sess, key)
	}

	added := 0
	for _, add := range req.Add {
		if add.Key == "" || add.ConnectionID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "each add requires key and connection_id"})
			return
		}
		// Per-add namespace grant enforcement — this is the door, same
		// as the single-stream path. A denied connection aborts the
		// whole delta so the client sees a clear failure.
		if !h.checkAccess(c, add.ConnectionID) {
			return
		}
		if err := h.addSub(c.Request.Context(), sess, add); err != nil {
			respondStreamSubscribeError(c, add.ConnectionID, err)
			return
		}
		added++
	}

	c.JSON(http.StatusOK, gin.H{"sid": sid, "added": added, "removed": len(req.Remove)})
}

// addSub opens one raw-stream subscription and starts pumping its records
// into the session's frame channel as tagged frames. Idempotent per key:
// a duplicate add for an existing key is a no-op.
func (h *MultiplexHandler) addSub(reqCtx context.Context, sess *muxSession, add MultiplexAddSub) error {
	sess.mu.Lock()
	if sess.done {
		sess.mu.Unlock()
		return fmt.Errorf("session closed")
	}
	if _, exists := sess.subs[add.Key]; exists {
		sess.mu.Unlock()
		return nil // already subscribed to this key
	}
	sess.mu.Unlock()

	// Verify the connection actually streams before subscribing, so a
	// misconfigured connection fails the POST rather than silently
	// producing a dead subscription. Uses the request context (not the
	// SSE context) so a slow lookup doesn't outlive the POST.
	isStreaming, err := h.manager.IsStreamingConnection(reqCtx, add.ConnectionID)
	if err != nil {
		return err
	}
	if !isStreaming {
		return fmt.Errorf("connection does not support streaming (must be socket or tsstore type)")
	}

	if add.Agg != nil {
		return h.addAggSub(sess, add)
	}
	return h.addRawSub(sess, add)
}

// addRawSub opens a raw connection stream subscription and pumps its
// records into the session as tagged frames.
func (h *MultiplexHandler) addRawSub(sess *muxSession, add MultiplexAddSub) error {
	topics := streaming.ParseTopicFilters(add.Topics)

	var recordCh chan models.Record
	var subErr error
	managerKey := add.ConnectionID
	if len(topics) > 0 {
		// MQTT topic-aware path — store is not an MQTT concept.
		recordCh, subErr = h.manager.SubscribeWithTopics(sess.ctx, add.ConnectionID, topics)
	} else {
		recordCh, managerKey, subErr = h.manager.SubscribeAndGetChannelStore(sess.ctx, add.ConnectionID, add.Store)
	}
	if subErr != nil || recordCh == nil {
		if subErr == nil {
			subErr = fmt.Errorf("subscribe returned no channel")
		}
		return subErr
	}

	pumpCtx, cancel := context.WithCancel(sess.ctx)
	sub := &muxSubscription{
		key:        add.Key,
		connID:     add.ConnectionID,
		managerKey: managerKey,
		topics:     topics,
		ch:         recordCh,
		cancel:     cancel,
	}

	sess.mu.Lock()
	if sess.done {
		sess.mu.Unlock()
		cancel()
		h.manager.Unsubscribe(managerKey, recordCh)
		return fmt.Errorf("session closed")
	}
	sess.subs[add.Key] = sub
	sess.mu.Unlock()

	// Acknowledge the subscription so the client can fire its per-key
	// onConnect. Then replay the buffered records (initial state) as
	// tagged frames, exactly like the single-stream handler does inline.
	sess.emit(muxFrame{event: "subscribed", data: fmt.Sprintf("{\"key\":%q}", add.Key)})
	for _, record := range h.manager.GetBufferFiltered(managerKey, topics) {
		if data, err := marshalTaggedRecord(add.Key, record); err == nil {
			sess.emit(muxFrame{event: "record", data: data})
		}
	}

	// Pump goroutine: fan this subscription's records into the shared
	// frame channel until the sub is cancelled or its upstream closes.
	go h.pump(pumpCtx, sess, sub)
	log.Printf("[Multiplex] raw sub added sid=%s key=%s conn=%s topics=%v", sess.id, add.Key, add.ConnectionID, topics)
	return nil
}

// addAggSub opens a time-bucketed aggregated subscription via the
// AggregatorRegistry and pumps its bucket-records into the session as
// tagged `record` frames. Two subs with matching bucket params share one
// server-side aggregator; folding them onto the multiplex pipe also
// means they share one transport (the SSE-layer sharing follow-up in
// aggregation-sharing.md). Mirrors StreamAggregatedConnection.
func (h *MultiplexHandler) addAggSub(sess *muxSession, add MultiplexAddSub) error {
	agg := add.Agg
	validFunctions := map[string]bool{"avg": true, "min": true, "max": true, "sum": true, "count": true}
	if !validFunctions[agg.Function] {
		return fmt.Errorf("invalid function, must be: avg, min, max, sum, or count")
	}

	// Ensure the raw stream is active (subscribe to start it if needed),
	// then release the raw channel — the aggregator feeds off the same
	// upstream. Same pattern as StreamAggregatedConnection. The returned
	// manager key is the channel's FEED identity: streams feed the
	// aggregator registry under their stream key, so the BucketConfig must
	// carry the same key or records from a per-component store channel
	// would never reach this aggregator (#248 PR 2). For every non-store
	// subscription the key IS the connection id — unchanged behavior.
	rawCh, managerKey, subErr := h.manager.SubscribeAndGetChannelStore(sess.ctx, add.ConnectionID, add.Store)
	if subErr != nil || rawCh == nil {
		if subErr == nil {
			subErr = fmt.Errorf("subscribe returned no channel")
		}
		return subErr
	}
	h.manager.Unsubscribe(managerKey, rawCh)

	bucketConfig := streaming.BucketConfig{
		ConnectionID: managerKey,
		Interval:     agg.Interval,
		Function:     agg.Function,
		ValueCols:    agg.ValueCols,
		TimestampCol: agg.TimestampCol,
		SeriesCol:    agg.SeriesCol,
	}
	registry := streaming.GetRegistry()
	aggCh, configKey := registry.Subscribe(bucketConfig)

	pumpCtx, cancel := context.WithCancel(sess.ctx)
	sub := &muxSubscription{
		key:          add.Key,
		connID:       add.ConnectionID,
		managerKey:   managerKey,
		ch:           aggCh,
		cancel:       cancel,
		aggConfigKey: configKey,
	}

	sess.mu.Lock()
	if sess.done {
		sess.mu.Unlock()
		cancel()
		registry.Unsubscribe(configKey, aggCh)
		return fmt.Errorf("session closed")
	}
	sess.subs[add.Key] = sub
	sess.mu.Unlock()

	sess.emit(muxFrame{event: "subscribed", data: fmt.Sprintf("{\"key\":%q}", add.Key)})

	go h.pump(pumpCtx, sess, sub)
	log.Printf("[Multiplex] agg sub added sid=%s key=%s conn=%s config=%s", sess.id, add.Key, add.ConnectionID, configKey[:8])
	return nil
}

// pump forwards one subscription's upstream records to the session frame
// channel as tagged frames. Exits on cancel (removeSub / teardown) or
// when the upstream channel closes.
func (h *MultiplexHandler) pump(ctx context.Context, sess *muxSession, sub *muxSubscription) {
	for {
		select {
		case <-ctx.Done():
			return
		case record, ok := <-sub.ch:
			if !ok {
				return
			}
			if data, err := marshalTaggedRecord(sub.key, record); err == nil {
				sess.emit(muxFrame{event: "record", data: data})
			}
		}
	}
}

// removeSub cancels a subscription's pump, unsubscribes it from the
// upstream manager, and drops it from the session. No-op if unknown.
func (h *MultiplexHandler) removeSub(sess *muxSession, key string) {
	sess.mu.Lock()
	sub := sess.subs[key]
	if sub != nil {
		delete(sess.subs, key)
	}
	sess.mu.Unlock()
	if sub == nil {
		return
	}
	sub.cancel()
	h.unsubUpstream(sub)
	log.Printf("[Multiplex] sub removed sid=%s key=%s conn=%s", sess.id, key, sub.connID)
}

// unsubUpstream releases a subscription's upstream channel — the
// aggregator registry for aggregated subs, the raw manager otherwise.
func (h *MultiplexHandler) unsubUpstream(sub *muxSubscription) {
	if sub.aggConfigKey != "" {
		streaming.GetRegistry().Unsubscribe(sub.aggConfigKey, sub.ch)
		return
	}
	key := sub.managerKey
	if key == "" {
		key = sub.connID
	}
	h.manager.Unsubscribe(key, sub.ch)
}

// teardownSession removes the session and unsubscribes all of its
// subscriptions. Called when the SSE request context fires.
func (h *MultiplexHandler) teardownSession(sid string) {
	h.mu.Lock()
	sess := h.sessions[sid]
	delete(h.sessions, sid)
	h.mu.Unlock()
	if sess == nil {
		return
	}

	sess.mu.Lock()
	sess.done = true
	subs := make([]*muxSubscription, 0, len(sess.subs))
	for _, s := range sess.subs {
		subs = append(subs, s)
	}
	sess.subs = map[string]*muxSubscription{}
	sess.mu.Unlock()

	for _, s := range subs {
		s.cancel()
		h.unsubUpstream(s)
	}
}

// emit delivers a frame to the SSE writer loop without blocking the
// caller (a pump goroutine or the POST handler) if the writer is slow.
// A full buffer drops the frame rather than stalling every other
// subscription's pump — the client reconciles on the next record /
// heartbeat. Mirrors the non-blocking broadcast in streaming.Stream.
func (s *muxSession) emit(fr muxFrame) {
	select {
	case s.frames <- fr:
	case <-s.ctx.Done():
	default:
		// buffer full — drop rather than block the whole session
	}
}

// marshalTaggedRecord serializes a record wrapped with its streamKey, so
// the client can route it to the right per-key subscriber set.
func marshalTaggedRecord(key string, record models.Record) (string, error) {
	b, err := json.Marshal(gin.H{"key": key, "record": record})
	if err != nil {
		return "", err
	}
	return string(b), nil
}
