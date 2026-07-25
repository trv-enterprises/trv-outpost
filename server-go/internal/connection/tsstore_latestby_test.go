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

// TestSetLatestByParam covers the wire-level guard. ts-store 400s on a request
// carrying latest_by together with step/agg_window.
func TestSetLatestByParam(t *testing.T) {
	t.Run("sets latest_by", func(t *testing.T) {
		p := url.Values{}
		setLatestByParam(p, "container")
		if p.Get("latest_by") != "container" {
			t.Errorf("latest_by = %q, want container", p.Get("latest_by"))
		}
	})

	t.Run("empty field is a no-op", func(t *testing.T) {
		p := url.Values{}
		setLatestByParam(p, "  ")
		if _, present := p["latest_by"]; present {
			t.Error("blank field must not emit a latest_by param")
		}
	})

	t.Run("never combines with step", func(t *testing.T) {
		p := url.Values{}
		p.Set("step", "1m")
		setLatestByParam(p, "container")
		if p.Get("latest_by") != "" {
			t.Error("latest_by must not be set alongside step — ts-store would 400")
		}
	})

	t.Run("never combines with agg_window", func(t *testing.T) {
		p := url.Values{}
		p.Set("agg_window", "5m")
		setLatestByParam(p, "container")
		if p.Get("latest_by") != "" {
			t.Error("latest_by must not be set alongside agg_window — ts-store would 400")
		}
	})
}

func TestResolveLatestByParam(t *testing.T) {
	if got := resolveLatestByParam(map[string]interface{}{"latest_by": " container "}); got != "container" {
		t.Errorf("got %q, want trimmed \"container\"", got)
	}
	if got := resolveLatestByParam(map[string]interface{}{"latest_by": 42}); got != "" {
		t.Errorf("non-string latest_by → %q, want empty", got)
	}
	if got := resolveLatestByParam(map[string]interface{}{}); got != "" {
		t.Errorf("absent latest_by → %q, want empty", got)
	}
}

// latestByTestAdapter spins an httptest ts-store and returns an adapter wired
// to it plus a pointer that captures the last request URL received.
func latestByTestAdapter(t *testing.T) (*TSStoreAdapter, *url.URL) {
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
	return &TSStoreAdapter{
		config: &models.TSStoreConfig{
			Protocol:  "http",
			Host:      u.Hostname(),
			Port:      port,
			StoreName: "teststore",
		},
		httpClient: srv.Client(),
	}, &lastURL
}

// TestTSStoreQueryLatestByDispatch locks the dispatch semantics: latest_by
// always goes to /data/newest, suppresses step/group_by (ts-store rejects the
// combination), carries a relative window as `since`, ignores absolute
// ranges, and omits `limit` unless explicitly set (so ts-store's own
// 1000-group default applies rather than the newest default of 10).
func TestTSStoreQueryLatestByDispatch(t *testing.T) {
	run := func(t *testing.T, q registry.Query) url.Values {
		a, lastURL := latestByTestAdapter(t)
		if _, err := a.Query(context.Background(), q); err != nil {
			t.Fatal(err)
		}
		if lastURL.Path != "/api/stores/teststore/data/newest" {
			t.Fatalf("path = %q, want /data/newest", lastURL.Path)
		}
		return lastURL.Query()
	}

	t.Run("plain latest_by omits limit and step", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "newest", Params: map[string]interface{}{
			"latest_by": "container",
		}})
		if got.Get("latest_by") != "container" {
			t.Errorf("latest_by = %q, want container", got.Get("latest_by"))
		}
		if _, present := got["limit"]; present {
			t.Error("limit must be omitted so ts-store's 1000-group default applies")
		}
		if _, present := got["step"]; present {
			t.Error("step must not be emitted with latest_by")
		}
	})

	t.Run("explicit limit caps distinct groups", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "newest", Params: map[string]interface{}{
			"latest_by": "container",
			"limit":     float64(50),
		}})
		if got.Get("limit") != "50" {
			t.Errorf("limit = %q, want 50", got.Get("limit"))
		}
	})

	t.Run("relative range becomes since and its step is dropped", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "newest", Params: map[string]interface{}{
			"latest_by": "container",
			"range":     map[string]interface{}{"type": "relative", "token": "1h", "step": "1m"},
		}})
		if got.Get("since") != "1h" {
			t.Errorf("since = %q, want 1h", got.Get("since"))
		}
		if _, present := got["step"]; present {
			t.Error("range-picker step must be dropped under latest_by — ts-store would 400")
		}
		if got.Get("latest_by") != "container" {
			t.Errorf("latest_by = %q, want container", got.Get("latest_by"))
		}
	})

	t.Run("raw since DSL bounds the scan", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "since:2h", Params: map[string]interface{}{
			"latest_by": "container",
		}})
		if got.Get("since") != "2h" {
			t.Errorf("since = %q, want 2h", got.Get("since"))
		}
	})

	t.Run("group_by is suppressed", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "newest", Params: map[string]interface{}{
			"latest_by": "container",
			"group_by":  "container",
			"step":      "1m",
		}})
		if _, present := got["group_by"]; present {
			t.Error("group_by must not be emitted with latest_by")
		}
		if _, present := got["step"]; present {
			t.Error("flat step param must be dropped under latest_by")
		}
	})

	t.Run("absolute range still hits newest without time bounds", func(t *testing.T) {
		got := run(t, registry.Query{Raw: "newest", Params: map[string]interface{}{
			"latest_by": "container",
			"range": map[string]interface{}{
				"type": "absolute",
				"from": "2026-01-01T00:00:00Z",
				"to":   "2026-01-02T00:00:00Z",
			},
		}})
		if _, present := got["start_time"]; present {
			t.Error("latest_by must never route to /data/range params")
		}
		if _, present := got["since"]; present {
			t.Error("an absolute range cannot be expressed on /data/newest — must be ignored")
		}
	})
}
