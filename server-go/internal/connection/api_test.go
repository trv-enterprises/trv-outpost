// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
	"github.com/trv-enterprises/trve-dashboard/internal/registry"
)

// TestAPIBuildRequestURL covers how query.Raw combines with the connection's
// base URL: a bare query string (?k=v) appends to the base preserving its path;
// a leading-slash path replaces the path; an absolute URL is allowed only on
// the SAME host; anything else is a path segment. The bare-query-string case is
// the regression that 404'd ("?limit=1000" was treated as a path segment →
// base + "/?limit=1000").
//
// NOTE: this test previously asserted `{"absolute url overrides",
// "http://host:21082/data", "http://elsewhere/x", "http://elsewhere/x"}` —
// i.e. it codified #287 as intended behaviour. A cross-host override let a
// caller aim the connection's stored credentials at any host they chose.
// The case is inverted below rather than deleted, so the contract change is
// visible in the diff instead of silently disappearing.
func TestAPIBuildRequestURL(t *testing.T) {
	cases := []struct {
		name    string
		baseURL string
		raw     string
		want    string
	}{
		{"bare query string appends to base", "http://host:21082/data", "?limit=1000", "http://host:21082/data?limit=1000"},
		{"bare query string merges with existing", "http://host:21082/data?a=1", "?limit=1000", "http://host:21082/data?a=1&limit=1000"},
		{"empty raw uses base verbatim", "http://host:21082/data", "", "http://host:21082/data"},
		{"leading slash appends to base path", "http://host:21082/data", "/other", "http://host:21082/data/other"},
		{"absolute url on the same host is allowed", "http://host:21082/data", "http://host:21082/x", "http://host:21082/x"},
		{"path segment appends", "http://host:21082/data", "more", "http://host:21082/data/more"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			a := &APIDataSource{config: &models.APIConfig{URL: tc.baseURL, Method: "GET"}}
			req, err := a.buildRequest(context.Background(), models.Query{Raw: tc.raw})
			if err != nil {
				t.Fatalf("buildRequest error: %v", err)
			}
			if got := req.URL.String(); got != tc.want {
				t.Errorf("URL = %q, want %q", got, tc.want)
			}
		})
	}
}

// TestAPIBuildRequestRefusesCrossHost is the #287 regression at the
// buildRequest layer: resolveAPIURL has its own unit tests, but this asserts
// the refusal actually reaches the request builder — that no caller of
// buildRequest can end up with a request aimed off-host, credentials attached.
func TestAPIBuildRequestRefusesCrossHost(t *testing.T) {
	a := &APIDataSource{config: &models.APIConfig{
		URL:             "http://host:21082/data",
		Method:          "GET",
		AuthType:        "bearer",
		AuthCredentials: map[string]string{"token": "SECRET"},
	}}
	req, err := a.buildRequest(context.Background(), models.Query{Raw: "http://elsewhere/steal"})
	if err == nil {
		t.Fatalf("cross-host raw was accepted; request aimed at %s", req.URL)
	}
	if req != nil {
		t.Errorf("expected no request on refusal, got one for %s", req.URL)
	}
}

// TestAPIBuildRequestSkipsReservedParams locks the fix for the Proxmox 400
// ("Parameter verification failed"): dashboard-internal reserved keys —
// group_by (derived server-side from data_mapping.series for EVERY component),
// range, dashboard_variable — must never reach the upstream URL. Strict APIs
// reject unknown params; only author-supplied params belong on the wire.
// Covers both adapter copies.
func TestAPIBuildRequestSkipsReservedParams(t *testing.T) {
	params := map[string]interface{}{
		"group_by":           "name",
		"range":              map[string]interface{}{"type": "relative", "token": "1h"},
		"dashboard_variable": "web-01",
		"limit":              1000, // author-supplied — must survive
	}

	t.Run("legacy APIDataSource", func(t *testing.T) {
		a := &APIDataSource{config: &models.APIConfig{URL: "http://host/api", Method: "GET"}}
		req, err := a.buildRequest(context.Background(), models.Query{Raw: "/", Params: params})
		if err != nil {
			t.Fatalf("buildRequest error: %v", err)
		}
		q := req.URL.Query()
		for _, reserved := range []string{"group_by", "range", "dashboard_variable"} {
			if _, present := q[reserved]; present {
				t.Errorf("reserved param %q leaked onto the URL: %s", reserved, req.URL)
			}
		}
		if q.Get("limit") != "1000" {
			t.Errorf("author param limit missing: %s", req.URL)
		}
	})

	t.Run("registry APIAdapter", func(t *testing.T) {
		a := &APIAdapter{config: &models.APIConfig{URL: "http://host/api", Method: "GET"}}
		req, err := a.buildRequest(context.Background(), registry.Query{Raw: "/", Params: params})
		if err != nil {
			t.Fatalf("buildRequest error: %v", err)
		}
		q := req.URL.Query()
		for _, reserved := range []string{"group_by", "range", "dashboard_variable"} {
			if _, present := q[reserved]; present {
				t.Errorf("reserved param %q leaked onto the URL: %s", reserved, req.URL)
			}
		}
		if q.Get("limit") != "1000" {
			t.Errorf("author param limit missing: %s", req.URL)
		}
	})
}
