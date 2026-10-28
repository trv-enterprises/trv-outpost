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
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

func TestNativeParams(t *testing.T) {
	got := nativeParams(map[string]interface{}{
		"agg_window":  " 5m ",
		"agg_default": "",         // blank → omitted
		"window":      "0",        // unbounded — a real value, not blank
		"scan_limit":  float64(0), // JSON number 0 = unbounded; must be kept
		"filter":      "ignored",  // not a native pass-through key
	}, tsstoreAggParamKeys, tsstoreScanParamKeys)

	want := url.Values{"agg_window": {"5m"}, "window": {"0"}, "scan_limit": {"0"}}
	if got.Encode() != want.Encode() {
		t.Errorf("got %q, want %q", got.Encode(), want.Encode())
	}
	if got := nativeParams(map[string]interface{}{"scan_limit": float64(20000)}, tsstoreScanParamKeys); got.Get("scan_limit") != "20000" {
		t.Errorf("scan_limit = %q, want 20000 (no exponent formatting)", got.Get("scan_limit"))
	}
}

// nativeParamsServer spins an httptest ts-store and returns its config plus a
// pointer capturing the last request URL.
func nativeParamsServer(t *testing.T) (*models.TSStoreConfig, *http.Client, *url.URL) {
	t.Helper()
	var lastURL url.URL
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		lastURL = *r.URL
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"objects":[],"count":0}`))
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
	return &models.TSStoreConfig{Protocol: "http", Host: u.Hostname(), Port: port, StoreName: "teststore"}, srv.Client(), &lastURL
}

// TestTSStoreNativeParamsDispatch drives both ts-store query types and checks
// each authored native param reaches the endpoints that accept it — and only
// those (aggregation never with latest_by or on /oldest).
func TestTSStoreNativeParamsDispatch(t *testing.T) {
	all := func(extra map[string]interface{}) map[string]interface{} {
		p := map[string]interface{}{
			"agg_window":  "5m",
			"agg_default": "max",
			"agg_fields":  "events:sum",
			"window":      "6h",
			"scan_limit":  float64(20000),
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}

	cases := []struct {
		name    string
		raw     string
		params  map[string]interface{}
		path    string
		present []string
		absent  []string
	}{
		{"newest carries everything", "newest", all(nil), "/data/newest",
			[]string{"agg_window", "agg_default", "agg_fields", "window", "scan_limit"}, nil},
		{"since carries aggregation", "since:6h", all(nil), "/data/newest",
			[]string{"agg_window", "agg_default", "agg_fields"}, nil},
		{"raw range carries aggregation, not scan bounds", "range:1767225600:1767312000", all(nil), "/data/range",
			[]string{"agg_window", "agg_default", "agg_fields"}, []string{"window", "scan_limit"}},
		{"authored agg_window wins over the picker step", "newest", all(map[string]interface{}{
			"range": map[string]interface{}{"type": "relative", "token": "1h", "step": "1m"},
		}), "/data/newest", []string{"agg_window", "agg_default"}, []string{"step"}},
		{"functions compose with the picker step", "newest", map[string]interface{}{
			"agg_default": "max",
			"range":       map[string]interface{}{"type": "relative", "token": "1h", "step": "1m"},
		}, "/data/newest", []string{"step", "agg_default"}, []string{"agg_window"}},
		{"absolute picker range carries aggregation", "newest", all(map[string]interface{}{
			"range": map[string]interface{}{"type": "absolute", "from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z"},
		}), "/data/range", []string{"agg_window"}, []string{"window", "scan_limit"}},
		{"latest_by carries scan bounds, never aggregation", "newest", all(map[string]interface{}{"latest_by": "container"}),
			"/data/newest", []string{"latest_by", "window", "scan_limit"}, []string{"agg_window", "agg_default", "agg_fields", "step"}},
		{"oldest carries scan_limit, never aggregation", "oldest", all(nil), "/data/oldest",
			[]string{"scan_limit"}, []string{"agg_window", "agg_default", "agg_fields"}},
	}

	check := func(t *testing.T, lastURL *url.URL, path string, present, absent []string) {
		t.Helper()
		if lastURL.Path != "/api/stores/teststore"+path {
			t.Fatalf("path = %q, want %s", lastURL.Path, path)
		}
		got := lastURL.Query()
		for _, k := range present {
			if got.Get(k) == "" {
				t.Errorf("%s missing from %q", k, lastURL.RawQuery)
			}
		}
		for _, k := range absent {
			if _, ok := got[k]; ok {
				t.Errorf("%s must not be sent (%q)", k, lastURL.RawQuery)
			}
		}
		if got.Get("step") != "" && got.Get("agg_window") != "" {
			t.Error("step and agg_window together — ts-store would 400")
		}
	}

	for _, tc := range cases {
		t.Run("adapter/"+tc.name, func(t *testing.T) {
			cfg, client, lastURL := nativeParamsServer(t)
			a := &TSStoreAdapter{config: cfg, httpClient: client}
			if _, err := a.Query(context.Background(), registry.Query{Raw: tc.raw, Params: tc.params}); err != nil {
				t.Fatal(err)
			}
			check(t, lastURL, tc.path, tc.present, tc.absent)
		})
		t.Run("datasource/"+tc.name, func(t *testing.T) {
			cfg, client, lastURL := nativeParamsServer(t)
			d := &TSStoreDataSource{config: cfg, httpClient: client}
			if _, err := d.Query(context.Background(), models.Query{Raw: tc.raw, Params: tc.params}); err != nil {
				t.Fatal(err)
			}
			check(t, lastURL, tc.path, tc.present, tc.absent)
		})
	}
}
