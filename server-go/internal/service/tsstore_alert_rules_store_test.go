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

// TestStoresWithAccessVisibility: since ts-store v0.20.3 alert reads are
// read-classed — visibility comes from `read`, administration from `manage`.
// storesWithAccess must surface every granted store WITH its access classes
// so ListAll can show read-only rules as view-only rather than hiding them.
func TestStoresWithAccessVisibility(t *testing.T) {
	conn, _, _ := alertsTestServer(t)
	stores, err := storesWithAccess(context.Background(), conn)
	if err != nil {
		t.Fatal(err)
	}
	if len(stores) != 3 {
		t.Fatalf("stores = %d, want all 3 granted stores (read-only included)", len(stores))
	}
	byName := map[string]bool{}
	for _, st := range stores {
		byName[st.Name] = hasAccess(st, "manage")
	}
	if !byName["env-a"] || byName["env-b"] || !byName["env-c"] {
		t.Fatalf("manage flags = %v, want env-a/env-c manageable, env-b read-only", byName)
	}
	// env-b is read-visible: it must reach the alerts listing (view-only),
	// which is exactly what the old manage-only enumeration hid.
	found := false
	for _, st := range stores {
		if st.Name == "env-b" && hasAccess(st, "read") && !hasAccess(st, "manage") {
			found = true
		}
	}
	if !found {
		t.Fatal("env-b must be read-visible without manage")
	}
}

// TestDedupeAggregatedRules: the same alert reached through
// differently-spelled base URLs (IP vs hostname to one server) must
// collapse to one row — with connection refs unioned and a manage-capable
// duplicate promoting the primary — while genuinely distinct alerts (their
// ids are minted per server) never merge.
func TestDedupeAggregatedRules(t *testing.T) {
	rows := []TSStoreAggregatedRule{
		{ConnectionID: "c-ip", ConnectionName: "via-ip", StoreName: "system-stats", AlertID: "al-1", RuleName: "hot",
			Connections: []TSStoreConnectionRef{{ConnectionID: "c-ip", ConnectionName: "via-ip"}}, ConnectionCount: 1, CanManage: false},
		{ConnectionID: "c-host", ConnectionName: "via-host", StoreName: "system-stats", AlertID: "al-1", RuleName: "hot",
			Connections: []TSStoreConnectionRef{{ConnectionID: "c-host", ConnectionName: "via-host"}}, ConnectionCount: 1, CanManage: true},
		{ConnectionID: "c-other", StoreName: "system-stats", AlertID: "al-2", RuleName: "hot",
			Connections: []TSStoreConnectionRef{{ConnectionID: "c-other"}}, ConnectionCount: 1, CanManage: true},
	}
	out := dedupeAggregatedRules(rows)
	if len(out) != 2 {
		t.Fatalf("rows = %d, want 2 (aliased duplicate merged; distinct alert kept)", len(out))
	}
	merged := out[0]
	if merged.ConnectionCount != 2 || len(merged.Connections) != 2 {
		t.Fatalf("merged refs = %d, want the union of both connections", len(merged.Connections))
	}
	if !merged.CanManage || merged.ConnectionID != "c-host" {
		t.Fatalf("primary = %q canManage=%v — the manage-capable duplicate must promote its primary", merged.ConnectionID, merged.CanManage)
	}
}
