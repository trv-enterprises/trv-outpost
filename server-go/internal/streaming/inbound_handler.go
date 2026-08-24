// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
	clientreg "github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// InboundHandler manages incoming WebSocket connections from external data
// sources (e.g., ts-store push).
//
// Maps are keyed by STREAM KEY (#248 PR 2): the bare connection id for a
// pinned tsstore connection (unchanged pre-#248 identity), or
// "<connID>/<hash>" for a per-component store channel. Keying by channel is
// what stops two stores' pushers from evicting each other's socket — the
// one-socket-per-key rule below is per CHANNEL, not per connection.
type InboundHandler struct {
	upgrader websocket.Upgrader
	// authorize verifies the URL-embedded secret against the stream key
	// it is dialling (#260). Nil means UNAUTHENTICATED — the pre-#260
	// behaviour — which is only reachable when the server was built
	// without wiring SetAuthorizer. main.go always wires it; the nil
	// case exists so unit tests can exercise the socket plumbing
	// without a database. Guarded explicitly at the accept path so a
	// missing wiring fails CLOSED rather than silently open.
	authorize   InboundAuthorizer
	connections map[string]*inboundConnection   // keyed by stream key
	listeners   map[string][]chan models.Record // listeners per stream key
	mu          sync.RWMutex
}

// inboundConnection represents an active inbound WebSocket connection
type inboundConnection struct {
	conn             *websocket.Conn
	streamKey        string
	stopChan         chan struct{}
	clientRegistryID uint64
}

// tsStorePushMessage represents a message from ts-store's outbound WebSocket push
type tsStorePushMessage struct {
	Type      string          `json:"type"`      // "data"
	Timestamp int64           `json:"timestamp"` // nanoseconds since Unix epoch
	Data      json.RawMessage `json:"data"`      // record payload
}

// Global singleton instance
var (
	inboundHandlerInstance *InboundHandler
	inboundHandlerOnce     sync.Once
)

// InboundSecretProvider mints (or returns the current) per-channel push
// secret for streamKey, persisting it so the accept path can verify it.
// connectionID is denormalised onto the record for revoke-by-connection.
//
// A package-level hook rather than a field on TSStoreStream: streams are
// constructed in several places and none of them has repository access,
// while the wiring is a single boot-time concern. Mirrors how the
// InboundHandler singleton takes its authorizer.
type InboundSecretProvider func(ctx context.Context, connectionID, streamKey string) (string, error)

var (
	inboundSecretProvider InboundSecretProvider
	inboundSecretMu       sync.RWMutex
	// inboundSecureCallback reports whether the advertised callback URL
	// should use wss://. Set at boot from deployment config (#260).
	inboundSecureCallback bool
)

// SetInboundSecretProvider wires secret minting. Called once at boot from
// main.go. Without it, push registration fails rather than advertising an
// unauthenticated callback.
func SetInboundSecretProvider(fn InboundSecretProvider) {
	inboundSecretMu.Lock()
	defer inboundSecretMu.Unlock()
	inboundSecretProvider = fn
}

// SetInboundCallbackSecure declares whether the dashboard is reached over
// TLS, which decides ws:// vs wss:// in the advertised callback (#260).
func SetInboundCallbackSecure(secure bool) {
	inboundSecretMu.Lock()
	defer inboundSecretMu.Unlock()
	inboundSecureCallback = secure
}

func getInboundSecretProvider() (InboundSecretProvider, bool) {
	inboundSecretMu.RLock()
	defer inboundSecretMu.RUnlock()
	return inboundSecretProvider, inboundSecureCallback
}

// InboundAuthorizer reports whether a URL-embedded secret authorises
// pushing to streamKey (#260). Implementations return false for any
// failure — unknown secret, wrong channel, lookup error — so the accept
// path cannot distinguish them and the response never reveals which
// channels exist.
type InboundAuthorizer func(ctx context.Context, streamKey, secret string) bool

// SetAuthorizer wires the secret check onto the singleton. Called once
// from main.go at boot, before any route is served. Without it the
// accept path refuses every connection (fail closed).
func (h *InboundHandler) SetAuthorizer(fn InboundAuthorizer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.authorize = fn
}

// GetInboundHandler returns the global inbound handler instance
func GetInboundHandler() *InboundHandler {
	inboundHandlerOnce.Do(func() {
		inboundHandlerInstance = &InboundHandler{
			upgrader: websocket.Upgrader{
				CheckOrigin: func(r *http.Request) bool {
					return true // Allow connections from ts-store
				},
			},
			connections: make(map[string]*inboundConnection),
			listeners:   make(map[string][]chan models.Record),
		}
	})
	return inboundHandlerInstance
}

