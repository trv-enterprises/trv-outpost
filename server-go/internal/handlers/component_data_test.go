// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package handlers

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// buildComponentDataQuery (#23) must run the STORED query with only the
// reserved runtime keys merged from the request — the caller can never
// override the query text or its stored params.
func TestBuildComponentDataQuery(t *testing.T) {
	base := func() *models.Component {
		return &models.Component{
			ID:           "comp-1",
			ConnectionID: "conn-1",
			QueryConfig: &models.ChartQueryConfig{
				Raw:  "SELECT ts, value FROM metrics WHERE loc = {{dashboard-variable}} AND ts {{range-variable}}",
				Type: "sql",
				Params: map[string]interface{}{
					"limit": 100,
				},
			},
		}
	}

	t.Run("stored query and params pass through untouched", func(t *testing.T) {
		q, err := buildComponentDataQuery(base(), &models.ComponentDataRequest{})
		if err != nil {
			t.Fatal(err)
		}
		if q.Raw != base().QueryConfig.Raw {
			t.Errorf("Raw = %q, want stored raw", q.Raw)
		}
		if q.Type != models.QueryType("sql") {
			t.Errorf("Type = %q, want sql", q.Type)
		}
		if q.Params["limit"] != 100 {
			t.Errorf("stored param limit = %v, want 100", q.Params["limit"])
		}
		if _, ok := q.Params["dashboard_variable"]; ok {
			t.Error("dashboard_variable must be absent when not supplied")
		}
		if _, ok := q.Params["range"]; ok {
			t.Error("range must be absent when not supplied")
		}
	})

	t.Run("reserved runtime keys merge in", func(t *testing.T) {
		req := &models.ComponentDataRequest{
			DashboardVariable: "PI",
			Range:             map[string]interface{}{"type": "relative", "token": "1h"},
		}
		q, err := buildComponentDataQuery(base(), req)
		if err != nil {
			t.Fatal(err)
		}
		if q.Params["dashboard_variable"] != "PI" {
			t.Errorf("dashboard_variable = %v, want PI", q.Params["dashboard_variable"])
		}
		r, _ := q.Params["range"].(map[string]interface{})
		if r == nil || r["token"] != "1h" {
			t.Errorf("range = %v, want relative 1h", q.Params["range"])
		}
	})

	t.Run("explicit empty variable value is preserved", func(t *testing.T) {
		// "" is meaningful: token present but no value set → the server
		// returns its structured variable-not-set response.
		q, err := buildComponentDataQuery(base(), &models.ComponentDataRequest{DashboardVariable: ""})
		if err != nil {
			t.Fatal(err)
		}
		v, ok := q.Params["dashboard_variable"]
		if !ok || v != "" {
			t.Errorf("dashboard_variable = %v (present=%v), want empty string present", v, ok)
		}
	})

	t.Run("stored params cannot be clobbered by merge", func(t *testing.T) {
		c := base()
		c.QueryConfig.Params["dashboard_variable"] = "stored-default"
		q, err := buildComponentDataQuery(c, &models.ComponentDataRequest{DashboardVariable: "runtime"})
		if err != nil {
			t.Fatal(err)
		}
		// Runtime value wins for the RESERVED key (that's its purpose)…
		if q.Params["dashboard_variable"] != "runtime" {
			t.Errorf("dashboard_variable = %v, want runtime", q.Params["dashboard_variable"])
		}
		// …but the stored map itself must not be mutated (components are
		// served from a repo; the merge must work on a copy).
		if c.QueryConfig.Params["dashboard_variable"] != "stored-default" {
			t.Error("stored QueryConfig.Params was mutated by the merge")
		}
	})

	t.Run("component without stored query is rejected", func(t *testing.T) {
		c := base()
		c.QueryConfig = nil
		if _, err := buildComponentDataQuery(c, &models.ComponentDataRequest{}); err == nil {
			t.Error("expected error for nil QueryConfig")
		}
		c = base()
		c.QueryConfig.Raw = ""
		if _, err := buildComponentDataQuery(c, &models.ComponentDataRequest{}); err == nil {
			t.Error("expected error for empty stored raw")
		}
	})
}
