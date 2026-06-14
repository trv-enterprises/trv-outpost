// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package chat

import (
	"strings"
	"testing"
)

// A stored query_connection result must summarize with its COLUMNS, ROW COUNT,
// and a sample row — so the agent learns the shape without probing it with
// several get_full_result calls (issue #69).
func TestBuildSummary_QueryResultShape(t *testing.T) {
	raw := `{"success":true,"result_set":{` +
		`"columns":["timestamp","temp.cpu_package_c","temp.nvme_c"],` +
		`"rows":[[1780604070,47,38.9],[1780604130,48,39.0]]}}`
	s := buildSummary("query_connection", "r_test1234", raw)

	for _, want := range []string{
		"2 row(s)", "3 column(s)",
		"temp.cpu_package_c", "temp.nvme_c", "timestamp",
		"Sample row", "r_test1234",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("query-result summary missing %q\n--- got ---\n%s", want, s)
		}
	}
	// Must NOT fall through to the generic "large JSON object with keys" branch.
	if strings.Contains(s, "large JSON object with keys") {
		t.Errorf("query result hit the generic object branch instead of the table summary:\n%s", s)
	}
}

// The bare {columns,rows} shape (no result_set wrapper) is handled too.
func TestBuildSummary_BareColumnsRows(t *testing.T) {
	raw := `{"columns":["a","b"],"rows":[[1,2],[3,4],[5,6]]}`
	s := buildSummary("query_connection", "r_bare", raw)
	if !strings.Contains(s, "3 row(s)") || !strings.Contains(s, "2 column(s)") {
		t.Errorf("bare columns/rows not summarized as a table:\n%s", s)
	}
}
