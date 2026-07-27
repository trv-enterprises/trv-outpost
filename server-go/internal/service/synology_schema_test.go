// Copyright (c) 2026 TRV Enterprises LLC
// Licensed under Apache 2.0
// See LICENSE file for details.

package service

import (
	"testing"

	"github.com/trv-enterprises/trve-dashboard/internal/models"
)

// TestInferColumnsFromResultSet locks in the type-tagging rules shared by the
// ts-store and Synology sample-and-infer schema paths. The type comes from the
// FIRST non-null cell in each column — nulls are skipped, not treated as a
// type, so a column whose first row is null still types off a later row.
func TestInferColumnsFromResultSet(t *testing.T) {
	rs := &models.ResultSet{
		Columns: []string{"str", "num", "boolcol", "nested", "allnull", "late"},
		Rows: [][]interface{}{
			{"running", float64(41), true, map[string]interface{}{"a": 1}, nil, nil},
			{"stopped", float64(39), false, map[string]interface{}{"b": 2}, nil, "found"},
		},
	}

	got := inferColumnsFromResultSet(rs)
	if len(got) != len(rs.Columns) {
		t.Fatalf("got %d columns, want %d", len(got), len(rs.Columns))
	}

	want := map[string]string{
		"str":     "string",
		"num":     "number",
		"boolcol": "boolean",
		"nested":  "object",
		"allnull": "unknown", // never a non-null cell → stays unknown
		"late":    "string",  // first cell null, types off row 2
	}
	for _, c := range got {
		if w := want[c.Name]; c.Type != w {
			t.Errorf("column %q typed %q, want %q", c.Name, c.Type, w)
		}
		if !c.Nullable {
			t.Errorf("column %q should be Nullable (inferred schemas cannot prove otherwise)", c.Name)
		}
	}
}

// TestInferColumnsIntegerVariants — DSM returns ints for some fields
// (status_code, temp) and the JSON decoder may hand back int or float64
// depending on path. Both must type as "number", never "object".
func TestInferColumnsIntegerVariants(t *testing.T) {
	rs := &models.ResultSet{
		Columns: []string{"f64", "i", "i64", "u"},
		Rows:    [][]interface{}{{float64(1), int(2), int64(3), uint(4)}},
	}
	for _, c := range inferColumnsFromResultSet(rs) {
		if c.Type != "number" {
			t.Errorf("column %q typed %q, want number", c.Name, c.Type)
		}
	}
}

// TestInferColumnsEmptyResultSet — a probe that returns no rows must yield
// columns typed "unknown" rather than panicking on the empty Rows slice.
func TestInferColumnsEmptyResultSet(t *testing.T) {
	rs := &models.ResultSet{Columns: []string{"a", "b"}, Rows: [][]interface{}{}}
	got := inferColumnsFromResultSet(rs)
	if len(got) != 2 {
		t.Fatalf("got %d columns, want 2", len(got))
	}
	for _, c := range got {
		if c.Type != "unknown" {
			t.Errorf("column %q typed %q, want unknown", c.Name, c.Type)
		}
	}
}

// TestInferColumnsShortRow — rows shorter than the column list must not panic
// (defensive: a malformed adapter response shouldn't take the schema call down).
func TestInferColumnsShortRow(t *testing.T) {
	rs := &models.ResultSet{
		Columns: []string{"a", "b", "c"},
		Rows:    [][]interface{}{{"x"}}, // only 1 cell for 3 columns
	}
	got := inferColumnsFromResultSet(rs)
	if len(got) != 3 {
		t.Fatalf("got %d columns, want 3", len(got))
	}
	if got[0].Type != "string" {
		t.Errorf("column a typed %q, want string", got[0].Type)
	}
	for _, c := range got[1:] {
		if c.Type != "unknown" {
			t.Errorf("column %q typed %q, want unknown (no cell present)", c.Name, c.Type)
		}
	}
}

// TestSynologySchemaProbesAreWellFormed guards the probe table itself. These
// are the exact API/method/version triples verified against DSM 7.3.2; a typo
// here silently drops a table from every Synology schema response.
func TestSynologySchemaProbesAreWellFormed(t *testing.T) {
	if len(synologySchemaProbes) == 0 {
		t.Fatal("no Synology schema probes defined")
	}

	seenTable := map[string]bool{}
	for _, p := range synologySchemaProbes {
		if p.Table == "" {
			t.Errorf("probe for %s has no table name", p.API)
		}
		if seenTable[p.Table] {
			t.Errorf("duplicate table name %q — tables would collide in the response", p.Table)
		}
		seenTable[p.Table] = true

		if p.API == "" {
			t.Errorf("probe %q has no API name", p.Table)
		}
		if p.Method == "" {
			t.Errorf("probe %q has no method — DSM requires one", p.Table)
		}
		if p.Version < 1 {
			t.Errorf("probe %q has version %d, must be >= 1", p.Table, p.Version)
		}
	}
}

// TestSynologyProbeVersionsMatchDSM pins the API/method/version combinations
// that were verified live. These are NOT interchangeable:
//   - SYNO.Core.Service answers `get` on v3; `list` returns error 103.
//   - SYNO.Core.Package needs additional=["status",...] or every status is
//     null — and status_code/status_description/status_origin ride along and
//     must NOT be requested explicitly (DSM rejects them with error 120).
func TestSynologyProbeVersionsMatchDSM(t *testing.T) {
	byAPI := map[string]struct {
		Version int
		Method  string
	}{}
	for _, p := range synologySchemaProbes {
		byAPI[p.API] = struct {
			Version int
			Method  string
		}{p.Version, p.Method}
	}

	cases := []struct {
		api     string
		version int
		method  string
	}{
		{"SYNO.Core.System.Utilization", 1, "get"},
		{"SYNO.Core.System", 1, "info"},
		{"SYNO.Storage.CGI.Storage", 1, "load_info"},
		{"SYNO.Core.Service", 3, "get"},
		{"SYNO.Core.Package", 2, "list"},
	}
	for _, c := range cases {
		got, ok := byAPI[c.api]
		if !ok {
			t.Errorf("probe for %s missing", c.api)
			continue
		}
		if got.Version != c.version {
			t.Errorf("%s version = %d, want %d", c.api, got.Version, c.version)
		}
		if got.Method != c.method {
			t.Errorf("%s method = %q, want %q", c.api, got.Method, c.method)
		}
	}
}

// TestSynologyPackageProbeRequestsAdditional — without additional=["status"]
// DSM returns a null status for every package, which silently produces a
// useless "packages" table. Guard the one probe that needs it.
func TestSynologyPackageProbeRequestsAdditional(t *testing.T) {
	for _, p := range synologySchemaProbes {
		if p.API != "SYNO.Core.Package" {
			continue
		}
		if p.Additional == "" {
			t.Fatal("the SYNO.Core.Package probe must request additional=[\"status\",...] or every status comes back null")
		}
		// status_code / status_description / status_origin are returned
		// alongside `status` but are NOT valid request keys — DSM answers 120.
		for _, invalid := range []string{"status_code", "status_origin", "status_description"} {
			if containsSub(p.Additional, invalid) {
				t.Errorf("additional must not request %q — DSM rejects it with error 120 (it rides along with \"status\")", invalid)
			}
		}
		return
	}
	t.Fatal("no SYNO.Core.Package probe found")
}

func containsSub(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
