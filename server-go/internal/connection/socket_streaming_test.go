// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

// Tests for the WebSocket and TCP socket adapters. Each test spins up a
// loopback server (httptest, net.Listen), sends a known payload, then
// asserts that the adapter's Stream() channel receives the expected Record.
//
// UDP support was removed (see daylog 2026-04-16) because real-world
// dashboard telemetry is overwhelmingly MQTT/WebSocket/REST, and the legacy
// UDP adapter's connected-socket model couldn't receive unsolicited
// packets in any case.
//
// "Binary" message_format was removed from the WebSocket adapter for the
// same reason — virtually all binary websocket payloads in this domain
// carry JSON in a binary frame, which the adapter handles transparently
// because it discards the frame type and tries json.Unmarshal on the bytes.
// True non-JSON binary protocols (MessagePack, protobuf) would need a
// dedicated typed adapter rather than a generic raw-bytes mode.

package connection

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// ============================================================================
// WebSocket
// ============================================================================

// newWSEchoServer spins up a WebSocket server that, on connect, sends
// `payload` as a single message of the given frame type, then waits for the
// client to close. Returns the ws:// URL and a cleanup func.
func newWSEchoServer(t *testing.T, frameType int, payload []byte) (string, func()) {
	t.Helper()
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Logf("upgrade failed: %v", err)
			return
		}
		defer conn.Close()
		if err := conn.WriteMessage(frameType, payload); err != nil {
			t.Logf("write failed: %v", err)
			return
		}
		// Hold the connection until the client disconnects so the adapter has
		// time to read the message before we close.
		_, _, _ = conn.ReadMessage()
	}))
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	return url, srv.Close
}

func TestWebSocketAdapter_TextJSON(t *testing.T) {
	payload, _ := json.Marshal(map[string]interface{}{"sensor": "temp", "value": 21.5})
	url, cleanup := newWSEchoServer(t, websocket.TextMessage, payload)
	defer cleanup()

	rec := readOneFromStream(t, mustNewWS(t, url), 2*time.Second)
	if rec["sensor"] != "temp" {
		t.Fatalf("expected sensor=temp, got %#v", rec["sensor"])
	}
	if v, ok := rec["value"].(float64); !ok || v != 21.5 {
		t.Fatalf("expected value=21.5 (float64), got %#v", rec["value"])
	}
}

// TestWebSocketAdapter_BinaryFrameJSON pins the de-facto behavior we
// promise to keep: when a publisher sends a binary websocket frame whose
// payload happens to be valid JSON, the adapter parses it as JSON. We do
// not advertise binary support, but this case is free and shows up in the
// wild often enough (publishers misclassifying frame type) that breaking
// it would be a regression.
func TestWebSocketAdapter_BinaryFrameJSON(t *testing.T) {
	payload, _ := json.Marshal(map[string]interface{}{"sensor": "humidity", "value": 47})
	url, cleanup := newWSEchoServer(t, websocket.BinaryMessage, payload)
	defer cleanup()

	rec := readOneFromStream(t, mustNewWS(t, url), 2*time.Second)
	if rec["sensor"] != "humidity" {
		t.Fatalf("expected sensor=humidity, got %#v", rec["sensor"])
	}
	if v, ok := rec["value"].(float64); !ok || v != 47 {
		t.Fatalf("expected value=47, got %#v", rec["value"])
	}
}

// ============================================================================
// TCP
// ============================================================================

// newTCPSenderServer accepts one connection, writes `payload`, then closes.
// Returns the host:port address and a cleanup func.
func newTCPSenderServer(t *testing.T, payload []byte) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		conn, err := listener.Accept()
		if err != nil {
			return // listener closed
		}
		defer conn.Close()
		_, _ = conn.Write(payload)
		// Hold briefly so the client has time to read.
		time.Sleep(200 * time.Millisecond)
	}()
	return listener.Addr().String(), func() {
		listener.Close()
		wg.Wait()
	}
}

func TestTCPAdapter_JSONFormat(t *testing.T) {
	payload, _ := json.Marshal(map[string]interface{}{"sensor": "tcp_test", "value": 99.5})
	addr, cleanup := newTCPSenderServer(t, payload)
	defer cleanup()

	a, err := newTCPAdapterFromConfig(map[string]interface{}{
		"url":                addr,
		"reconnect_on_error": false,
		"buffer_size":        10,
		"message_format":     "json",
	})
	if err != nil {
		t.Fatalf("adapter ctor: %v", err)
	}
	rec := readOneFromStream(t, a, 2*time.Second)
	if rec["sensor"] != "tcp_test" {
		t.Fatalf("expected sensor=tcp_test, got %#v", rec["sensor"])
	}
	if v, ok := rec["value"].(float64); !ok || v != 99.5 {
		t.Fatalf("expected value=99.5, got %#v", rec["value"])
	}
}

