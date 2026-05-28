// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"strings"
	"testing"
)

// Step 14.5b — verifies the enriched list summary includes
// per-entry name+id+type+hint, so the model can find a specific
// item by name without falling through to get_full_result.

func TestBuildSummary_ConnectionListIncludesPerEntryDetail(t *testing.T) {
	raw := `{
		"connections": [
			{"id": "abc1", "name": "Proxmox trv-srv-002", "type": "api", "description": "Proxmox VE cluster API (self-signed cert)", "tags": ["infra", "proxmox"]},
			{"id": "abc2", "name": "Lab Controls (Postgres)", "type": "sql", "tags": ["sql", "lab-control"]},
			{"id": "abc3", "name": "TS-STORE API - PI senshat", "type": "tsstore", "tags": ["api", "pi", "ts-store"]}
		],
		"count": 3
	}`
	got := buildSummary("list_connections", "r_test123", raw)

	checks := []string{
		`list_connections returned 3 connections`,
		`"Proxmox trv-srv-002"`,
		`id=abc1`,
		`type=api`,
		`Proxmox VE cluster API (self-signed cert)`, // description hint
		`"Lab Controls (Postgres)"`,
		`tags=sql,lab-control`, // tag hint when no description
		`"TS-STORE API - PI senshat"`,
		`id=abc3`,
		`type=tsstore`,
		`tags=api,pi,ts-store`,
		`r_test123`, // result_id still available
	}
	for _, want := range checks {
		if !strings.Contains(got, want) {
			t.Errorf("expected summary to contain %q.\nFull summary:\n%s", want, got)
		}
	}
}

func TestBuildSummary_ListTruncatedAfterCap(t *testing.T) {
	// Build a list larger than the cap.
	rawItems := make([]string, 0, SummaryItemCap+5)
	for i := 0; i < SummaryItemCap+5; i++ {
		rawItems = append(rawItems, `{"id":"x","name":"item","type":"sql"}`)
	}
	raw := `{"connections":[` + strings.Join(rawItems, ",") + `],"count":` + itoa(SummaryItemCap+5) + `}`
	got := buildSummary("list_connections", "r_big", raw)

	if !strings.Contains(got, "and 5 more entries") {
		t.Errorf("expected truncation hint when over cap; got:\n%s", got)
	}
	// Should still mention get_full_result for the tail.
	if !strings.Contains(got, "get_full_result(\"r_big\")") {
		t.Errorf("expected get_full_result hint in truncation tail; got:\n%s", got)
	}
}

func TestBuildSummary_DashboardsAndComponentsHandled(t *testing.T) {
	raw := `{"dashboards":[{"id":"d1","name":"Home"},{"id":"d2","name":"Lab"}],"count":2}`
	got := buildSummary("list_dashboards", "r_x", raw)
	if !strings.Contains(got, "list_dashboards returned 2 dashboards") {
		t.Errorf("dashboards envelope not summarized: %s", got)
	}
	if !strings.Contains(got, `"Home"`) || !strings.Contains(got, `"Lab"`) {
		t.Errorf("dashboard names missing: %s", got)
	}

	raw = `{"components":[{"id":"c1","name":"Voltage","component_type":"chart","chart_type":"line"}],"count":1}`
	got = buildSummary("list_components", "r_y", raw)
	if !strings.Contains(got, "type=chart") {
		t.Errorf("component type not surfaced: %s", got)
	}
}

func TestBuildSummary_NonListObjectStillCovered(t *testing.T) {
	// Single connection (not a list shape) — falls into the
	// "object with keys" branch.
	raw := `{"id":"abc","name":"single","config":{"host":"h"},"health":{"status":"healthy"}}`
	got := buildSummary("get_connection", "r_obj", raw)
	if !strings.Contains(got, "large JSON object") {
		t.Errorf("expected object-keys summary; got:\n%s", got)
	}
}

// itoa: tiny helper so we don't drag in fmt or strconv for one call.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		return "-" + string(digits)
	}
	return string(digits)
}
