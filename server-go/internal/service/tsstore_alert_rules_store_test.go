// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// alertsTestServer fakes the ts-store surface the alerts extension touches:
// the keyed store listing (with per-store access classes) and per-store
// alert list/detail. listCalls counts /api/stores hits (for cache tests);
// alertPaths records every alerts-path request for URL assertions.
func alertsTestServer(t *testing.T) (*models.Connection, *[]string, *atomic.Int64) {
	t.Helper()
	var alertPaths []string
	var listCalls atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/stores":
			listCalls.Add(1)
			_, _ = w.Write([]byte(`{"stores":[
				{"name":"env-a","role":"store","access":["read","write","manage"]},
				{"name":"env-b","role":"store","access":["read"]},
				{"name":"env-c","role":"store","access":["manage"]}]}`))
		case strings.HasSuffix(r.URL.Path, "/alerts"):
			alertPaths = append(alertPaths, r.URL.Path)
			_, _ = w.Write([]byte(`{"alerts":[{"id":"al-1","type":"webhook","target":"http://x","state":"ok"}]}`))
		case strings.Contains(r.URL.Path, "/alerts/"):
			alertPaths = append(alertPaths, r.URL.Path)
			_, _ = w.Write([]byte(`{"rule_name":"r1","webhook":{"name":"r1","condition":"temp > 30"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatal(err)
	}
	conn := &models.Connection{
		ID:   "conn-1",
		Name: "test-endpoint-scoped",
		Type: models.ConnectionTypeTSStore,
		Config: models.ConnectionConfig{TSStore: &models.TSStoreConfig{
			Protocol: "http",
			Host:     u.Hostname(),
			Port:     port,
			APIKey:   "tsstore_testkey",
		}},
	}
	return conn, &alertPaths, &listCalls
}

func TestResolveAlertStore(t *testing.T) {
	t.Run("pin wins over a caller store", func(t *testing.T) {
		got, err := resolveAlertStore(&models.TSStoreConfig{StoreName: "pinned"}, "other")
		if err != nil || got != "pinned" {
			t.Fatalf("got (%q, %v), want (pinned, nil)", got, err)
		}
	})
	t.Run("endpoint-scoped uses the caller store", func(t *testing.T) {
		got, err := resolveAlertStore(&models.TSStoreConfig{}, " env-a ")
		if err != nil || got != "env-a" {
			t.Fatalf("got (%q, %v), want (env-a, nil)", got, err)
		}
	})
	t.Run("endpoint-scoped with no store errors", func(t *testing.T) {
		if _, err := resolveAlertStore(&models.TSStoreConfig{}, ""); err == nil {
			t.Fatal("want error when neither pin nor store is supplied")
		}
	})
}

// TestManageableStoresFilter: alert CRUD is manage-classed, so only
// manage-granted stores may enter the fan-out — a read-only store leaking in
// would produce phantom 403 errors on the alerts page.
func TestManageableStoresFilter(t *testing.T) {
	conn, _, _ := alertsTestServer(t)
	stores, err := manageableStores(context.Background(), conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(stores) != 2 || stores[0] != "env-a" || stores[1] != "env-c" {
		t.Fatalf("stores = %v, want [env-a env-c] (manage-granted only)", stores)
	}
}

// TestFetchRulesStoreThreading: the fan-out fetch must hit the STORE it was
// asked for — and stamp that store on every emitted rule — never the
// connection's (absent) pin.
func TestFetchRulesStoreThreading(t *testing.T) {
	conn, alertPaths, _ := alertsTestServer(t)
	s := &TSStoreAlertRulesService{}
	rules, err := s.fetchRulesForConnection(context.Background(), conn, "env-c")
	if err != nil {
		t.Fatal(err)
	}
	if len(rules) != 1 {
		t.Fatalf("rules = %d, want 1", len(rules))
	}
	if rules[0].StoreName != "env-c" {
		t.Fatalf("rule StoreName = %q, want env-c", rules[0].StoreName)
	}
	for _, p := range *alertPaths {
		if !strings.HasPrefix(p, "/api/stores/env-c/") {
			t.Fatalf("request hit %q — every alerts call must be scoped to the requested store", p)
		}
	}
}

// TestManageableStoreSetCache: the webhook receiver consults this per
// delivery — it must be served from cache within the TTL, and membership
// must reflect manage grants only.
func TestManageableStoreSetCache(t *testing.T) {
	conn, _, listCalls := alertsTestServer(t)
	conn.ID = "cache-test-" + t.Name() // unique cache key per test run

	set, err := ManageableStoreSet(context.Background(), conn)
	if err != nil {
		t.Fatal(err)
	}
	if !set["env-a"] || !set["env-c"] || set["env-b"] {
		t.Fatalf("set = %v, want manage-granted env-a/env-c only", set)
	}
	if _, err := ManageableStoreSet(context.Background(), conn); err != nil {
		t.Fatal(err)
	}
	if n := listCalls.Load(); n != 1 {
		t.Fatalf("upstream store listings = %d, want 1 (second call served from cache)", n)
	}
}