// HandleInboundWebSocket handles incoming WebSocket connections from ts-store.
//
// Route: GET /api/streams/inbound/*path, where path is
//
//	<connID>/<secret>            pinned channel
//	<connID>/<hash>/<secret>     per-component store channel (#248)
//
// The leading segments ARE the stream key; the trailing one is the
// per-channel push secret (#260). This endpoint is deliberately outside the
// authenticated /api group — ts-store dials US, and its push API accepts
// only a URL, so the path is the sole place a credential can ride.
//
// Deliberately excluded from swagger: this is a machine-to-machine
// WebSocket endpoint (ts-store push producers dial in), not a REST API
// surface for interactive clients.
func (h *InboundHandler) HandleInboundWebSocket(c *gin.Context) {
	// The route is a single wildcard (see main.go): gin cannot hold two
	// different param names at the same position, and the two channel
	// shapes differ in length. Split it here — the LAST segment is the
	// secret, everything before it is the stream key:
	//
	//	<connID>/<secret>            pinned channel
	//	<connID>/<hash>/<secret>     per-component store channel (#248)
	//
	// A bare <connID> with no secret is a pre-#260 pusher. It is refused
	// like any other unauthenticated dial; the owning stream re-registers
	// with a secret-bearing URL on its next start.
	rest := strings.Trim(c.Param("path"), "/")
	parts := strings.Split(rest, "/")
	if rest == "" || len(parts) < 2 {
		log.Printf("[InboundHandler] refused inbound connection for %q from %s (no secret segment)", rest, c.Request.RemoteAddr)
		c.Status(http.StatusNotFound)
		return
	}
	secret := parts[len(parts)-1]
	streamKey := strings.Join(parts[:len(parts)-1], "/")

	// #260: verify the secret BEFORE the upgrade, so an unauthorised
	// dialer never gets a WebSocket and cannot evict the live socket for
	// this channel — the registration below closes any existing connection
	// for the key, so without this check that alone is a denial-of-service
	// primitive against a running stream.
	//
	// Every failure answers 404, matching the secret-gated webhook
	// receiver: a caller probing for channels learns nothing from the
	// response about which ones exist.
	h.mu.RLock()
	authorize := h.authorize
	h.mu.RUnlock()
	if authorize == nil {
		// Fail CLOSED. Reaching here means SetAuthorizer was never
		// wired, which is a deployment bug, not a reason to accept
		// anonymous pushes.
		log.Printf("[InboundHandler] refusing %s — no authorizer wired", streamKey)
		c.Status(http.StatusNotFound)
		return
	}
	if secret == "" || !authorize(c.Request.Context(), streamKey, secret) {
		log.Printf("[InboundHandler] refused inbound connection for %s from %s (bad or missing secret)", streamKey, c.Request.RemoteAddr)
		c.Status(http.StatusNotFound)
		return
	}

	conn, err := h.upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		log.Printf("[InboundHandler] Failed to upgrade connection for %s: %v", streamKey, err)
		return
	}

	log.Printf("[InboundHandler] Accepted inbound connection for channel %s from %s", streamKey, c.Request.RemoteAddr)

	// Register the connection
	h.mu.Lock()
	// Close existing connection if any — one socket per CHANNEL.
	if existing, exists := h.connections[streamKey]; exists {
		close(existing.stopChan)
		existing.conn.Close()
	}

	// Register with client registry
	clientRegistry := clientreg.GetClientRegistry()
	clientRegistryID := clientRegistry.Register(clientreg.ConnectionTypeInbound, map[string]interface{}{
		"connection_id": streamKey,
		"remote_addr":   c.Request.RemoteAddr,
	})

	ic := &inboundConnection{
		conn:             conn,
		streamKey:        streamKey,
		stopChan:         make(chan struct{}),
		clientRegistryID: clientRegistryID,
	}
	h.connections[streamKey] = ic
	h.mu.Unlock()

	// Start reading messages
	go h.readLoop(ic)
}

// readLoop reads messages from the inbound connection and broadcasts to listeners
func (h *InboundHandler) readLoop(ic *inboundConnection) {
	defer func() {
		h.mu.Lock()
		if current, exists := h.connections[ic.streamKey]; exists && current == ic {
			delete(h.connections, ic.streamKey)
		}
		h.mu.Unlock()

		// Unregister from client registry
		if ic.clientRegistryID > 0 {
			clientRegistry := clientreg.GetClientRegistry()
			clientRegistry.Unregister(ic.clientRegistryID)
		}

		ic.conn.Close()
		log.Printf("[InboundHandler] Connection closed for datasource %s", ic.streamKey)
	}()

	for {
		select {
		case <-ic.stopChan:
			return
		default:
			_, message, err := ic.conn.ReadMessage()
			if err != nil {
				if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					log.Printf("[InboundHandler] Read error for %s: %v", ic.streamKey, err)
				}
				return
			}

			// Parse the ts-store message
			var msg tsStorePushMessage
			if err := json.Unmarshal(message, &msg); err != nil {
				log.Printf("[InboundHandler] Failed to parse message for %s: %v", ic.streamKey, err)
				continue
			}

			if msg.Type != "data" {
				continue
			}

			// Convert to Record
			record := h.messageToRecord(&msg)

			// Broadcast to listeners
			h.broadcast(ic.streamKey, record)
		}
	}
}