func TestTCPAdapter_TextFormat(t *testing.T) {
	addr, cleanup := newTCPSenderServer(t, []byte("hello tcp"))
	defer cleanup()

	a, err := newTCPAdapterFromConfig(map[string]interface{}{
		"url":                addr,
		"reconnect_on_error": false,
		"message_format":     "text",
	})
	if err != nil {
		t.Fatalf("adapter ctor: %v", err)
	}
	rec := readOneFromStream(t, a, 2*time.Second)
	if rec["data"] != "hello tcp" {
		t.Fatalf("expected data='hello tcp', got %#v", rec["data"])
	}
}

// TestTCPAdapter_ParserDataPathAndScale exercises the connection-level JSON
// parser: data_path re-roots the record at "payload.readings", the
// timestamp_field is lifted from the original envelope, and timestamp_scale
// "ns" converts a 19-digit nanosecond timestamp into Unix seconds.
func TestTCPAdapter_ParserDataPathAndScale(t *testing.T) {
	envelope := map[string]interface{}{
		"type": "telemetry",
		"ts":   1707012345678901234, // 19-digit nanoseconds = 2024-02-04T03:25:45Z
		"payload": map[string]interface{}{
			"readings": map[string]interface{}{
				"temperature": 21.5,
				"humidity":    47,
			},
		},
	}
	body, _ := json.Marshal(envelope)
	addr, cleanup := newTCPSenderServer(t, body)
	defer cleanup()

	a, err := newTCPAdapterFromConfig(map[string]interface{}{
		"url":                addr,
		"reconnect_on_error": false,
		"message_format":     "json",
		"data_path":          "payload.readings",
		"timestamp_field":    "ts",
		"timestamp_scale":    "ns",
	})
	if err != nil {
		t.Fatalf("adapter ctor: %v", err)
	}

	rec := readOneFromStream(t, a, 2*time.Second)
	if v, ok := rec["temperature"].(float64); !ok || v != 21.5 {
		t.Fatalf("expected temperature=21.5, got %#v", rec["temperature"])
	}
	if v, ok := rec["humidity"].(float64); !ok || v != 47 {
		t.Fatalf("expected humidity=47, got %#v", rec["humidity"])
	}
	// Original envelope keys ("type", "payload", "ts") must NOT leak into the
	// re-rooted record — the data_path should have replaced them entirely.
	if _, leaked := rec["type"]; leaked {
		t.Fatalf("envelope key 'type' leaked into parsed record: %#v", rec)
	}
	// Timestamp must be present and within a sane Unix-seconds range
	// (1.7e9 is roughly 2024). Anything in the billions = nanoseconds didn't
	// get scaled correctly.
	ts, ok := rec["timestamp"].(int64)
	if !ok {
		t.Fatalf("expected timestamp as int64 (Unix seconds), got %T (%#v)", rec["timestamp"], rec["timestamp"])
	}
	if ts < 1_500_000_000 || ts > 2_000_000_000 {
		t.Fatalf("expected Unix-seconds timestamp ~1.7e9, got %d", ts)
	}
}

// ============================================================================
// helpers
// ============================================================================

// streamReader is the minimal subset of registry.Adapter we exercise.
type streamReader interface {
	Connect(ctx context.Context) error
	Stream(ctx context.Context, query registry.Query) (<-chan registry.Record, error)
	Close() error
}

// readOneFromStream connects the given adapter, opens a stream, returns the
// first record, then closes the adapter. Fails the test if no record arrives
// within the timeout.
func readOneFromStream(t *testing.T, a streamReader, timeout time.Duration) registry.Record {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout+1*time.Second)
	defer cancel()
	if err := a.Connect(ctx); err != nil {
		t.Fatalf("connect: %v", err)
	}
	defer a.Close()
	ch, err := a.Stream(ctx, registry.Query{})
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	select {
	case rec, ok := <-ch:
		if !ok {
			t.Fatalf("stream closed without a record")
		}
		return rec
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for a record")
	}
	return nil
}

func mustNewWS(t *testing.T, url string) streamReader {
	t.Helper()
	a, err := newWebSocketAdapterFromConfig(map[string]interface{}{
		"url":                url,
		"reconnect_on_error": false,
		"buffer_size":        10,
	})
	if err != nil {
		t.Fatalf("ws adapter ctor: %v", err)
	}
	return a
}
