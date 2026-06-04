// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package connection

import (
	"context"
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TestAPIBuildRequestURL covers how query.Raw combines with the connection's
// base URL: a bare query string (?k=v) appends to the base preserving its path;
// a leading-slash path replaces the path; an absolute URL overrides; anything
// else is a path segment. The bare-query-string case is the regression that
// 404'd ("?limit=1000" was treated as a path segment → base + "/?limit=1000").
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
		{"absolute url overrides", "http://host:21082/data", "http://elsewhere/x", "http://elsewhere/x"},
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
