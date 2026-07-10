// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// newTestEdgeLakeAdapter builds an adapter pointed at a stub EdgeLake node
// and returns it together with a pointer to the destination header captured
// from the last request (nil string pointer semantics: "" = header absent).
func newTestEdgeLakeAdapter(t *testing.T, config map[string]interface{}) (*EdgeLakeAdapter, *string) {
	t.Helper()

	var lastDestination string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastDestination = r.Header.Get("destination")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"Query": [{"value": 1}]}`))
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse test server port: %v", err)
	}

	if config == nil {
		config = map[string]interface{}{}
	}
	config["host"] = u.Hostname()
	config["port"] = port

	adapter, err := newEdgeLakeAdapterFromConfig(config)
	if err != nil {
		t.Fatalf("newEdgeLakeAdapterFromConfig: %v", err)
	}
	return adapter, &lastDestination
}

// TestEdgeLakeQueryDestinationRouting verifies the routing contract for SQL
// queries (issue #28): distributed queries must carry `destination: network`,
// the connection-level flag defaults ON when absent, an explicit false is
// honored, and a per-query params.distributed overrides the connection flag.
func TestEdgeLakeQueryDestinationRouting(t *testing.T) {
	cases := []struct {
		name            string
		config          map[string]interface{}
		params          map[string]interface{}
		wantDestination string
	}{
		{
			name:            "flag absent defaults to network",
			config:          map[string]interface{}{},
			params:          map[string]interface{}{"database": "db"},
			wantDestination: "network",
		},
		{
			name:            "explicit true routes to network",
			config:          map[string]interface{}{"use_distributed_query": true},
			params:          map[string]interface{}{"database": "db"},
			wantDestination: "network",
		},
		{
			name:            "explicit false runs locally (no header)",
			config:          map[string]interface{}{"use_distributed_query": false},
			params:          map[string]interface{}{"database": "db"},
			wantDestination: "",
		},
		{
			name:            "params.distributed=true overrides connection false",
			config:          map[string]interface{}{"use_distributed_query": false},
			params:          map[string]interface{}{"database": "db", "distributed": true},
			wantDestination: "network",
		},
		{
			name:            "params.distributed=false overrides connection default",
			config:          map[string]interface{}{},
			params:          map[string]interface{}{"database": "db", "distributed": false},
			wantDestination: "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			adapter, gotDestination := newTestEdgeLakeAdapter(t, tc.config)

			_, err := adapter.Query(context.Background(), registry.Query{
				Raw:    "select value from sensors",
				Params: tc.params,
			})
			if err != nil {
				t.Fatalf("Query: %v", err)
			}
			if *gotDestination != tc.wantDestination {
				t.Errorf("destination header = %q, want %q", *gotDestination, tc.wantDestination)
			}
		})
	}
}

// TestEdgeLakeNon200SurfacesEnvelope verifies that a non-200 response whose
// body carries EdgeLake's JSON error envelope (with the header lines its
// BaseHTTP server leaks around it) is surfaced as the clean EdgeLake error,
// not a raw status dump.
func TestEdgeLakeNon200SurfacesEnvelope(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte("Server: BaseHTTP/0.6 Python/3.11.14\r\nContent-Type: text/json\r\n\r\n{\"method\": \"get\", \"node\": \"10.0.0.1\", \"err_code\": 5, \"err_text\": \"Wrong DBMS Name or DBMS not connected\", \"local_msg\": \"Logical DBMS 'jetson_data' not opened on Operator Node\"}"))
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse test server URL: %v", err)
	}
	port, _ := strconv.Atoi(u.Port())
	adapter, err := newEdgeLakeAdapterFromConfig(map[string]interface{}{
		"host": u.Hostname(),
		"port": port,
	})
	if err != nil {
		t.Fatalf("newEdgeLakeAdapterFromConfig: %v", err)
	}

	_, err = adapter.Query(context.Background(), registry.Query{
		Raw:    "select 1",
		Params: map[string]interface{}{"database": "jetson_data"},
	})
	if err == nil {
		t.Fatal("Query returned nil error for a 400 response")
	}
	msg := err.Error()
	if !strings.Contains(msg, "code 5") || !strings.Contains(msg, "not opened on Operator Node") {
		t.Errorf("expected clean EdgeLake envelope error, got: %q", msg)
	}
	if strings.Contains(msg, "BaseHTTP") {
		t.Errorf("raw header dump leaked into error message: %q", msg)
	}
}

// TestFormatEdgeLakeErrorCode155Hint makes sure the routing failure the
// user actually sees (code 155, "Failed to determine destination node")
// carries an actionable hint pointing at the distributed-queries toggle.
func TestFormatEdgeLakeErrorCode155Hint(t *testing.T) {
	body := []byte(`{"method":"get","node":"10.0.0.1","err_code":155,"err_text":"Failed to determine destination node","local_msg":"Failed to identify destination nodes for 'select' command - Using DBMS: jetson_data Table: machine_telemetry"}`)

	err := formatEdgeLakeError(body)
	if err == nil {
		t.Fatal("formatEdgeLakeError returned nil for a code-155 envelope")
	}
	msg := err.Error()
	if !strings.Contains(msg, "code 155") {
		t.Errorf("error message missing code: %q", msg)
	}
	if !strings.Contains(msg, "distributed queries") {
		t.Errorf("error message missing actionable hint: %q", msg)
	}
}
