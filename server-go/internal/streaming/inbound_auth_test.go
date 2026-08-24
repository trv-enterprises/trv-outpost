// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package streaming

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// newTestRouter mounts the inbound route exactly as main.go does — one
// wildcard, because gin cannot hold two different param names at the same
// position (registering ":secret" and ":channel" there panics). Mounting it
// the real way is the point: it locks BOTH the route shape and the parsing.
func newTestRouter(h *InboundHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/api/streams/inbound/*path", h.HandleInboundWebSocket)
	return r
}

// newTestHandler builds a handler independent of the process-wide
// singleton, so tests can't leak an authorizer into each other.
func newTestHandler(auth InboundAuthorizer) *InboundHandler {
	h := &InboundHandler{
		connections: make(map[string]*inboundConnection),
		listeners:   make(map[string][]chan models.Record),
	}
	h.authorize = auth
	return h
}

// TestInboundAuth_RejectsUnauthorized covers the hole #260 closed: before
// it, ANY dialer that could reach the server and guess a channel could push
// frames into a stream. Every rejection must answer 404 — never 401/403 —
// so probing cannot enumerate channels.
func TestInboundAuth_RejectsUnauthorized(t *testing.T) {
	// Authorizer that only accepts one exact (channel, secret) pair.
	const goodKey = "conn-1/abcd1234"
	const goodSecret = "s3cr3t-value"
	auth := func(_ context.Context, streamKey, secret string) bool {
		return streamKey == goodKey && secret == goodSecret
	}

	tests := []struct {
		name string
		path string
	}{
		{"no secret segment (pre-#260 pinned URL)", "/api/streams/inbound/conn-1"},
		{"no secret segment (pre-#260 composite URL)", "/api/streams/inbound/conn-1/abcd1234"},
		{"empty path", "/api/streams/inbound/"},
		{"wrong secret", "/api/streams/inbound/conn-1/abcd1234/wrong-secret"},
		{"empty secret segment", "/api/streams/inbound/conn-1/abcd1234/"},
		// A secret valid for ANOTHER channel must not open this one:
		// one leaked credential must not become a master key.
		{"right secret, wrong channel", "/api/streams/inbound/conn-2/abcd1234/" + goodSecret},
		{"right secret, wrong hash", "/api/streams/inbound/conn-1/deadbeef/" + goodSecret},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := newTestRouter(newTestHandler(auth))
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("GET", tt.path, nil))
			if w.Code != 404 {
				t.Errorf("path %q: got %d, want 404 (every refusal must look identical)", tt.path, w.Code)
			}
		})
	}
}

// TestInboundAuth_FailsClosedWithoutAuthorizer asserts the posture when
// wiring is missing: refuse, don't fall back to the old anonymous accept.
// A deployment bug must not silently reopen the hole.
func TestInboundAuth_FailsClosedWithoutAuthorizer(t *testing.T) {
	r := newTestRouter(newTestHandler(nil))
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/streams/inbound/conn-1/abcd1234/any-secret", nil))
	if w.Code != 404 {
		t.Errorf("no authorizer wired: got %d, want 404 (must fail closed)", w.Code)
	}
}

// TestInboundAuth_SplitsStreamKeyAndSecret pins the parsing contract: the
// LAST segment is always the secret, everything before it is the stream
// key. Both channel shapes (#248) must resolve correctly, or a pinned
// connection's secret would be read as a channel hash.
func TestInboundAuth_SplitsStreamKeyAndSecret(t *testing.T) {
	tests := []struct {
		name       string
		path       string
		wantKey    string
		wantSecret string
	}{
		{"pinned channel", "/api/streams/inbound/conn-1/SECRET", "conn-1", "SECRET"},
		{"composite channel", "/api/streams/inbound/conn-1/abcd1234/SECRET", "conn-1/abcd1234", "SECRET"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var gotKey, gotSecret string
			auth := func(_ context.Context, streamKey, secret string) bool {
				gotKey, gotSecret = streamKey, secret
				return false // refuse — we only care what was parsed
			}
			r := newTestRouter(newTestHandler(auth))
			r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", tt.path, nil))
			if gotKey != tt.wantKey || gotSecret != tt.wantSecret {
				t.Errorf("parsed (key=%q secret=%q), want (key=%q secret=%q)",
					gotKey, gotSecret, tt.wantKey, tt.wantSecret)
			}
		})
	}
}

// TestGetInboundURL covers the second half of #260: the advertised callback
// must carry the secret AND follow the deployment's scheme. Advertising
// ws:// while embedding a credential would put that credential on the wire
// in the clear — which is why both halves had to ship together.
func TestGetInboundURL(t *testing.T) {
	tests := []struct {
		name      string
		host      string
		streamKey string
		secret    string
		secure    bool
		want      string
	}{
		{
			name: "plaintext deployment", host: "10.0.0.5:3001",
			streamKey: "conn-1", secret: "SEC", secure: false,
			want: "ws://10.0.0.5:3001/api/streams/inbound/conn-1/SEC",
		},
		{
			name: "TLS deployment uses wss", host: "dash.example.net",
			streamKey: "conn-1", secret: "SEC", secure: true,
			want: "wss://dash.example.net/api/streams/inbound/conn-1/SEC",
		},
		{
			name: "composite channel keeps both segments", host: "h:1",
			streamKey: "conn-1/abcd1234", secret: "SEC", secure: true,
			want: "wss://h:1/api/streams/inbound/conn-1/abcd1234/SEC",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := GetInboundURL(tt.host, tt.streamKey, tt.secret, tt.secure)
			if got != tt.want {
				t.Errorf("GetInboundURL() = %q, want %q", got, tt.want)
			}
			// The URL must round-trip through the route's own parsing.
			path := strings.SplitN(got, tt.host, 2)[1]
			rest := strings.TrimPrefix(path, "/api/streams/inbound/")
			parts := strings.Split(rest, "/")
			if parts[len(parts)-1] != tt.secret {
				t.Errorf("secret is not the last segment of %q", got)
			}
			if strings.Join(parts[:len(parts)-1], "/") != tt.streamKey {
				t.Errorf("stream key does not round-trip from %q", got)
			}
		})
	}
}