// messageToRecord converts a ts-store push message to a Record.
//
// Timestamp scale: the whole system's wire convention is epoch SECONDS
// (every raw stream uses time.Now().Unix(); the ts-store REST adapter and the
// bucket aggregator both emit seconds). msg.Timestamp is nanoseconds, so we
// normalize with /1e9. CRITICAL: the push payload's `data` map often carries
// its OWN `timestamp` field, and for push-AGGREGATED streams (agg_window set)
// ts-store emits that inner timestamp in a DIFFERENT scale (milliseconds,
// ~1.78e12) — which previously overwrote our seconds value during the merge.
// A value-axis consumer (scatter) then saw a mix of seconds (backfill) and
// milliseconds (stream) and spread points across a bogus multi-year range.
// Stamp the server-normalized seconds timestamp AFTER the merge so it always
// wins — the single source of truth for the wire scale.
func (h *InboundHandler) messageToRecord(msg *tsStorePushMessage) models.Record {
	record := models.Record{}

	// Parse the data payload
	var data map[string]interface{}
	if err := json.Unmarshal(msg.Data, &data); err != nil {
		// If not a JSON object, store as raw value
		var rawValue interface{}
		if err := json.Unmarshal(msg.Data, &rawValue); err != nil {
			record["data"] = string(msg.Data)
		} else {
			record["data"] = rawValue
		}
	} else {
		// Merge data fields into record
		for k, v := range data {
			record[k] = v
		}
	}

	// Stamp the normalized timestamp LAST so a `timestamp` from the payload
	// (possibly a different scale) can't clobber the canonical seconds value.
	record["timestamp"] = float64(msg.Timestamp) / 1e9 // nanoseconds -> seconds

	return record
}

// broadcast sends a record to all listeners for a channel
func (h *InboundHandler) broadcast(streamKey string, record models.Record) {
	h.mu.RLock()
	listeners := h.listeners[streamKey]
	h.mu.RUnlock()

	for _, ch := range listeners {
		select {
		case ch <- record:
		default:
			// Channel full, skip (listener is slow)
		}
	}
}

// Subscribe adds a listener for a channel and returns a channel for receiving records
func (h *InboundHandler) Subscribe(streamKey string) chan models.Record {
	ch := make(chan models.Record, 100)

	h.mu.Lock()
	h.listeners[streamKey] = append(h.listeners[streamKey], ch)
	count := len(h.listeners[streamKey])
	h.mu.Unlock()

	log.Printf("[InboundHandler] Subscriber added for %s (total: %d)", streamKey, count)
	return ch
}

// Unsubscribe removes a listener
func (h *InboundHandler) Unsubscribe(streamKey string, ch chan models.Record) {
	h.mu.Lock()
	defer h.mu.Unlock()

	listeners := h.listeners[streamKey]
	for i, listener := range listeners {
		if listener == ch {
			// Remove from slice
			h.listeners[streamKey] = append(listeners[:i], listeners[i+1:]...)
			close(ch)
			log.Printf("[InboundHandler] Subscriber removed for %s (total: %d)", streamKey, len(h.listeners[streamKey]))
			return
		}
	}
}

// GetInboundURL returns the WebSocket URL that ts-store should connect to.
// The dashboardHost is the external address of the dashboard server.
// streamKey is the channel identity and becomes the URL path verbatim — one
// segment for a pinned channel (the bare connection id, unchanged pre-#248
// shape), two segments ("<connID>/<hash>") for a per-component store
// channel.
//
// secret is the per-channel credential (#260) and is appended as the FINAL
// path segment, because ts-store's push API takes only a URL — no header or
// body field we control reaches us on the frames it sends back.
//
// Scheme follows the deployment (#260): wss:// behind TLS, ws:// otherwise.
// Advertising a plaintext callback while shipping a credential in the path
// would put the credential on the wire in the clear, which is why the two
// halves of #260 had to land together.
//
// NOTE: this URL is no longer stable across secret rotation. ts-store
// persists the callback and stale-connection cleanup matches on it, so
// rotating a secret orphans the old push registration — cleanupStale-
// PushConnections handles that by matching the channel prefix rather than
// the full URL.
func GetInboundURL(dashboardHost string, streamKey string, secret string, secure bool) string {
	scheme := "ws://"
	if secure {
		scheme = "wss://"
	}
	return scheme + dashboardHost + "/api/streams/inbound/" + streamKey + "/" + secret
}

// inboundPathPrefix returns the callback path up to (but excluding) the
// secret segment. Stale-push cleanup matches on this so rotating a
// channel's secret still recognises — and removes — the registration made
// with the previous one.
func inboundPathPrefix(dashboardHost string, streamKey string) string {
	return dashboardHost + "/api/streams/inbound/" + streamKey + "/"
}
