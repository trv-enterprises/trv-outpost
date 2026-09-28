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

// TestSetAggregationParams covers the wire-level rules. ts-store 400s on a
// request carrying both step and agg_window, so exactly one window param may
// ever be emitted; the authored agg_window is a floor on the bucket size.
func TestSetAggregationParams(t *testing.T) {
	tests := []struct {
		name string
		agg  tsstoreAggregation
		want url.Values
	}{
		{"nothing set", tsstoreAggregation{}, url.Values{}},
		{"step only", tsstoreAggregation{Step: "1m"}, url.Values{"step": {"1m"}}},
		{"blank step is a no-op", tsstoreAggregation{Step: "  "}, url.Values{}},
		{"window only", tsstoreAggregation{Window: "5m"}, url.Values{"agg_window": {"5m"}}},

		// Floor: the coarser of the authored window and the step wins, always
		// sent as agg_window — never alongside step.
		{"window coarser than step", tsstoreAggregation{Step: "1m", Window: "5m"}, url.Values{"agg_window": {"5m"}}},
		{"step coarser than window", tsstoreAggregation{Step: "1h", Window: "5m"}, url.Values{"agg_window": {"1h"}}},
		{"equal", tsstoreAggregation{Step: "5m", Window: "5m"}, url.Values{"agg_window": {"5m"}}},
		{"day units compare", tsstoreAggregation{Step: "1d", Window: "6h"}, url.Values{"agg_window": {"1d"}}},
		{"clamped seconds step", tsstoreAggregation{Step: "519s", Window: "5m"}, url.Values{"agg_window": {"519s"}}},
		{"unparseable step keeps window", tsstoreAggregation{Step: "banana", Window: "5m"}, url.Values{"agg_window": {"5m"}}},
		{"unparseable window is forwarded for ts-store to reject", tsstoreAggregation{Step: "1m", Window: "banana"}, url.Values{"agg_window": {"banana"}}},

		// Functions compose with either window param.
		{"default with window", tsstoreAggregation{Window: "5m", Default: "max"},
			url.Values{"agg_window": {"5m"}, "agg_default": {"max"}}},
		{"default and fields with step", tsstoreAggregation{Step: "1m", Default: "max", Fields: "events:sum"},
			url.Values{"step": {"1m"}, "agg_default": {"max"}, "agg_fields": {"events:sum"}}},

		// Functions without a window are inert in ts-store — don't send them.
		{"functions without a window", tsstoreAggregation{Default: "max", Fields: "events:sum"}, url.Values{}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := url.Values{}
			setAggregationParams(got, tc.agg)
			if got.Encode() != tc.want.Encode() {
				t.Errorf("params = %q, want %q", got.Encode(), tc.want.Encode())
			}
			if got.Get("step") != "" && got.Get("agg_window") != "" {
				t.Error("step and agg_window emitted together — ts-store would 400")
			}
		})
	}
}

func TestResolveAggregationParams(t *testing.T) {
	got := resolveAggregationParams(map[string]interface{}{
		"agg_window":  " 5m ",
		"agg_default": "max",
		"agg_fields":  "events:sum",
		"step":        "1m", // never read here — each dispatch path supplies the step
	})
	want := tsstoreAggregation{Window: "5m", Default: "max", Fields: "events:sum"}
	if got != want {
		t.Errorf("got %+v, want %+v", got, want)
	}
	if got := resolveAggregationParams(map[string]interface{}{"agg_window": 5}); got != (tsstoreAggregation{}) {
		t.Errorf("non-string agg_window → %+v, want zero value", got)
	}
}

// aggregationTestServer spins an httptest ts-store and returns its address plus
// a pointer that captures the last request URL received.
func aggregationTestServer(t *testing.T) (*models.TSStoreConfig, *http.Client, *url.URL) {
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
	return &models.TSStoreConfig{
		Protocol:  "http",
		Host:      u.Hostname(),
		Port:      port,
		StoreName: "teststore",
	}, srv.Client(), &lastURL
}

// TestTSStoreQueryAggregationDispatch drives both ts-store query types (the
// registry adapter and the live TSStoreDataSource) end to end and checks the
// authored aggregation reaches the wire on every dispatch path except
// latest_by.
func TestTSStoreQueryAggregationDispatch(t *testing.T) {
	authored := map[string]interface{}{
		"agg_window":  "5m",
		"agg_default": "max",
		"agg_fields":  "events:sum",
	}
	with := func(extra map[string]interface{}) map[string]interface{} {
		p := map[string]interface{}{}
		for k, v := range authored {
			p[k] = v
		}
		for k, v := range extra {
			p[k] = v
		}
		return p
	}

	cases := []struct {
		name       string
		raw        string
		params     map[string]interface{}
		wantPath   string
		wantWindow string // expected agg_window; "" = none
		wantStep   string // expected step; "" = none
	}{
		{"raw since", "since:6h", with(nil), "/data/newest", "5m", ""},
		{"raw newest", "newest", with(nil), "/data/newest", "5m", ""},
		{"raw range", "range:1767225600:1767312000", with(nil), "/data/range", "5m", ""},
		{"flat step finer than window", "since:6h", with(map[string]interface{}{"step": "1m"}), "/data/newest", "5m", ""},
		{"picker step finer than window", "newest", with(map[string]interface{}{
			"range": map[string]interface{}{"type": "relative", "token": "1h", "step": "1m"},
		}), "/data/newest", "5m", ""},
		{"picker step coarser than window", "newest", with(map[string]interface{}{
			"range": map[string]interface{}{"type": "relative", "token": "7d", "step": "1h"},
		}), "/data/newest", "1h", ""},
		{"absolute picker range", "newest", with(map[string]interface{}{
			"range": map[string]interface{}{
				"type": "absolute", "from": "2026-01-01T00:00:00Z", "to": "2026-01-02T00:00:00Z", "step": "15m",
			},
		}), "/data/range", "15m", ""},
		{"functions with picker step, no authored window", "newest", map[string]interface{}{
			"agg_default": "max",
			"range":       map[string]interface{}{"type": "relative", "token": "1h", "step": "1m"},
		}, "/data/newest", "", "1m"},
	}

	check := func(t *testing.T, lastURL *url.URL, wantPath, wantWindow, wantStep string, wantFuncs bool) {
		t.Helper()
		if lastURL.Path != "/api/stores/teststore"+wantPath {
			t.Fatalf("path = %q, want %s", lastURL.Path, wantPath)
		}
		got := lastURL.Query()
		if got.Get("agg_window") != wantWindow {
			t.Errorf("agg_window = %q, want %q", got.Get("agg_window"), wantWindow)
		}
		if got.Get("step") != wantStep {
			t.Errorf("step = %q, want %q", got.Get("step"), wantStep)
		}
		if got.Get("agg_default") != "max" {
			t.Errorf("agg_default = %q, want max", got.Get("agg_default"))
		}
		if wantFuncs && got.Get("agg_fields") != "events:sum" {
			t.Errorf("agg_fields = %q, want events:sum", got.Get("agg_fields"))
		}
	}

	for _, tc := range cases {
		wantFuncs := tc.params["agg_fields"] != nil
		t.Run("adapter/"+tc.name, func(t *testing.T) {
			cfg, client, lastURL := aggregationTestServer(t)
			a := &TSStoreAdapter{config: cfg, httpClient: client}
			if _, err := a.Query(context.Background(), registry.Query{Raw: tc.raw, Params: tc.params}); err != nil {
				t.Fatal(err)
			}
			check(t, lastURL, tc.wantPath, tc.wantWindow, tc.wantStep, wantFuncs)
		})
		t.Run("datasource/"+tc.name, func(t *testing.T) {
			cfg, client, lastURL := aggregationTestServer(t)
			d := &TSStoreDataSource{config: cfg, httpClient: client}
			if _, err := d.Query(context.Background(), models.Query{Raw: tc.raw, Params: tc.params}); err != nil {
				t.Fatal(err)
			}
			check(t, lastURL, tc.wantPath, tc.wantWindow, tc.wantStep, wantFuncs)
		})
	}

	// latest_by is a now-lookup: ts-store rejects it alongside any window, so
	// the authored aggregation must be dropped entirely.
	t.Run("latest_by suppresses authored aggregation", func(t *testing.T) {
		cfg, client, lastURL := aggregationTestServer(t)
		d := &TSStoreDataSource{config: cfg, httpClient: client}
		if _, err := d.Query(context.Background(), models.Query{Raw: "newest", Params: with(map[string]interface{}{
			"latest_by": "container",
		})}); err != nil {
			t.Fatal(err)
		}
		got := lastURL.Query()
		for _, k := range []string{"agg_window", "agg_default", "agg_fields", "step"} {
			if _, present := got[k]; present {
				t.Errorf("%s must not be emitted with latest_by — ts-store would 400", k)
			}
		}
		if got.Get("latest_by") != "container" {
			t.Errorf("latest_by = %q, want container", got.Get("latest_by"))
		}
	})

	// group_by keys off the emitted window, so an authored agg_window alone
	// (no step) must still partition a pivoted chart per series.
	t.Run("authored window enables group_by", func(t *testing.T) {
		cfg, client, lastURL := aggregationTestServer(t)
		d := &TSStoreDataSource{config: cfg, httpClient: client}
		if _, err := d.Query(context.Background(), models.Query{Raw: "since:6h", Params: with(map[string]interface{}{
			"group_by": "container",
		})}); err != nil {
			t.Fatal(err)
		}
		if got := lastURL.Query().Get("group_by"); got != "container" {
			t.Errorf("group_by = %q, want container", got)
		}
	})
}
